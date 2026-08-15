variable "demo_domain" {
  description = "Domain the demo is served on (e.g. demo.aldine.example.com). An A record must point at the server's IP."
  type        = string
}

variable "ssh_public_key" {
  description = "Path to the SSH public key allowed to log in."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "server_type" {
  description = "Hetzner server type. cx23 (2 vCPU / 4 GB) handles demo-size compiles for ~€4/mo. Availability varies by location — check the API if placement fails."
  type        = string
  default     = "cx23"
}

variable "location" {
  description = "Hetzner location. nbg1 carries the budget cx-line."
  type        = string
  default     = "nbg1"
}

variable "repo_url" {
  description = "Public git URL the box clones and runs. Must be public (or reachable with no credentials) at apply time."
  type        = string
  default     = "https://github.com/trahloff/Aldine.git"
}

variable "protected_projects" {
  type        = string
  default     = ""
  description = "Comma-separated project ids served read-only (the showcase paper). Seed the project first, then re-apply with its id."
}
