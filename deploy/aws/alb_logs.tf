# ALB access logs: the only record of which request got which status at the edge.
# The app logs errors only, so a client-side or 4xx failure is otherwise invisible.
# Objects expire after 30 days; the bucket is private and the ELB log-delivery
# account for the region is the sole writer.

variable "alb_access_logs" {
  type        = bool
  default     = false
  description = "Write ALB access logs to S3 (30-day retention)"
}

data "aws_elb_service_account" "main" {
  count = var.alb_access_logs ? 1 : 0
}

resource "aws_s3_bucket" "alb_logs" {
  count         = var.alb_access_logs ? 1 : 0
  bucket        = "papyr-alb-logs-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  count                   = var.alb_access_logs ? 1 : 0
  bucket                  = aws_s3_bucket.alb_logs[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  count  = var.alb_access_logs ? 1 : 0
  bucket = aws_s3_bucket.alb_logs[0].id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration { days = 30 }
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  count  = var.alb_access_logs ? 1 : 0
  bucket = aws_s3_bucket.alb_logs[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = data.aws_elb_service_account.main[0].arn }
      Action    = "s3:PutObject"
      Resource  = "${aws_s3_bucket.alb_logs[0].arn}/alb/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
    }]
  })
}

data "aws_caller_identity" "current" {}
