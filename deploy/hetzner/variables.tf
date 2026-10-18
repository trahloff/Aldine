variable "name" {
  description = "Server, firewall and SSH key name prefix."
  type        = string
  default     = "aldine"
}

variable "ssh_public_keys" {
  description = "Paths to the SSH public keys allowed to log in as root (a person's key, and the deploy key CI uses)."
  type        = list(string)
  default     = []
}

variable "existing_ssh_keys" {
  description = "Names of SSH keys already in the Hetzner project to allow as well. Hetzner rejects a second copy of the same public key."
  type        = list(string)
  default     = []
}

variable "server_type" {
  description = "Hetzner server type. cx23 (2 vCPU, 4 GB, 40 GB disk) fits a research group with the full TeX Live compiler; the compiler is capped at 2 GB per compile. Stock varies by location; check the API if placement fails."
  type        = string
  default     = "cx23"
}

variable "location" {
  description = "Hetzner location (fsn1, nbg1, hel1)."
  type        = string
  default     = "fsn1"
}

variable "backups" {
  description = "Hetzner's daily server backups (7 kept, +20% of the server price). Off-box backups come from offbox-backup.sh on top."
  type        = bool
  default     = true
}

variable "swap_gb" {
  description = "Swap file size. A full TeX Live compile and the app share 4 GB on a cx23; swap absorbs the peak instead of the OOM killer."
  type        = number
  default     = 4
}
