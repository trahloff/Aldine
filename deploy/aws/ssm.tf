# Secrets live in SSM Parameter Store (SecureString, free tier) and are injected
# into the server container by ARN — values never appear in the task definition
# or logs. Only non-empty entries in var.secret_env are provisioned.
# The env-var NAMES are not secret (only the values are), so the key set can be
# de-sensitised for use as for_each keys; values are still pulled sensitively.
#
# Staging has its own parameter set under /papyr/staging/ (see staging.tf):
# nothing from the prod set reaches the staging task unless it is listed in
# var.staging_secret_env too.
locals {
  secret_keys = nonsensitive(toset([for k, v in var.secret_env : k if v != ""]))
}

resource "aws_ssm_parameter" "secret" {
  for_each = local.secret_keys
  name     = "/papyr/${each.key}"
  type     = "SecureString"
  value    = var.secret_env[each.key]

  # Let the value be rotated out-of-band (CLI/console) without Terraform drift.
  lifecycle {
    ignore_changes = [value]
  }
}
