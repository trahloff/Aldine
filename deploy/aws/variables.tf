variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "eu-central-1"
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture. ARM64 (Graviton) is ~20% cheaper; images must be built for it."
  type        = string
  default     = "ARM64"
}

variable "domain_name" {
  description = "Public domain the app is served on (e.g. latex.example.com)."
  type        = string
}

variable "route53_zone_name" {
  description = "Existing Route53 hosted zone that owns the domain (no trailing dot). The domain_name must be at or below it."
  type        = string
}

# ---- container sizing (Fargate task) ----
# Fargate valid combos: cpu 1024 (1 vCPU) allows memory 2048–8192. TeX Live needs
# headroom, so 1 vCPU / 3 GB is the cheap-but-workable default. Bump for big papers.
variable "task_cpu" {
  description = "Task-level CPU units (1024 = 1 vCPU)."
  type        = number
  default     = 1024
}

variable "task_memory" {
  description = "Task-level memory in MiB."
  type        = number
  default     = 3072
}

variable "use_fargate_spot" {
  description = "Run on Fargate Spot (~70% cheaper). Spot tasks can be reclaimed with ~2 min notice; the app autosaves on SIGTERM. Set false for on-demand stability."
  type        = bool
  default     = true
}

# ---- image tags (pushed to ECR by push-images.sh / the CD workflow) ----
variable "image_tag" {
  description = "Image tag for both the server and compiler images in ECR."
  type        = string
  default     = "latest"
}

# ---- app config ----
variable "auth_enabled" {
  description = "Enable accounts + sessions (AUTH_ENABLED)."
  type        = bool
  default     = true
}

variable "sso_only" {
  description = "Disable password endpoints; sign-in only via a configured OAuth provider (ALDINE_SSO_ONLY)."
  type        = bool
  default     = true
}

variable "ai_model" {
  description = "ALDINE_AI_MODEL (optional; used when an AI key secret is set)."
  type        = string
  default     = "anthropic/claude-opus-4.8"
}

# ---- transactional email (SES) ----
variable "enable_ses" {
  description = "Provision SES (domain identity, DKIM, MAIL FROM) and let the app send reset emails via the task role."
  type        = bool
  default     = true
}

variable "ses_from" {
  description = "From address for outbound email. Empty → \"Aldine <no-reply@<domain>>\"."
  type        = string
  default     = ""
}

variable "ses_mail_from_subdomain" {
  description = "Subdomain used as the custom MAIL FROM domain (for SPF alignment)."
  type        = string
  default     = "mail"
}

# ---- secrets ----
# Each non-empty entry becomes an SSM SecureString parameter and is injected into
# the server container as the env var of the same name. Empty values are skipped,
# so you only provision the providers you actually use. Put real values in
# terraform.tfvars (gitignored) or set them out-of-band after apply.
variable "secret_env" {
  description = "Map of ENV_VAR_NAME => secret value to store in SSM and inject into the server."
  type        = map(string)
  default     = {}
  sensitive   = true
}

# ---- deploy behaviour ----
variable "desired_count" {
  description = "Number of tasks. Keep at 1 unless you also set REDIS_URL + sticky routing (collab is single-node otherwise)."
  type        = number
  default     = 1
}

variable "github_infra_repo" {
  description = "GitHub repo (owner/name) whose main branch may assume the infra-admin role via OIDC. Empty = don't create GitHub OIDC resources for it."
  type        = string
  default     = ""
}

variable "github_deploy_repo" {
  description = "GitHub repo (owner/name) whose main branch may assume the image-deploy role via OIDC. Empty = don't create GitHub OIDC resources for it."
  type        = string
  default     = ""
}

# ---- staging (optional second service on the same ALB; see staging.tf) ----
variable "staging_domain_name" {
  description = "Hostname for a staging deployment that shares the ALB with prod (e.g. staging.latex.example.com, in the same Route53 zone). Empty = no staging resources."
  type        = string
  default     = ""
}

variable "staging_image_tag" {
  description = "Initial image tag for the staging task definition. The deploy workflow (target=staging) registers SHA-pinned revisions afterwards."
  type        = string
  default     = "latest"
}

variable "staging_env" {
  description = "Extra plain env for the staging server, merged over the prod env (e.g. { ALDINE_MCP = \"1\" } to try the Agent API before it reaches prod)."
  type        = map(string)
  default     = {}
}

variable "github_deploy_branches" {
  description = "Branches of github_deploy_repo allowed to assume the image-deploy role (main is always included). Add a feature branch here to deploy it to staging from CI."
  type        = list(string)
  default     = []
}
