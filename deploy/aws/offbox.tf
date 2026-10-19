# Access for a box outside AWS (deploy/hetzner): it keeps sending mail through
# this account's SES identity and writes its nightly backups here. One IAM user
# with a static key, because the box has no role to assume. The key can write
# and read backups but not delete them, so a compromised box cannot erase its
# own history; the lifecycle rule is the only thing that removes objects.

locals {
  offbox_actions = concat(
    var.enable_ses ? [{ actions = ["ses:SendEmail"], resources = [aws_sesv2_email_identity.domain[0].arn] }] : [],
    var.offbox_access ? [
      { actions = ["s3:PutObject", "s3:GetObject"], resources = ["${aws_s3_bucket.offbox[0].arn}/*"] },
      { actions = ["s3:ListBucket"], resources = [aws_s3_bucket.offbox[0].arn] },
    ] : [],
  )
}

resource "aws_s3_bucket" "offbox" {
  count  = var.offbox_access ? 1 : 0
  bucket = "aldine-backups-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "offbox" {
  count                   = var.offbox_access ? 1 : 0
  bucket                  = aws_s3_bucket.offbox[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "offbox" {
  count  = var.offbox_access ? 1 : 0
  bucket = aws_s3_bucket.offbox[0].id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration { days = 35 }
  }
}

resource "aws_iam_user" "offbox" {
  count = var.offbox_access ? 1 : 0
  name  = "aldine-offbox"
}

resource "aws_iam_user_policy" "offbox" {
  count = var.offbox_access ? 1 : 0
  name  = "aldine-offbox"
  user  = aws_iam_user.offbox[0].name
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [for s in local.offbox_actions : { Effect = "Allow", Action = s.actions, Resource = s.resources }]
  })
}

resource "aws_iam_access_key" "offbox" {
  count = var.offbox_access ? 1 : 0
  user  = aws_iam_user.offbox[0].name
}

output "offbox_bucket" {
  value = var.offbox_access ? aws_s3_bucket.offbox[0].id : null
}

output "offbox_access_key_id" {
  value = var.offbox_access ? aws_iam_access_key.offbox[0].id : null
}

output "offbox_secret_access_key" {
  value     = var.offbox_access ? aws_iam_access_key.offbox[0].secret : null
  sensitive = true
}

output "ses_from" {
  value       = var.enable_ses ? local.ses_from : null
  description = "SES_FROM for a box outside AWS."
}
