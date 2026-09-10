# Scaling Aldine

Aldine is built to run two ways from one codebase:

- **Solo / self-host** — one box, `docker compose up`, flat-JSON datastore. The
  default, and the thing you give a colleague to run tonight.
- **Cloud / multi-tenant** — horizontally scalable, Postgres-backed.

The two share all product code (editor, Yjs collaboration, git versioning, the
TeX Live compile pipeline, plugins). Only the **persistence and topology glue**
differs, and it sits behind interfaces so moving between them is configuration
and infrastructure, not a rewrite.

## What's where

| Concern | Storage | Seam |
|---|---|---|
| Project files, branches, history | git repos + worktrees on disk | `store.ts` |
| Users, sessions, reset tokens | DataStore | `db/` (`JsonStore` \| `PgStore`) |
| Project metadata, sharing | DataStore | `db/` |
| Review comments | DataStore | `db/` |
| Rate-limit counters | in-memory per process, or Redis when `REDIS_URL` is set | `ratelimit.ts` |
| Compile-quota counters | DataStore (monthly seconds per user) | `usage.ts` |
| Live collaboration state (Yjs CRDT) | in-process (Hocuspocus) | `collab.ts` |

Switch the datastore with one env var:

```bash
DATABASE_URL=postgres://…    # unset = JSON files
```

## The scaling walls (in the order they bite)

The single-box default tops out at "vertical scale." Past that, four structural
limits appear. They're at the persistence/topology layer — the product core is
unaffected.

1. **Flat-JSON stores + in-memory rate/quota state** — per-process, so two app
   nodes can't share them. *Blocks running more than one app node.*
   → **Done for the datastore:** Postgres (`DATABASE_URL`) covers users,
   sessions, project metadata, comments, and usage/quotas; Redis (`REDIS_URL`)
   shares the rate limiters across nodes. The compile concurrency gate stays
   per-node by design (it protects each node's compiler; the shared ceiling is
   the per-user compile quota).
   **Honest caveat:** several per-process caches survive this migration —
   `lastWritten` (collab write-skip hashes), `tombstoned` (delete guards),
   `lastPushedHead` (remote push dedup — self-healing, benign), the autopush
   debounce/backoff timers (two nodes each push after their own autosave;
   git tolerates the duplicate push — benign), the bib/label index caches,
   and `compileChain` (serializes latexmk per branch; with two nodes sharing
   one volume that serialization is gone and aux-file corruption becomes
   reachable). The datastore is multi-node-ready; these
   caches are not yet.
2. **Single-process Hocuspocus** — each Yjs document's CRDT state lives in one
   process's memory. → **Partially built, not yet a supported topology.** What
   exists: the Redis collab extension (`REDIS_URL`) syncs awareness across
   nodes and hands a document off on failover, and access revocation
   (share changes, delete, claim) fans out over the `aldine:project-events`
   channel so a revoked user's live session ends on every node. What does NOT
   exist: document-affinity routing (the AWS deploy's ALB stickiness is
   client-cookie-based — two collaborators on one project can land on
   different nodes, which dual-seeds the doc), and the flush/refresh/evict
   helpers that run before every compile/commit/merge only see the local
   node's documents. **Until those exist, run one app node.** Splitting collab
   into its own service remains the eventual path.
3. **One shared compiler on one volume** — compiles are the cost driver. → a job
   queue + a fleet of stateless workers, autoscaled, with **per-compile
   isolation** (ephemeral containers / gVisor / Firecracker) for true
   multi-tenancy. The metering hook (`usage.ts`) and concurrency gate already
   anticipate this.
4. **Git-repos-on-local-disk** — the deepest coupling and the one most in
   tension with a stateless tier. → back git with object storage (S3/R2) and
   treat local disk as a cache, or use networked storage.

## Principle

Don't build the 10k-user architecture before the users exist. Do keep the seams
(datastore, rate/session store, collab-service boundary, compile dispatcher) so
each wall becomes "swap the implementation + add the infra" exactly when load
justifies it. The datastore seam (wall 1) is done and the cross-node event
channel (wall 2's revocation piece) exists; the rest are scoped, not built.
**The supported production topology today is one app node** — scale it
vertically first.

## Cost & hosting

Compiles (CPU/RAM bursts) dominate resource usage, so if you host Aldine for a
lab, class, or team, cheap dedicated compute (a Hetzner CCX-class box, EU for
data residency) goes a lot further than hyperscaler instances. If you need to
keep a shared box fair, cap compile-minutes per user
(`ALDINE_COMPILE_QUOTA_MIN`; `/api/usage` reports consumption). See
[../deploy/README.md](../deploy/README.md) for the single-VPS runbook.
