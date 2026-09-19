# Aldine public demo box

A throwaway ~€4/mo Hetzner server that runs the full Aldine stack with **auth
off** and a **nightly wipe** (volumes destroyed at 04:00 UTC). Point launch
traffic at it; keep nothing on it.

## Bring it up

```bash
cd deploy/demo
export HCLOUD_TOKEN=...          # Hetzner Cloud API token (create in the console)
terraform init
terraform apply -var demo_domain=demo.aldine.example.com
# → prints the server IP
```

Then create an **A record** for `demo_domain` pointing at that IP. Caddy
provisions the TLS certificate automatically on first request. The first boot
builds the TeX Live image on the box, so allow ~20–30 minutes before the demo
responds (`curl https://<demo_domain>/api/health`).

Note: the box clones the repo anonymously, so the repo must be **public**
before `terraform apply` (or pass `-var repo_url=` pointing at a mirror).

## Launch-day hardening

The generated `.env.demo` caps every visitor at 6 typesets per minute
(`ALDINE_COMPILE_PER_MIN`), so one person cannot starve the compiler for
everyone else. To also keep a showcase paper alive on a world-writable demo:

1. Bring the box up and create the showcase project (ZIP or GitHub import);
   note its id from the URL.
2. Re-apply with `-var protected_projects=<id>`. The app serves that project
   read-only: anyone can open and typeset it, nobody can edit, rename, or
   delete it (enforced on both the HTTP API and the collab socket).

The nightly wipe destroys the data volumes — and with them the showcase project
and its id — so re-seed each morning. Do not disable the wipe timer, launch
week included: docs/AGENT_API.md, `site/llms.txt` and the changelog promise
strangers that the demo is wiped nightly at 04:00 UTC, and with the connector
token published (below) that wipe is the only cleanup the box has.

The wipe also pulls `main` and rebuilds the images, so the demo tracks the
repository without anyone logging in; a box provisioned before this ran a
fixed commit until someone did. To update a box by hand (or right after a
fix lands), run the wipe unit: `systemctl start aldine-demo-wipe.service`.

The wipe deliberately keeps `aldine_caddy-data`. Let's Encrypt issues at most 5
certificates per week for the same hostname, so a wipe that took the certificate
store with it would put the demo behind an unreachable TLS handshake for hours
on the fifth day — which is exactly what happened once. A box created before
this fix still carries the old unit; check it with
`grep ExecStart /etc/systemd/system/aldine-demo-wipe.service` and look for
`down -v`.

## Trial connector

The box also serves the [Agent API](../../docs/AGENT_API.md) so people can
try Claude against Aldine without installing anything: `.env.demo` sets
`ALDINE_MCP=1` and `ALDINE_MCP_TOKEN` to the `mcp_token` variable, whose
default `aldine-demo` is **published** in docs/AGENT_API.md ("Try it on the
demo") — change the two together, or pass `-var mcp_token=` and accept that
the docs no longer match. The token is a courtesy handle, not a secret: with
auth off it has no scope, every connector user acts as the one instance
operator, and the nightly wipe is the only cleanup. Typeset budgets
(`ALDINE_COMPILE_PER_MIN`) and the one-agent-typeset gate are keyed by client
address when there is no account, so connector users get one each, like
browser visitors (`TRUST_PROXY=1` in the prod overlay makes the address the
real one behind Caddy). `ALDINE_SIGNING_SECRET` stays
unset on purpose: the app generates it into the secrets volume, so PDF links
die with the data at the wipe. `.env.demo` itself is not wiped, so the token
survives every night.

A box provisioned before this change has neither line in
`/opt/aldine/.env.demo`, and `terraform apply` will not deliver them
(`ignore_changes = [user_data]` in main.tf, for the reasons given there).
Append `ALDINE_MCP=1` and `ALDINE_MCP_TOKEN=aldine-demo` by hand, then run the
wipe unit (`systemctl start aldine-demo-wipe.service`) — after the Agent API
has landed on `main`, because the unit pulls `main` and a build without it
ignores both lines. Until
`curl -s -o /dev/null -w '%{http_code}' -X POST https://demo.aldine.dev/mcp -d '{}'`
prints `401` (a box without the Agent API prints `200`: the SPA answers), the
present-tense "Try it on the demo" claims in docs/AGENT_API.md, `site/llms.txt`,
the landing page and the changelog are false; that check is the gate before
publishing them.

## Tear it down

```bash
terraform destroy
```

That's the whole lifecycle. If launch traffic melts the default cx23
(2 vCPU / 4 GB), bump `-var server_type=cx33` (4 vCPU / 8 GB) and re-apply. The
wipe timer makes the box stateless by design, so resizing costs nothing but the
rebuild.

Note that this is deliberately below the 8 GB the [single-VPS
runbook](../README.md) asks for: it is a demo with auth off and a nightly wipe,
not a place to keep work.
