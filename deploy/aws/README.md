# Aldine on AWS (serverless, all-IaC)

> **Note:** the app is named **Aldine**; AWS resource names (cluster `papyr`,
> ECR `papyr-server`/`papyr-compiler`, SSM `/papyr/*`) keep the legacy prefix
> to avoid a destroy/recreate of live infrastructure.

Deploys Aldine to `https://latex.example.com` on **AWS Fargate** — no servers
to manage, everything as Terraform. This is the cheapest AWS shape that actually
fits the app; see [Why this architecture](#why-this-architecture-and-not-pure-lambda).

## What gets created

```
Route53  latex.example.com ─(alias)─►  ALB ─► Fargate task ── EFS (/data, /secrets)
ACM      TLS cert (DNS-validated)                     ├─ server  container  (:3000)
                                                       └─ compiler container (:4020, localhost)
ECR      papyr-server, papyr-compiler images
SSM      OAuth/API secrets (SecureString) ─► injected into the server
```

- **One Fargate service, two containers** sharing an EFS filesystem. The compiler
  is reached over `localhost:4020` (same task network namespace).
- **No NAT gateway** (tasks run in public subnets with locked-down inbound) —
  saves ~$32/mo, the usual "cheap AWS" trap.
- **EFS** holds the git repos + JSON datastore, so replacing/redeploying the task
  loses nothing. `/secrets` is a **separate access point the compiler never
  mounts**, preserving the code's rule that the compiler can't read API keys.
- **Daily EFS backups** via AWS Backup (`aws_efs_backup_policy`, the built-in
  `aws/efs` vault, 35-day retention). EFS is the only copy of every user's
  work — restore a point-in-time copy from the AWS Backup console if anything
  is ever lost or fat-fingered.

## Prerequisites

1. **AWS account + SSO configured** (`aws configure sso`, then `aws sso login --profile papyr`).
   Pick the region once, in `terraform.tfvars`. Terraform defaults to
   `eu-central-1` and the helper scripts read the same file, so a region set in
   only one of the two is the usual cause of `docker push` failing with
   "repository does not exist".
2. **The hosted zone `example.com` already exists in Route53** in this account.
   (Registering/delegating the domain is a one-time manual step Terraform doesn't do.)
3. `terraform` (or `tofu`) ≥ 1.6, `docker` with buildx, `aws` CLI.

## Deploy

```bash
cd deploy/aws
cp terraform.tfvars.example terraform.tfvars   # fill in secret_env (gitignored)
export AWS_PROFILE=papyr                        # or export AWS_ACCESS_KEY_ID / _SECRET_ACCESS_KEY

./deploy.sh        # preflight → terraform apply → build+push images → wait → smoke-test the URL
```

`deploy.sh` is idempotent and fails early with a clear reason if a prerequisite
is missing (no creds, Route53 zone absent, Docker daemon off, empty tfvars). To
run the steps by hand instead:

```bash
terraform init && terraform apply     # infra + empty ECR repos + the ECS service
./push-images.sh                      # build server+compiler (arm64) → ECR → roll the service
aws ecs wait services-stable --cluster papyr --services papyr
```

DNS + the ACM cert validate automatically through the Route53 zone (a few minutes
on first apply). When it's stable, open **https://latex.example.com**.

### OAuth redirect URLs

Update the Google / GitHub OAuth apps so their callback URLs point at the new host:

- Google:  `https://latex.example.com/api/auth/oauth/google/callback`
- GitHub sync: `https://latex.example.com/api/github/oauth/callback`

Set the corresponding client id/secret in `secret_env`.

## Updating the app later

- **New app version:** run the **Deploy to AWS** GitHub Action (manual trigger,
  ships images via OIDC without touching infra). It tags both images with the
  commit SHA and registers a task definition pinned to those tags, so the
  running revision always answers "which commit is this?":
  ```bash
  aws ecs describe-services --cluster papyr --services papyr \
    --query 'services[0].taskDefinition'      # → the revision; its image tag is the SHA
  ```
  `./push-images.sh` is the fallback from an authenticated machine. It pushes
  `:latest`, which is *not* SHA-pinned, so prefer the Action.
- **Rolling back:** run the **Rollback AWS deploy** Action. An empty input takes
  the previous task-definition revision; pass a revision number to go further
  back. Nothing is rebuilt, so it takes about as long as one deploy cycle.
- **Infra change:** edit the `.tf` files → `terraform apply`.

The ECS deployment circuit breaker also rolls back on its own if the new tasks
never reach a healthy state.

## Staging on the same load balancer (optional)

Set `staging_domain_name` (a hostname in the same Route53 zone) and apply:

```hcl
staging_domain_name    = "staging.latex.example.com"
staging_env            = { ALDINE_MCP = "1" }   # anything you want to try before prod
github_deploy_branches = ["my-feature"]         # branches CI may deploy to staging
```

That adds a second certificate on the HTTPS listener, a host-header rule to a
second target group, and a second Fargate Spot service (`papyr-staging`) with
its own EFS filesystem and log group (`/papyr/staging`). It shares the VPC,
roles, ECR repositories and SSM secrets with prod — so OAuth sign-in only works
there if the providers also list the staging callback URL; password sign-in
always works. Cost is roughly one extra Spot task plus a few GB of EFS.

Deploy a branch to it from the Actions tab: **Deploy to AWS → branch: my-feature
→ target: staging**. Roll back the same way with **Rollback AWS deploy →
target: staging**. Scale the service to 0 in the console to pause it; unset
`staging_domain_name` and apply to remove it entirely (the EFS filesystem goes
with it — staging data is disposable by design).

## Cost (eu-central-1, low traffic, ballpark)

| Item | ~Monthly |
|------|----------|
| Application Load Balancer (fixed) | $16–18 |
| Fargate task, 1 vCPU / 3 GB, always-on **Spot** | $8–12 |
| EFS (a few GB, with IA lifecycle) | $1–3 |
| Route53 hosted zone + queries | $0.50 |
| ECR storage, CloudWatch logs, data transfer | $1–3 |
| **Total** | **~$27–37/mo** |

On-demand Fargate (`use_fargate_spot = false`) adds ~$15/mo for reclaim-proof
stability. The ALB is the dominant fixed cost — see below.

## Why this architecture (and not "pure Lambda")

Aldine is a **stateful real-time server**: it holds live Yjs documents in memory
and serves persistent `/collab` WebSockets, runs a **multi-GB TeX Live** compiler,
and keeps project state as **git repos on a filesystem**. That shape doesn't fit
scale-to-zero Lambda without rewriting the collaboration layer onto API Gateway
WebSockets + a shared document store, and the compiler's image size makes Lambda
cold starts painful. Fargate is the "serverless" (no VMs, no patching) option that
runs the app as-is.

Consequences worth knowing:

- **No true scale-to-zero.** The ALB + one small task are always on (~$27/mo floor).
  A single small VM would be cheaper but isn't serverless — that's the tradeoff you
  chose. Genuine scale-to-zero would need the collab-layer rewrite above.
- **Single task by default.** Collaboration is per-node; `desired_count` stays 1
  unless you also set `REDIS_URL` (+ sticky routing) so multiple tasks share docs.
- **Fargate Spot** can reclaim the task (~2 min notice); the app autosaves open
  docs on `SIGTERM`. Set `use_fargate_spot = false` to avoid that.

## Teardown

```bash
./teardown.sh          # empties ECR, then terraform destroy
```

> EFS is deleted with the stack — **back up `/data` first** if it holds real
> projects (`aws efs` / mount + copy, or the app's GitHub sync).
