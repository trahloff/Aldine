# GitHub Actions → AWS via OIDC, no long-lived keys. Nothing is created unless
# github_infra_repo / github_deploy_repo are set, so self-hosters who don't
# deploy from CI are unaffected.
#
#   infra role  — admin (Terraform manages IAM/EFS/ALB/…), for the repo that
#                 runs `tofu` in CI.
#   deploy role — ECR push + ECS roll only, for the app repo's image workflow.

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.github_infra_repo != "" || var.github_deploy_repo != "" ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS validates GitHub's cert against trusted root CAs; the thumbprint is
  # required by the API but no longer used for trust decisions.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

locals {
  # infra = Terraform (admin) → main only. deploy = image roll → main plus any
  # branch listed in github_deploy_branches, so a feature branch can ship to
  # staging from CI. Anyone who can push those branches can roll a service.
  github_roles = { for k, v in {
    infra  = { repo = var.github_infra_repo, branches = ["main"] }
    deploy = { repo = var.github_deploy_repo, branches = distinct(concat(["main"], var.github_deploy_branches)) }
  } : k => v if v.repo != "" }
}

data "aws_iam_policy_document" "github_assume" {
  for_each = local.github_roles

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = flatten([for b in each.value.branches : [
        # legacy name-only claim (repos created before 2026-07-15)
        "repo:${each.value.repo}:ref:refs/heads/${b}",
        # immutable-ID claim (newer repos): owner@ID/name@ID. '@' cannot
        # appear in GitHub owner or repo names, so these wildcards cannot
        # match any other repo's claim.
        "repo:${replace(each.value.repo, "/", "@*/")}@*:ref:refs/heads/${b}",
      ]])
    }
  }
}

resource "aws_iam_role" "github_infra" {
  count              = var.github_infra_repo != "" ? 1 : 0
  name               = "papyr-github-infra"
  assume_role_policy = data.aws_iam_policy_document.github_assume["infra"].json
}

resource "aws_iam_role_policy_attachment" "github_infra_admin" {
  count      = var.github_infra_repo != "" ? 1 : 0
  role       = aws_iam_role.github_infra[0].name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

resource "aws_iam_role" "github_deploy" {
  count              = var.github_deploy_repo != "" ? 1 : 0
  name               = "papyr-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_assume["deploy"].json
}

resource "aws_iam_role_policy" "github_deploy" {
  count = var.github_deploy_repo != "" ? 1 : 0
  name  = "image-deploy"
  role  = aws_iam_role.github_deploy[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrAuth"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "EcrPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = [for r in aws_ecr_repository.repos : r.arn]
      },
      {
        Sid      = "EcsRoll"
        Effect   = "Allow"
        Action   = ["ecs:UpdateService", "ecs:DescribeServices"]
        Resource = concat([aws_ecs_service.app.id], local.staging_enabled ? [aws_ecs_service.staging[0].id] : [])
      },
      {
        # SHA-pinned deploys: CI reads the live task def, swaps the image tags,
        # and registers a new revision (these ECS actions don't support
        # resource-level scoping).
        Sid      = "TaskDefPinning"
        Effect   = "Allow"
        Action   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
        Resource = "*"
      },
      {
        # Registering a task def that references the task/execution roles
        # requires passing them — scoped to exactly those two, ECS only.
        Sid       = "PassTaskRoles"
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = [aws_iam_role.task.arn, aws_iam_role.execution.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
    ]
  })
}
