# Persistent storage for git repos + the JSON datastore. EFS is pay-per-use
# (~$0.30/GB-mo) and mounts into Fargate, so the filesystem survives task
# replacement, redeploys, and Spot reclaims.
resource "aws_efs_file_system" "main" {
  count          = var.fargate ? 1 : 0
  creation_token = "papyr"
  encrypted      = true

  # Move files not touched for 30 days to Infrequent Access to cut cost.
  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }
  lifecycle_policy {
    transition_to_primary_storage_class = "AFTER_1_ACCESS"
  }

  tags = { Name = "papyr" }
}

# Daily automatic backups via AWS Backup (aws/efs vault, 35-day retention).
# This filesystem is the only copy of every user's projects — without this,
# an accidental destroy or fat-fingered rm is unrecoverable.
resource "aws_efs_backup_policy" "main" {
  count          = var.fargate ? 1 : 0
  file_system_id = aws_efs_file_system.main[0].id
  backup_policy {
    status = "ENABLED"
  }
}

resource "aws_efs_mount_target" "main" {
  count           = var.fargate ? length(aws_subnet.public) : 0
  file_system_id  = aws_efs_file_system.main[0].id
  subnet_id       = aws_subnet.public[count.index].id
  security_groups = [aws_security_group.efs.id]
}

# /data — project git repos + JSON store. Mounted by BOTH containers.
#
# uid/gid 0 is deliberate and COUPLED to the images: neither Dockerfile sets a
# USER, so both containers run as root and these permissions line up. If a
# container ever goes non-root, /data turns read-only and /secrets unreachable
# for it — and note creation_info only applies when EFS first creates the
# directory; changing owners here later is a no-op against a live filesystem
# (you'd have to chown from a mounted container instead).
resource "aws_efs_access_point" "data" {
  count          = var.fargate ? 1 : 0
  file_system_id = aws_efs_file_system.main[0].id
  root_directory {
    path = "/data"
    creation_info {
      owner_uid   = 0
      owner_gid   = 0
      permissions = "0755"
    }
  }
  tags = { Name = "papyr-data" }
}

# /secrets — Zotero API keys + project metadata. Mounted by the SERVER ONLY.
# config.ts keeps META_DIR outside DATA_DIR precisely so the compiler container
# (which mounts /data) can never read API keys via \openin; a separate access
# point the compiler never mounts enforces that boundary in the deployment.
resource "aws_efs_access_point" "secrets" {
  count          = var.fargate ? 1 : 0
  file_system_id = aws_efs_file_system.main[0].id
  root_directory {
    path = "/secrets"
    creation_info {
      owner_uid   = 0
      owner_gid   = 0
      permissions = "0700"
    }
  }
  tags = { Name = "papyr-secrets" }
}
