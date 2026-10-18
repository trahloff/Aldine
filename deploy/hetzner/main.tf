# A production Aldine box on Hetzner Cloud: one server, Docker Compose,
# Caddy for TLS, the released images from GHCR. Unlike deploy/demo this box
# keeps its data: Hetzner's daily server backups plus a nightly off-box
# tarball (offbox-backup.sh) to any S3-compatible bucket.
#
# cloud-init only prepares the box (Docker, swap, the compose file, the backup
# timer). It carries no secrets: Hetzner keeps user_data readable in the
# project's API. The stack starts once /opt/aldine/.env exists, see README.md.
#
#   export HCLOUD_TOKEN=...
#   tofu init && tofu apply -var domain=aldine.example.com \
#     -var 'ssh_public_keys=["~/.ssh/id_ed25519.pub"]'

terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
    }
  }
}

provider "hcloud" {}

resource "hcloud_ssh_key" "keys" {
  for_each   = { for i, p in var.ssh_public_keys : tostring(i) => p }
  name       = "${var.name}-${each.key}"
  public_key = file(pathexpand(each.value))
}

resource "hcloud_firewall" "box" {
  name = var.name
  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  dynamic "rule" {
    for_each = ["22", "80", "443"]
    content {
      direction  = "in"
      protocol   = "tcp"
      port       = rule.value
      source_ips = ["0.0.0.0/0", "::/0"]
    }
  }
}

resource "hcloud_server" "box" {
  name               = var.name
  server_type        = var.server_type
  image              = "ubuntu-24.04"
  location           = var.location
  backups            = var.backups
  delete_protection  = true
  rebuild_protection = true
  labels             = { "managed-by" = "terraform" }
  ssh_keys           = [for k in hcloud_ssh_key.keys : k.id]
  firewall_ids       = [hcloud_firewall.box.id]
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    compose   = base64encode(file("${path.module}/compose.yml"))
    caddyfile = base64encode(file("${path.module}/../Caddyfile"))
    backup    = base64encode(file("${path.module}/../backup.sh"))
    offbox    = base64encode(file("${path.module}/offbox-backup.sh"))
    swap_gb   = var.swap_gb
  })

  # cloud-init runs once, at first boot; later changes to the template reach
  # the running box through the deploy step, never through a replacement.
  # A replaced server is an empty server.
  lifecycle {
    ignore_changes  = [user_data, ssh_keys]
    prevent_destroy = true
  }
}

output "ipv4" {
  value       = hcloud_server.box.ipv4_address
  description = "Point the A record for the domain here."
}

output "ipv6" {
  value       = hcloud_server.box.ipv6_address
  description = "Optional AAAA record."
}
