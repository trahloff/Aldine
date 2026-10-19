variable "fargate" {
  description = "Run the app here: ECS Fargate, the ALB, EFS, ECR and staging. false keeps only DNS (set app_ipv4), SES, the offbox key and the CI infra role, for an app that runs elsewhere (deploy/hetzner). Turning it off destroys EFS: copy the data out first."
  type        = bool
  default     = true
}

# These resources gained `count = var.fargate ? 1 : 0`; existing states keep
# their objects under the [0] address instead of planning a replacement.
moved {
  from = aws_lb.main
  to   = aws_lb.main[0]
}
moved {
  from = aws_lb_target_group.app
  to   = aws_lb_target_group.app[0]
}
moved {
  from = aws_lb_listener.http
  to   = aws_lb_listener.http[0]
}
moved {
  from = aws_lb_listener.https
  to   = aws_lb_listener.https[0]
}
moved {
  from = aws_efs_file_system.main
  to   = aws_efs_file_system.main[0]
}
moved {
  from = aws_efs_backup_policy.main
  to   = aws_efs_backup_policy.main[0]
}
moved {
  from = aws_efs_access_point.data
  to   = aws_efs_access_point.data[0]
}
moved {
  from = aws_efs_access_point.secrets
  to   = aws_efs_access_point.secrets[0]
}
moved {
  from = aws_ecs_task_definition.app
  to   = aws_ecs_task_definition.app[0]
}
moved {
  from = aws_ecs_service.app
  to   = aws_ecs_service.app[0]
}
