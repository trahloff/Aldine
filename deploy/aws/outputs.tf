output "app_url" {
  description = "The deployed app."
  value       = "https://${var.domain_name}"
}

output "alb_dns_name" {
  description = "ALB hostname (the app A/AAAA records alias to this)."
  value       = aws_lb.main.dns_name
}

output "ecr_server_repo" {
  description = "Push the server image here (see push-images.sh)."
  value       = aws_ecr_repository.repos["papyr-server"].repository_url
}

output "ecr_compiler_repo" {
  description = "Push the compiler image here."
  value       = aws_ecr_repository.repos["papyr-compiler"].repository_url
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service" {
  value = aws_ecs_service.app.name
}

output "github_infra_role_arn" {
  description = "Assume this from the infra repo's CI (empty github_infra_repo → null)."
  value       = try(aws_iam_role.github_infra[0].arn, null)
}

output "github_deploy_role_arn" {
  description = "Assume this from the app repo's image-deploy workflow (empty github_deploy_repo → null)."
  value       = try(aws_iam_role.github_deploy[0].arn, null)
}

output "staging_url" {
  description = "The staging deployment (null when staging_domain_name is empty)."
  value       = local.staging_enabled ? "https://${var.staging_domain_name}" : null
}
