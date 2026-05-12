// Outputs — most useful for plugging Dredd into other tooling.

output "vpc_id" {
  description = "VPC the stack runs in (reused, not created)."
  value       = var.existing_vpc_id
}

output "private_subnet_ids" {
  description = "Private subnets the Fargate tasks land in."
  value       = var.existing_private_subnet_ids
}

output "alb_subnet_ids" {
  description = "Subnets the ALB attaches to (existing public + the one this stack added in a second AZ)."
  value       = local.alb_subnet_ids
}

output "ecs_cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.main.arn
}

output "alb_dns_name" {
  description = "ALB DNS name. Route53 records alias here."
  value       = aws_lb.main.dns_name
}

output "hook_url" {
  description = "Public URL of the hook service."
  value       = "https://${var.hook_host}"
}

output "dashboard_url" {
  description = "Public URL of the dashboard."
  value       = "https://${var.dashboard_host}"
}

output "ecr_hook_repository_url" {
  description = "ECR URL for the hook image. Push to <this>:<image_tag>."
  value       = aws_ecr_repository.hook.repository_url
}

output "ecr_dashboard_repository_url" {
  description = "ECR URL for the dashboard image."
  value       = aws_ecr_repository.dashboard.repository_url
}

output "hook_task_role_arn" {
  description = "IAM role ARN assumed by the hook container."
  value       = aws_iam_role.hook_task.arn
}

output "dashboard_task_role_arn" {
  description = "IAM role ARN assumed by the dashboard container."
  value       = aws_iam_role.dashboard_task.arn
}

output "task_execution_role_arn" {
  description = "IAM role ARN ECS uses to pull images / fetch secrets / write logs."
  value       = aws_iam_role.task_exec.arn
}

output "secret_arns" {
  description = "Map of secret-name -> Secrets Manager ARN. Populate the values with `aws secretsmanager put-secret-value` before the tasks can start cleanly."
  value       = { for k, v in aws_secretsmanager_secret.dredd : k => v.arn }
}

output "jaid_sessions_arn" {
  description = "ARN of the sessions Dynamo table."
  value       = aws_dynamodb_table.jaid_sessions.arn
}

output "jaid_api_keys_arn" {
  description = "ARN of the API-keys Dynamo table."
  value       = aws_dynamodb_table.jaid_api_keys.arn
}
