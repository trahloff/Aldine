# Aldine on one Hetzner box

A production setup for a research group: one Hetzner Cloud server (cx23,
2 vCPU, 4 GB, about €7 a month with backups), the released images from GHCR,
Caddy for HTTPS, and two layers of backup. `deploy/demo` is the throwaway
public demo; this stack keeps its data.

| Piece | Where |
|---|---|
| Server, firewall, SSH keys | `main.tf` (OpenTofu or Terraform, `hcloud` provider) |
| First-boot setup (Docker, swap, security updates, backup timer) | `cloud-init.yaml.tftpl` |
| The stack on the box | `compose.yml`, copied to `/opt/aldine/` |
| Settings and secrets | `/opt/aldine/.env`, never in cloud-init |
| Backups | Hetzner daily server backups (7 kept) + `offbox-backup.sh` at 03:30 UTC |

## 1. Create the box

```bash
export HCLOUD_TOKEN=...   # project-scoped API token
tofu init
tofu apply -var 'ssh_public_keys=["~/.ssh/id_ed25519.pub"]'
```

Point an A record for your domain at the `ipv4` output. The server has delete
and rebuild protection on, and `prevent_destroy` in the config: removing it
takes two deliberate steps, because a replaced server is an empty server.

## 2. Write the env file

On your machine, next to nothing public. The keys are the ones in
`deploy/README.md`, plus three the box needs:

```dotenv
ALDINE_VERSION=0.11.0
ALDINE_TEXLIVE=-full              # blank = medium scheme (~1 GB), -full = all of CTAN
ALDINE_DOMAIN=aldine.example.com  # Caddy requests the certificate for this name
ALDINE_PUBLIC_URL=https://aldine.example.com
AUTH_ENABLED=1
# ... SSO, email, Sentry, as in deploy/README.md
```

For off-box backups, a second file with `OFFBOX_S3_URI` and the bucket's
credentials (the header of `offbox-backup.sh` lists the keys). Any
S3-compatible provider works; `deploy/aws/offbox.tf` creates a bucket and a
key that can write backups but not delete them.

## 3. Deploy

```bash
deploy/hetzner/deploy.sh <ip-or-host> aldine.env [offbox.env]
```

It copies the stack files and the env to `/opt/aldine`, pulls the images and
starts the stack, waiting until every container is healthy. To upgrade, change
`ALDINE_VERSION` and run it again. The app is unavailable while its container
restarts, about a minute.

## Moving existing data in

Take a tarball with `deploy/backup.sh` on the old host (or any tar with
top-level `data/` and `secrets/`), copy it to the box, then:

```bash
cd /opt/aldine && docker compose down
./restore.sh /root/aldine-backup.tar.gz
docker compose up -d --wait
```

## Sizing

The compiler is capped at 2 GB (`ALDINE_COMPILER_MEM`) and runs two compiles
at a time (`MAX_CONCURRENT_COMPILES`); a 4 GB swap file takes the peaks. A
group that compiles large documents at the same time wants a cx33 (8 GB):
change `server_type` and resize in the Hetzner console, the disk and data stay.
