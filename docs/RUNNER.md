# The runner (experimental preview)

The runner runs one command, such as `python analysis/plot.py`, on a
throwaway copy of a project and brings the files it made or changed back into
the project. It exists for the loop of changing a plot script, regenerating
the figure, typesetting and looking again, without a round trip through
git and CI (issue #349).

It is an **experimental preview**. It is off by default. It is not covered
by the 1.x stability promise. It may change, or be removed, in any release.

This document is the design note and threat model. Every point of it is a
requirement for the code, and the security review checks the code against it.

## What a run does

1. A signed-in person who is allowed to use the runner types a command
   in the Runner panel and presses Run.
2. The server writes pending typing to disk, so the run starts from the
   files as they are.
3. The server reads the branch's files from disk (not `.git`, not
   `.aldine-out`) and sends them, with the command, to the runner.
4. The runner writes them into an empty folder, runs the command there under
   its limits, then kills every process the job started or left behind.
5. Only then does it collect the files the command created or changed, and
   answer with the log, the exit status and those files. It empties its
   folders before it takes the next job.
6. The server checks every returned file again (rules below). It writes the
   files that pass into the project; the next autosave commits them.
   Files that do not pass are listed in the panel with the reason.

Deleting a file in the job does not delete it in the project. A run that
changes nothing writes nothing.

## Decisions

**D1. The whole runner container has no network.** It runs with
`network_mode: none`. The server talks to it over a Unix socket in a small
`tmpfs` volume (1 MB) that only the app and the runner mount. Nothing in
the container, neither the job nor the runner's own control process, can
open a connection to the internet, to the app, to the compiler or to any
other container.

The plan considered a nested sandbox (bubblewrap or nsjail) to take the
network away from the job only. Both need user namespaces. Docker's default
seccomp profile refuses those to a container without `CAP_SYS_ADMIN`, so a
nested sandbox would need a custom or unconfined seccomp profile, which
weakens D5. Taking the network away from the whole container is simpler
and stronger.

**D2. The runner mounts no data.** It sees no project volume, no
`META_DIR`, no secrets and no Docker socket. The files of one job arrive in
the request and leave in the response. The server never gets the Docker
socket either.

**D3. The server trusts nothing the runner returns.** Any job may be
hostile, and a hostile job may take over the runner's control process. The
server therefore validates every path, type, size and count in the answer
as if it came from the job itself. The runner applies the same rules first,
so an honest runner returns only files that pass.

**D4. One job at a time on the instance.** The server keeps a queue (five
waiting jobs at most), one job per project at a time, and a rate limit per
person. Only one job is ever inside the runner, so no job can see another
job's files while both run.

**D5. Two users, and container hardening.** The control process and the
job never share a user. The control process runs as user 0 inside the
container with every capability dropped except `SETUID` and `SETGID`,
which it needs to start processes as the job user. Every job, and every
step that touches job files (unpacking, killing, collecting, emptying),
runs as the unprivileged job user (uid 10101, no capabilities, no
supplementary groups). Uid 10101 is used by neither the app nor the
compiler. A job therefore cannot signal, trace or read the control
process, and cannot change its socket.

The compose overlay also sets: read-only root filesystem,
`no-new-privileges`, Docker's default seccomp profile, a memory limit, a
process limit, `init: true`, and a size for `/dev/shm`. The writable places
are `/work` (a `tmpfs` owned by the job user, `noexec,nosuid,nodev`, with a
size limit), `/dev/shm`, `/dev/mqueue` and the socket folder, which the job
user can read but not write. `noexec` is a speed bump, not a boundary:
Python runs whatever it is given.

At start the control process checks its own container and refuses every
job, saying why, unless all of these hold: it runs as user 0 with only
`SETUID` and `SETGID` in its bounding set; it is not the container's init;
`no-new-privileges` is set; a seccomp filter is active and the job user
cannot create a user namespace; the only network interface is `lo`; there
is a memory, a process and a CPU limit; `/work` is a `tmpfs` owned by the
job user; the root filesystem is read-only. The insecure development mode
(`RUNNER_INSECURE_DEV=1`, for tests on a workstation) reports itself in its
health answer and never runs as user 0. A misconfigured container thus cannot run
jobs. The app refuses results marked insecure; that catches an honest
development runner, not a hostile one, which could claim anything (the
socket is the boundary that matters, D3).

gVisor is not supported in the preview: it does not pass host Unix sockets
through by default, and the combination is untested.

**D6. Nothing survives a job.** After the command ends or times out, in
this order:

1. The control process itself sends `SIGKILL` to every process of the job
   user: it switches its effective user to the job user, calls `kill(-1)`
   and switches back. Linux does this under one lock, so no process forks
   its way out, and stopped processes die too. The control process and the
   container's init are not hit. No separate helper does this, because a
   job process could kill a helper while it starts. The control process
   then reads `/proc`: if any job process is still there, it exits, and the
   container restarts with fresh `tmpfs` mounts.
2. Only now, with no job process alive, a helper running as the job user
   collects the output (D8). Nothing can change the files while they are
   read, and no job process exists to interfere with the helper.
3. After the answer, the control process kills again, and a helper running
   as the job user empties `/work` (with `rm`, which handles any depth),
   `/dev/shm` and `/dev/mqueue`, and removes the user's System V shared
   memory, queues and semaphores (`ipcrm --all`). The control process
   checks that `/work` is empty. A failed or incomplete wipe ends the
   control process, so the container restarts. The next job is accepted
   only after a clean wipe.

While a job runs, the control process accepts no other connection, so a
job that connects to the socket only learns that the runner is busy. The
job starts with an empty environment plus a fixed list: `PATH`, `LANG`,
and `HOME`, `TMPDIR`, `MPLCONFIGDIR`, `XDG_CACHE_HOME` and `TEXMFVAR`
pointing into `/work`, `MPLBACKEND=Agg`, `PYTHONDONTWRITEBYTECODE=1`.

**D7. Limits per job.** Wall-clock timeout (default 120 s, at most 600 s);
CPU time, file size, open files and core dumps limited with `prlimit`;
memory, processes and CPU limited for the whole container (1 GB without
swap, 128 processes, one core); the job folder limited by the `tmpfs` size (default 512 MB).
Input: at most 2,000 files and 64 MB. Output: at most 50 files, 32 MB per
file and 64 MB together. The log keeps its first and last parts, 200 KB
in total.

The app protects itself in the same way. It sends files one by one as a
stream, reading them asynchronously, and reads the answer as a stream of
length-prefixed frames. It stops reading at the output limit plus a small
margin. It gives up after the job's timeout plus four and a half minutes (the
runner's own step deadlines and the upload) and then treats the runner as
dead. A hostile or broken runner therefore cannot make the
app hold more than about 150 MB (the copy it sent and the answer, at
once) or wait forever. Before every connection the
app checks that the socket path is a socket and not a symbolic link.

**D8. What comes back.** A file comes back only if all of these hold, in
the runner and again in the server:

- it is a regular file reached without following a symbolic link: no
  symbolic links, no hard links (link count 1), no devices, pipes or sockets;
- it is opened without following links (`O_NOFOLLOW`), and the type, size
  and link count come from the open descriptor, not from the name;
- its path is relative, normalised, without `..`, and no segment starts
  with `.` (so nothing under `.git`, `.aldine-out`, and no `.latexmkrc` or
  `.gitattributes`) or is `__pycache__`, and no segment starts with `-`;
- its path is valid UTF-8 in NFC form, has no control characters, no
  bidirectional or other invisible formatting characters (so `\u200c.git`
  is refused), no `\` and no `:`, and fits the length limits of the
  ordinary file routes;
- it is not both a file and a folder, among the returned files or against
  the project;
- its content differs from what the app itself sent, or it is new (the
  app compares against its own record of the input, never the runner's
  claim);
- it does not collide, ignoring case and Unicode normalisation, with a
  different existing path or another returned file;
- it was not changed, created, deleted or renamed in Aldine while the job
  ran (such a file is not written; the panel says so);
- it fits the owner's storage quota.

The app writes files the way a save from the editor does: pending typing
is flushed first, the check against the input is made after the flush,
and nothing is awaited between the check and the write, so an open
document is refreshed and never duplicated.

Before writing, the app checks again that the person may still run in
the project and that the branch still exists: jobs can wait in the queue.

**D9. No commit of its own (changed 2026-11-22).** Files that pass are
written like a save from the editor and reach history with the next
autosave, together with whatever else was typed. A run used to land as one
commit with the command in its message; in use that filled the history with
one commit per run, so it was removed. The run no longer has a recorded
origin in git; the panel shows what it wrote.

**D10. Who may run.** All of these are required:

- the instance turns the runner on (`ALDINE_RUNNER_SOCKET`) and sign-in is
  on (`AUTH_ENABLED`); without sign-in there is no person to allow, so the
  runner stays off;
- the person's address is confirmed and, compared without case, is on
  `ALDINE_RUNNER_USERS`;
- the request comes from a browser session and carries no `Authorization`
  header at all, so no assistant and no script using the API can start a
  run, and the assistant door has no runner tool;
- the project has an owner, and the person is that owner or a collaborator
  named in the project whose own role is edit. Edit rights that come from a
  share link do not count. No guest, no link visitor, no reviewer or viewer;
- the request is JSON (`Content-Type: application/json`) and, when the
  browser sends an `Origin`, it is the instance's own;
- the browser has the experimental flag on (`aldine.experimental.runner`,
  from the command palette). This is the third switch, not a security
  boundary.

**D11. The image.** One image, `aldine-runner`: Node.js for the control
process, Python 3 with NumPy and Matplotlib, and the TeX Live parts
Matplotlib's PGF output needs. The base image is pinned by digest and the
Python packages by version and hash (`pip --require-hashes`). The TeX Live
parts come from Debian's packages for the pinned base and are not pinned
further. It is built and published with every release,
like the app and the compiler. There is no package install at run time and
no network to do one.

## Threat model

Assume the command and every file in the project are hostile. A listed
person may run a script that a co-author, an assistant or a downloaded
dataset changed; the runner does not try to tell who wrote the code, it
contains whatever runs.

| Threat | What stops it | What remains |
|---|---|---|
| Escape from the container to the host | The job runs as an unprivileged user without capabilities; `no-new-privileges`, default seccomp, read-only root, no Docker socket, no mounted data | A Linux kernel exploit reachable through the default seccomp profile. Hosts that cannot accept this risk keep the runner off |
| Reading other projects or secrets | No data or secret volume (D2); one job at a time (D4); nothing survives a job (D6) | None known |
| Reading or changing the next job | D4 and D6: the control process kills every job process itself and checks none survived; the folders are emptied and checked; any failure restarts the container | A kernel bug in the guarantees D6 relies on |
| Network abuse: exfiltration, spam, attacks on other hosts, the app or the compiler | No network in the container (D1) | None known |
| Using the CPU (mining) or memory | Timeout, CPU time, memory and process limits; one job at a time; rate limit per person; listed people only | A listed person can keep one CPU busy within the limits |
| Denial of service on the instance | Limits (D7); the queue (D4); the runner is a separate container, so its failure does not stop editing or typesetting | A listed person can keep the runner busy for others; jobs wait in the queue |
| Harmful files coming back: path escape, symbolic links, git hooks or config, rc files, huge files, many files | D8, checked twice; quota | A job can still change any ordinary file of that project, as the person could. History's autosaves keep the earlier version |
| A hostile runner lying to the server | D3: the server validates everything; the version and hash fields have a strict format | A hostile runner can return wrong figures for its own job, as the job itself could |
| Assistants or prompt injection starting a run | No MCP tool; access tokens refused (D10) | An assistant can still change a script that a person later runs. The sandbox, not the review, contains it |
| Other containers or users talking to the runner | Only the app and the runner mount the socket volume | None known |
| Cross-site requests, including from a sibling subdomain | JSON only, and the `Origin` must be the instance's own | None known |
| A hostile log or file name shown in the panel | Shown as plain text, with terminal escape sequences and bidirectional characters removed | None known |
| A hostile job taking over the control process | Another user (D5); one connection at a time; the socket folder is not writable by the job user | A kernel bug that lets a user signal or trace another user's process |

## Turning it on

The runner ships as a separate compose overlay so nobody gets it by
accident:

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.runner.yml up -d
```

and in the app's environment:

```
ALDINE_RUNNER_USERS=you@example.org
```

The overlay sets `ALDINE_RUNNER_SOCKET` for the app. Then, in a browser,
open the command palette and choose **Enable experimental runner**.

Settings, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `ALDINE_RUNNER_TIMEOUT_S` | 120 | Wall-clock limit per job, at most 600 |
| `RL_RUNNER_BURST` | 30 | Runs a person may start in a row |
| `RL_RUNNER_REFILL_PER_MIN` | 3 | How fast that allowance comes back |

The container's memory, process and work-folder limits are in the overlay.

## Review of this note

An independent security review of the first version of this note (before
any code) found eleven problems. All of them are fixed above:

1. Critical: the job ran as the same user as the control process, so it
   could stop that process and take over its socket. Fixed by D5.
2. Files were collected while job processes still ran, which left a window
   to swap a file for a link. Fixed by the order in D6 and `O_NOFOLLOW` (D8).
3. The edit-rights helpers counted share links and ownerless projects.
   Fixed in D10.
4. One large JSON message could exhaust the app's memory or block it.
   Fixed by streaming and limits on the app side (D7).
5. A command containing line breaks could forge lines in the commit
   message. Fixed in D9.
6. Path rules were missing Unicode, length, file-and-folder and
   concurrent-change cases, and the write path was unspecified. Fixed in
   D8.
7. gVisor does not pass Unix sockets through by default. Dropped from the
   preview (D5).
8. System V IPC objects survived a job. Fixed in D6.
9. The job user now differs from the app's and the compiler's (D5).
10. `SameSite=Lax` does not stop sibling subdomains. Fixed by the `Origin`
    check (D10).
11. Hashes for Python packages, plain-text display, and an honest name for
    the package hash. Fixed in D9, D11 and the threat table.

## Review of the code

An independent security review of the code found eleven problems. All of
them are fixed:

1. High: a leftover job process could kill the kill helper while it
   started, so a job outlived its run. The control process now kills by
   itself and restarts the container on any survivor (D6).
2. A very deep folder survived the wipe. `rm` now empties it, and the
   result is checked (D6).
3. There was no CPU limit; there is one core now (D7).
4. Only the first direction character was removed from the commit
   subject; such characters now refuse the command (D9).
5. Access and the branch were checked only when the job was queued; they
   are checked again before writing (D8).
6. Case clashes were checked on whole paths only; every folder of the
   path is compared now (D8).
7. Files were read after the input commit, outside the lock; they are read
   under it now.
8. The development mode looked ready; it says so and never runs as user 0.
9. The app gave up before the runner's own deadlines (D7).
10. Release: the runner's promotion is decided by the version, and the
    smoke container is pinned.
11. The self-check now also covers init, the cgroup limits and user
    namespaces.

## Adversarial test of 2026-11-22

A tester attacked the app side as a hostile runner and as odd users
(framing, names, clashes, races, access, write-back into open documents).
Nothing reached outside the project, `.git` or a hidden path, and nothing
crashed. Fixed after it:

1. A run waiting in the queue is checked again when its turn comes; a
   trashed project or a revoked person is no longer sent to the runner.
2. A branch deleted during a run showed the server's file path; the
   person now sees why nothing was written, and unexpected errors go to
   the server log only.
3. The file limit is counted before anything is read, so a huge project
   no longer holds the project's lock (and everyone's autosave) while it
   is read only to be refused.
4. Pressing Run while a run waits no longer uses up the rate limit.
5. The runner's version and package fields must be strings; the log,
   errors and skipped names are stored without escape sequences,
   controls or direction characters, not only shown without them.
6. The panel keeps polling through a dropped connection, says a run is
   gone when the server restarted, and tells an unconfirmed address to
   confirm it.

`ALDINE_RUNNER_USERS`, the socket and the timeout are read when the app
starts: removing someone takes effect with a restart.

A second tester used the runner as the #349 requester would, on the real
container, and reviewed the panel. Changed after it:

1. A file that reached the 32 MB file size limit was cut off by it and
   still written back; it is now left out with that reason. A project
   over the 64 MB input limit is told its largest files.
2. A run can be stopped (Stop: a waiting run leaves the queue; a running
   one is killed and brings nothing back). Any byte the app sends after
   the request's END frame asks the runner to stop, and so does the app
   hanging up (a restart, its deadline): it keeps its side of the
   connection open until the answer, and so does the release smoke.
3. The panel finds the person's current or last run again after a
   reload, in another tab, or when Run says a run is already going.
4. Jobs get `SOURCE_DATE_EPOCH` and `FORCE_SOURCE_DATE`, so an unchanged
   figure PDF comes back byte for byte the same and nothing is written;
   `PIP_NO_INDEX` makes pip fail at once without network.
5. The panel names the environment, explains exit codes 127, 137 and
   153, says when files were written although the command failed, puts
   the error line of a failed run above the log and scrolls the log to
   its end, opens the list of files not brought back when nothing was,
   names the time limit while running, offers the project's only script
   as a suggestion, links written files, and announces only state changes
   to screen readers. Python, R and Julia files show in the source view
   of the file tree.
6. The app logs once at start whether the runner is ready, and why not.
7. A code review of these changes found that since 1.21.2 a job could
   connect to the runner's socket (it is open to the job user, D3) and
   leave a request waiting to run after its own job, without the app's
   checks, and fill the runner's waiting list. Connections now wait only
   between a job's answer and the end of its wipe, when every process of
   that job is gone (D6); any other connection while the runner is busy
   is answered "busy" at once, as before 1.21.2.

Docker Desktop can run containers without any seccomp filter; the runner
then reports NOT READY ("no seccomp filter is active") and refuses jobs,
as it should.

## Out of scope for the preview

A terminal; packages installed at run time; other languages or images;
runs started by assistants; jobs that use the network; streaming the log
while the job runs; Kubernetes manifests; gVisor.
