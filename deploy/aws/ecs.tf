resource "aws_ecs_cluster" "main" {
  name = "papyr"
  setting {
    name  = "containerInsights"
    value = "disabled" # Insights bills per metric; off keeps the deploy cheap.
  }
}

# A service can only reference FARGATE / FARGATE_SPOT in its capacity_provider_
# strategy if the cluster has them associated first. Without this the first
# apply fails with "capacity provider not found".
resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

locals {
  # Plain (non-secret) env for the server. Secrets come from SSM below.
  server_env = merge(
    {
      NODE_ENV           = "production"
      SENTRY_ENVIRONMENT = "production"
      PORT               = "3000"
      DATA_DIR           = "/data"
      META_DIR           = "/secrets"
      COMPILER_URL       = "http://localhost:4020"
      ALDINE_PUBLIC_URL  = "https://${var.domain_name}"
      COOKIE_SECURE      = "1"
      TRUST_PROXY        = "1" # behind the ALB, so X-Forwarded-For is trusted for rate-limit keys
      ALDINE_AI_MODEL    = var.ai_model
    },
    var.auth_enabled ? { AUTH_ENABLED = "1" } : {},
    var.sso_only ? { ALDINE_SSO_ONLY = "1" } : {},
    var.enable_ses ? { SES_FROM = local.ses_from, AWS_REGION = var.region } : {},
  )

  # One container spec for every deployment (prod, and staging when enabled —
  # see staging.tf), so the two can only differ in image repositories and tag,
  # env, secrets and log destination. Anything else that diverges here is a
  # drift bug. Repositories and secrets are per deployment on purpose: a
  # staging task must not be able to read a prod secret or run a prod tag.
  deployments = merge(
    {
      prod = {
        image_tag = var.image_tag
        env       = local.server_env
        log_group = aws_cloudwatch_log_group.app.name
        repos = {
          server   = aws_ecr_repository.repos["papyr-server"].repository_url
          compiler = aws_ecr_repository.repos["papyr-compiler"].repository_url
        }
        secrets = aws_ssm_parameter.secret
      }
    },
    local.staging_enabled ? {
      staging = {
        image_tag = var.staging_image_tag
        env       = local.staging_server_env
        log_group = aws_cloudwatch_log_group.staging[0].name
        repos = {
          server   = aws_ecr_repository.repos["papyr-staging-server"].repository_url
          compiler = aws_ecr_repository.repos["papyr-staging-compiler"].repository_url
        }
        secrets = aws_ssm_parameter.staging_secret
      }
    } : {},
  )

  container_definitions = { for name, d in local.deployments : name => jsonencode([
    {
      name            = "compiler"
      image           = "${d.repos.compiler}:${d.image_tag}"
      essential       = true
      linuxParameters = { initProcessEnabled = true } # reap orphaned pdflatex/biber
      environment     = [{ name = "DATA_DIR", value = "/data" }, { name = "PORT", value = "4020" }]
      mountPoints     = [{ sourceVolume = "data", containerPath = "/data", readOnly = false }]
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"require('http').get('http://localhost:4020/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = d.log_group
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "compiler"
        }
      }
    },
    {
      name            = "server"
      image           = "${d.repos.server}:${d.image_tag}"
      essential       = true
      linuxParameters = { initProcessEnabled = true } # reap orphaned git children
      environment     = [for k, v in d.env : { name = k, value = tostring(v) }]
      secrets         = [for k, p in d.secrets : { name = k, valueFrom = p.arn }]
      dependsOn       = [{ containerName = "compiler", condition = "HEALTHY" }]
      # Give the shutdown hook time to flush open Yjs docs + autosave-commit.
      stopTimeout = 120
      mountPoints = [
        { sourceVolume = "data", containerPath = "/data", readOnly = false },
        { sourceVolume = "secrets", containerPath = "/secrets", readOnly = false },
      ]
      portMappings = [{ containerPort = 3000, protocol = "tcp" }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = d.log_group
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "server"
        }
      }
    },
  ]) }
}

resource "aws_ecs_task_definition" "app" {
  family                   = "papyr"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  # /data — shared with the compiler.
  volume {
    name = "data"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.main.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.data.id
        iam             = "DISABLED"
      }
    }
  }

  # /secrets — server only (see efs.tf for why the compiler must not mount this).
  volume {
    name = "secrets"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.main.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.secrets.id
        iam             = "DISABLED"
      }
    }
  }

  container_definitions = local.container_definitions.prod
}

resource "aws_ecs_service" "app" {
  name            = "papyr"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count

  capacity_provider_strategy {
    capacity_provider = var.use_fargate_spot ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true # required for egress without a NAT gateway
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "server"
    container_port   = 3000
  }

  health_check_grace_period_seconds = 180

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Stop the old task before starting the new one (0/100). This single-task
  # deploy shares one EFS /data RW between tasks, so a 2-task overlap could lose
  # a concurrent datastore write (last atomic rename wins) or dual-seed a hot
  # Yjs doc without REDIS_URL. 0/100 trades a brief redeploy downtime for no
  # overlap; the old task still gets SIGTERM to flush + autosave before it stops.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  depends_on = [aws_lb_listener.https, aws_ecs_cluster_capacity_providers.main]

  lifecycle {
    # desired_count: don't fight manual/console scaling.
    # task_definition: CI registers SHA-pinned revisions on every deploy;
    # without this, the next terraform apply would silently roll the service
    # back to the :latest-pinned revision from this file.
    ignore_changes = [desired_count, task_definition]
  }
}
