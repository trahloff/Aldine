# Aldine on TrueNAS

TrueNAS 24.10 (Electric Eel) and later run apps on Docker and can install a
compose file as it is: **Install via YAML**. That is the
route for Aldine. It keeps the compiler's sandbox (no internet, no Linux
capabilities, bounded memory and processes), which the TrueNAS app catalog
cannot express yet (see the end of this page).

## 1. Create the datasets

In **Datasets**, add a dataset `aldine` on your pool and two datasets inside
it: `data` (projects, each a git repository, and the PDF cache) and `secrets`
(accounts, sessions, API keys, comments). Choose the **Generic** dataset
preset for all three. Both containers run as root, and the compiler runs with
every capability dropped, so it can only write where root owns the directory.

The pool is called `tank` below; use your pool's name instead.

## 2. Install

**Apps → Discover Apps → ⋮ (next to Custom App) → Install via YAML.** Name
the app `aldine` and paste:

```yaml
services:
  app:
    image: ghcr.io/trahloff/aldine-app:0.16.0
    ports:
      - "8480:3000"
    volumes:
      - /mnt/tank/aldine/data:/data
      - /mnt/tank/aldine/secrets:/secrets
    environment:
      AUTH_ENABLED: ""
      ALDINE_PUBLIC_URL: ""
    networks:
      - frontend
      - backend
    init: true # reap orphaned git/compile children (node runs as PID 1 otherwise)
    restart: unless-stopped

  compiler:
    image: ghcr.io/trahloff/aldine-compiler:0.16.0
    volumes:
      - /mnt/tank/aldine/data:/data
    # Hardening: no external egress (internal network), drop all Linux caps, no
    # privilege escalation, bounded memory and PIDs. Packages are baked into the
    # image at build time, so the compiler never needs the network. LaTeX
    # processes untrusted input; keep these. (No `cpus:` cap: above the host's
    # core count it makes the container refuse to start.)
    networks:
      - backend
    mem_limit: 2g
    pids_limit: 256
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges
    init: true # reap orphaned pdflatex/biber children left by killed latexmk runs
    restart: unless-stopped

networks:
  frontend: {}
  backend:
    internal: true # the compiler has no route to the internet
```

Save. The first install pulls the compiler image, which carries TeX Live
(about 2.4 GB to download, 5 GB on disk). Then open
`http://<truenas-address>:8480`. If 8480 is taken, change the left side of
`8480:3000`.

To check that the sandbox took, run in **System → Shell**:

```bash
sudo docker ps --format '{{.Names}}' | grep compiler
sudo docker inspect <that name> --format '{{.HostConfig.CapDrop}} {{.HostConfig.PidsLimit}} {{.HostConfig.Memory}}'
```

It prints `[ALL] 256 2147483648`.

## Turn on accounts

Without accounts there is no login, and anyone who can reach the port can open
and edit every project. To require sign-in: **Apps → aldine → Edit**, set
`AUTH_ENABLED: "1"`, and save. Open Aldine and use **Sign up** to create your
account. Sign-up is open to anyone who can reach the port, so keep the app on
your own network or behind a reverse proxy.

Projects you made before have no owner: every signed-in user can open them
until someone presses **Claim** on the project in the list and becomes its
owner. Single sign-on and password-reset email also need `ALDINE_PUBLIC_URL`,
the address people open Aldine at; every other setting is an environment
variable listed in [deploy/README.md](../deploy/README.md#all-configuration).
Add it under `environment:` the same way.

## Upgrade

Read the [CHANGELOG](../CHANGELOG.md), then take a recursive snapshot of
`tank/aldine`. **Apps → aldine → Edit**, change the version at the end of both
`image:` lines to the new release, and save. TrueNAS pulls the new images and
restarts the app. To roll back, set the old version again and roll the
datasets back to the snapshot.

The tag is pinned on purpose: nothing changes under a running install until you
edit it.

## Why not the app catalog

Apps in the TrueNAS catalog (truenas/apps) must be built with its app library,
and the library has no internal (no-egress) network and no PIDs limit. The
compiler runs untrusted LaTeX, so an Aldine catalog app waits until the library
supports both. Install via YAML has no such restriction.
