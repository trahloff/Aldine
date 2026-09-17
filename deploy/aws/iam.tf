data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: pull images from ECR, write logs, read the SSM secrets.
resource "aws_iam_role" "execution" {
  name               = "papyr-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_secrets" {
  # Only granted when there are secrets to read.
  count = length(local.secret_keys) > 0 ? 1 : 0
  statement {
    actions   = ["ssm:GetParameters"]
    resources = [for p in aws_ssm_parameter.secret : p.arn]
  }
}

resource "aws_iam_role_policy" "read_secrets" {
  count  = length(local.secret_keys) > 0 ? 1 : 0
  name   = "papyr-read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_secrets[0].json
}

# Task role: the app's only AWS API need is sending email via SES (when enabled);
# git/OAuth/compile are all outbound HTTP. Least privilege otherwise.
resource "aws_iam_role" "task" {
  name               = "papyr-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# ECS Exec: the SSM agent inside the task opens these channels; the
# resources are not scopeable (AWS documents them as "*").
data "aws_iam_policy_document" "ecs_exec" {
  count = var.enable_ecs_exec ? 1 : 0
  statement {
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ecs_exec" {
  count  = var.enable_ecs_exec ? 1 : 0
  name   = "papyr-ecs-exec"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.ecs_exec[0].json
}

data "aws_iam_policy_document" "send_email" {
  count = var.enable_ses ? 1 : 0
  statement {
    actions   = ["ses:SendEmail"]
    resources = [aws_sesv2_email_identity.domain[0].arn]
  }
}

resource "aws_iam_role_policy" "send_email" {
  count  = var.enable_ses ? 1 : 0
  name   = "papyr-send-email"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.send_email[0].json
}
