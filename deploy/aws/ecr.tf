locals {
  # One repository pair per deployment. Staging (when enabled) gets its own so
  # a feature-branch push can never overwrite a tag a prod task definition
  # resolves, and staging churn never evicts the SHA-tagged images older prod
  # revisions roll back to. `keep` is the lifecycle window: prod revisions are
  # rollback targets, staging ones are disposable.
  ecr_repos = merge(
    { "papyr-server" = { keep = 30 }, "papyr-compiler" = { keep = 30 } },
    local.staging_enabled ? { "papyr-staging-server" = { keep = 10 }, "papyr-staging-compiler" = { keep = 10 } } : {},
  )
}

resource "aws_ecr_repository" "repos" {
  for_each             = local.ecr_repos
  name                 = each.key
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Keep only the last few images so the registry doesn't accrue storage cost.
resource "aws_ecr_lifecycle_policy" "repos" {
  for_each   = aws_ecr_repository.repos
  repository = each.value.name

  # Tagged images (SHA tags + latest) are rollback targets: keep a real window.
  # Untagged layers are churn from :latest re-pushes: reap them quickly. The
  # old single "keep 5 of anything" rule capped rollbacks at ~5 builds.
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged layers after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last ${local.ecr_repos[each.key].keep} tagged images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = local.ecr_repos[each.key].keep
        }
        action = { type = "expire" }
      },
    ]
  })
}
