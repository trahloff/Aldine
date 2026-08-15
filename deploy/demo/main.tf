# Throwaway public demo box for Aldine (~€4/mo Hetzner cx23; see variables.tf).
#
# Design: auth OFF (visitors get the full editor instantly), TLS via Caddy,
# and a nightly wipe (volumes destroyed + stack recreated at 04:00 UTC) so
# whatever people leave behind disappears. Nothing on this box matters.
#
#   export HCLOUD_TOKEN=...           # Hetzner Cloud API token (project-scoped)
#   terraform init && terraform apply \
#     -var demo_domain=demo.aldine.example.com -var ssh_public_key=~/.ssh/id_ed25519.pub
#   # then point an A record for demo_domain at the printed IP; Caddy
#   # provisions the certificate on first request.

terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
    }
  }
}

provider "hcloud" {}

resource "hcloud_ssh_key" "demo" {
  name       = "aldine-demo"
  public_key = file(pathexpand(var.ssh_public_key))
}

resource "hcloud_firewall" "demo" {
  name = "aldine-demo"
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "demo" {
  name         = "aldine-demo"
  server_type  = var.server_type
  image        = "ubuntu-24.04"
  location     = var.location
  labels       = { "managed-by" = "terraform" }
  ssh_keys     = [hcloud_ssh_key.demo.id]
  firewall_ids = [hcloud_firewall.demo.id]
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    demo_domain        = var.demo_domain
    repo_url           = var.repo_url
    protected_projects = var.protected_projects
  })
}

output "ip" {
  value       = hcloud_server.demo.ipv4_address
  description = "Point an A record for demo_domain here."
}
