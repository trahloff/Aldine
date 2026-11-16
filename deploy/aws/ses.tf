# --- Transactional email via SES ---------------------------------------------
# Verifies the app domain as a SES sending identity with Easy DKIM, a MAIL FROM
# subdomain (SPF alignment), and a permissive DMARC record. The app sends via the
# SDK using the task role (see iam.tf) — no SMTP credentials.
#
# NOTE: new SES accounts start in the SANDBOX — you can only send to *verified*
# addresses and are capped at 200/day. Request production access in the SES
# console (Account dashboard → Request production access) before real signups.

locals {
  ses_mail_from = "${var.ses_mail_from_subdomain}.${var.domain_name}"
  ses_from      = var.ses_from != "" ? var.ses_from : "Aldine <no-reply@${var.domain_name}>"
}

resource "aws_sesv2_email_identity" "domain" {
  count          = var.enable_ses ? 1 : 0
  email_identity = var.domain_name
}

# Easy DKIM: three CNAMEs let SES sign outbound mail as the domain.
resource "aws_route53_record" "ses_dkim" {
  count   = var.enable_ses ? 3 : 0
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

# Custom MAIL FROM domain so SPF aligns with the From: domain.
resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  count                  = var.enable_ses ? 1 : 0
  email_identity         = aws_sesv2_email_identity.domain[0].email_identity
  mail_from_domain       = local.ses_mail_from
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "ses_mail_from_mx" {
  count   = var.enable_ses ? 1 : 0
  zone_id = data.aws_route53_zone.main.zone_id
  name    = local.ses_mail_from
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.${var.region}.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_spf" {
  count   = var.enable_ses ? 1 : 0
  zone_id = data.aws_route53_zone.main.zone_id
  name    = local.ses_mail_from
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

# Permissive DMARC — enables DKIM/SPF alignment reporting without rejecting mail.
resource "aws_route53_record" "ses_dmarc" {
  count   = var.enable_ses ? 1 : 0
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 600
  records = ["v=DMARC1; p=none;"]
}

# --- Further sending domains ---------------------------------------------------
# More instances that send through this account (another box on deploy/hetzner,
# say), each as its own domain: the same identity, DKIM, MAIL FROM and DMARC
# records as above, in the zone named for it. The offbox key may send as them.

data "aws_route53_zone" "ses_extra" {
  for_each     = var.enable_ses ? var.ses_extra_domains : {}
  name         = each.value
  private_zone = false
}

resource "aws_sesv2_email_identity" "extra" {
  for_each       = var.enable_ses ? var.ses_extra_domains : {}
  email_identity = each.key
}

resource "aws_route53_record" "ses_extra_dkim" {
  # DKIM tokens are only known after apply, so the keys are positions.
  for_each = { for p in setproduct(keys(var.enable_ses ? var.ses_extra_domains : {}), [0, 1, 2]) : "${p[0]}/${p[1]}" => { domain = p[0], i = p[1] } }
  zone_id  = data.aws_route53_zone.ses_extra[each.value.domain].zone_id
  name     = "${aws_sesv2_email_identity.extra[each.value.domain].dkim_signing_attributes[0].tokens[each.value.i]}._domainkey.${each.value.domain}"
  type     = "CNAME"
  ttl      = 600
  records  = ["${aws_sesv2_email_identity.extra[each.value.domain].dkim_signing_attributes[0].tokens[each.value.i]}.dkim.amazonses.com"]
}

resource "aws_sesv2_email_identity_mail_from_attributes" "extra" {
  for_each               = aws_sesv2_email_identity.extra
  email_identity         = each.value.email_identity
  mail_from_domain       = "${var.ses_mail_from_subdomain}.${each.key}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "ses_extra_mail_from_mx" {
  for_each = aws_sesv2_email_identity.extra
  zone_id  = data.aws_route53_zone.ses_extra[each.key].zone_id
  name     = "${var.ses_mail_from_subdomain}.${each.key}"
  type     = "MX"
  ttl      = 600
  records  = ["10 feedback-smtp.${var.region}.amazonses.com"]
}

resource "aws_route53_record" "ses_extra_mail_from_spf" {
  for_each = aws_sesv2_email_identity.extra
  zone_id  = data.aws_route53_zone.ses_extra[each.key].zone_id
  name     = "${var.ses_mail_from_subdomain}.${each.key}"
  type     = "TXT"
  ttl      = 600
  records  = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "ses_extra_dmarc" {
  for_each = aws_sesv2_email_identity.extra
  zone_id  = data.aws_route53_zone.ses_extra[each.key].zone_id
  name     = "_dmarc.${each.key}"
  type     = "TXT"
  ttl      = 600
  records  = ["v=DMARC1; p=none;"]
}
