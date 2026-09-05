# Optional staging deployment on the SAME load balancer, enabled by setting
# var.staging_domain_name. It gets its own certificate, target group, listener
# rule, security groups, EFS filesystem, log group, ECR repositories, SSM
# secrets, execution role, task definition and service; it shares only the
# VPC, the ALB, the task role (SES send) and the cluster with prod.
#
# The separation is the point: staging runs unreviewed feature-branch images,
# so nothing it can reach may be a prod asset. Its task security group is not
# papyr-task (membership there is the only thing the prod EFS mount targets
# check), its execution role can read only /papyr/staging/* parameters, and a
# feature branch can only assume the staging deploy role (github-oidc.tf).
#
# The separate filesystem is also not optional: collab is single-node and the
# datastore is last-atomic-rename-wins, so two services on one /data would
# corrupt each other's projects. Staging secrets come from
# var.staging_secret_env, so OAuth sign-in works there only if you register a
# staging OAuth app; password sign-in always works because ALDINE_SSO_ONLY is
# never inherited from prod.

locals {
  staging_enabled = var.staging_domain_name != ""

  staging_server_env = merge(
    { for k, v in local.server_env : k => v if k != "ALDINE_SSO_ONLY" },
    { ALDINE_PUBLIC_URL = "https://${var.staging_domain_name}" },
    var.staging_env,
  )

  staging_secret_keys = nonsensitive(toset([for k, v in var.staging_secret_env : k if v != ""]))
}

# ---- secrets and the execution role that may read them. A separate role is
# what keeps a feature-branch task definition from listing a prod parameter:
# the prod execution role is never passed to a staging task (github-oidc.tf
# scopes iam:PassRole per deploy role).
resource "aws_ssm_parameter" "staging_secret" {
  for_each = local.staging_enabled ? local.staging_secret_keys : toset([])
  name     = "/papyr/staging/${each.key}"
  type     = "SecureString"
  value    = var.staging_secret_env[each.key]

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_iam_role" "staging_execution" {
  count              = local.staging_enabled ? 1 : 0
  name               = "papyr-staging-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "staging_execution_managed" {
  count      = local.staging_enabled ? 1 : 0
  role       = aws_iam_role.staging_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "staging_read_secrets" {
  count = local.staging_enabled && length(local.staging_secret_keys) > 0 ? 1 : 0
  statement {
    actions   = ["ssm:GetParameters"]
    resources = [for p in aws_ssm_parameter.staging_secret : p.arn]
  }
}

resource "aws_iam_role_policy" "staging_read_secrets" {
  count  = local.staging_enabled && length(local.staging_secret_keys) > 0 ? 1 : 0
  name   = "papyr-staging-read-secrets"
  role   = aws_iam_role.staging_execution[0].id
  policy = data.aws_iam_policy_document.staging_read_secrets[0].json
}

# ---- network: staging's own task and EFS security groups. The prod mount
# targets admit NFS from papyr-task only, so a staging task in its own group
# has no route to the prod filesystem, /secrets included.
resource "aws_security_group" "staging_task" {
  count       = local.staging_enabled ? 1 : 0
  name        = "papyr-staging-task"
  description = "Papyr staging Fargate task"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "App port from ALB only"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "papyr-staging-task" }
}

resource "aws_security_group" "staging_efs" {
  count       = local.staging_enabled ? 1 : 0
  name        = "papyr-staging-efs"
  description = "Papyr staging EFS mount targets"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "NFS from staging tasks"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.staging_task[0].id]
  }
  tags = { Name = "papyr-staging-efs" }
}

# ---- TLS: a second certificate on the HTTPS listener (SNI), so the prod
# certificate is never touched when staging comes or goes.
resource "aws_acm_certificate" "staging" {
  count             = local.staging_enabled ? 1 : 0
  domain_name       = var.staging_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "staging_cert_validation" {
  for_each = local.staging_enabled ? {
    for dvo in aws_acm_certificate.staging[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id         = data.aws_route53_zone.main.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "staging" {
  count                   = local.staging_enabled ? 1 : 0
  certificate_arn         = aws_acm_certificate.staging[0].arn
  validation_record_fqdns = [for r in aws_route53_record.staging_cert_validation : r.fqdn]
}

resource "aws_lb_listener_certificate" "staging" {
  count           = local.staging_enabled ? 1 : 0
  listener_arn    = aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.staging[0].certificate_arn
}

resource "aws_route53_record" "staging" {
  count   = local.staging_enabled ? 1 : 0
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.staging_domain_name
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# ---- routing: host header → staging target group; everything else still
# hits the listener's default (prod) action.
resource "aws_lb_target_group" "staging" {
  count       = local.staging_enabled ? 1 : 0
  name        = "papyr-staging"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400
    enabled         = true
  }

  deregistration_delay = 30
}

resource "aws_lb_listener_rule" "staging" {
  count        = local.staging_enabled ? 1 : 0
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.staging[0].arn
  }

  condition {
    host_header {
      values = [var.staging_domain_name]
    }
  }
}

# ---- storage: its own filesystem, no AWS Backup (staging data is disposable).
resource "aws_efs_file_system" "staging" {
  count          = local.staging_enabled ? 1 : 0
  creation_token = "papyr-staging"
  encrypted      = true

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }
  lifecycle_policy {
    transition_to_primary_storage_class = "AFTER_1_ACCESS"
  }

  tags = { Name = "papyr-staging" }
}

resource "aws_efs_mount_target" "staging" {
  count           = local.staging_enabled ? length(aws_subnet.public) : 0
  file_system_id  = aws_efs_file_system.staging[0].id
  subnet_id       = aws_subnet.public[count.index].id
  security_groups = [aws_security_group.staging_efs[0].id]
}

# Same uid/gid coupling as efs.tf: both images run as root.
resource "aws_efs_access_point" "staging_data" {
  count          = local.staging_enabled ? 1 : 0
  file_system_id = aws_efs_file_system.staging[0].id
  root_directory {
    path = "/data"
    creation_info {
      owner_uid   = 0
      owner_gid   = 0
      permissions = "0755"
    }
  }
  tags = { Name = "papyr-staging-data" }
}

resource "aws_efs_access_point" "staging_secrets" {
  count          = local.staging_enabled ? 1 : 0
  file_system_id = aws_efs_file_system.staging[0].id
  root_directory {
    path = "/secrets"
    creation_info {
      owner_uid   = 0
      owner_gid   = 0
      permissions = "0700"
    }
  }
  tags = { Name = "papyr-staging-secrets" }
}

resource "aws_cloudwatch_log_group" "staging" {
  count             = local.staging_enabled ? 1 : 0
  name              = "/papyr/staging"
  retention_in_days = 7
}

# ---- compute: same task shape as prod (see ecs.tf for the shared container
# spec and the reasons behind the 0/100 deployment and the 120 s stop timeout).
resource "aws_ecs_task_definition" "staging" {
  count                    = local.staging_enabled ? 1 : 0
  family                   = "papyr-staging"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.staging_execution[0].arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = "data"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.staging[0].id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.staging_data[0].id
        iam             = "DISABLED"
      }
    }
  }

  volume {
    name = "secrets"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.staging[0].id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.staging_secrets[0].id
        iam             = "DISABLED"
      }
    }
  }

  container_definitions = local.container_definitions.staging
}

resource "aws_ecs_service" "staging" {
  count           = local.staging_enabled ? 1 : 0
  name            = "papyr-staging"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.staging[0].arn
  desired_count   = 1

  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.staging_task[0].id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.staging[0].arn
    container_name   = "server"
    container_port   = 3000
  }

  health_check_grace_period_seconds = 180

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  depends_on = [aws_lb_listener_rule.staging, aws_ecs_cluster_capacity_providers.main]

  lifecycle {
    # desired_count: scale to 0 from the console to pause staging without a
    # Terraform run. task_definition: the deploy workflow registers SHA-pinned
    # revisions, exactly as for prod.
    ignore_changes = [desired_count, task_definition]
  }
}
