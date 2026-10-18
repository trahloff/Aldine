# The hosted zone must already exist (registering/delegating a domain is a
# one-time manual step). We look it up and add records under it.
data "aws_route53_zone" "main" {
  name         = var.route53_zone_name
  private_zone = false
}

# Point the app domain at the ALB (free alias record, no CloudFront needed),
# or at a box outside AWS when app_ipv4 is set (deploy/hetzner).
resource "aws_route53_record" "app" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "A"
  ttl     = var.app_ipv4 != "" ? 300 : null
  records = var.app_ipv4 != "" ? [var.app_ipv4] : null

  dynamic "alias" {
    for_each = var.app_ipv4 == "" ? [1] : []
    content {
      name                   = aws_lb.main.dns_name
      zone_id                = aws_lb.main.zone_id
      evaluate_target_health = true
    }
  }
}

