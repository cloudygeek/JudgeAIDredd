// CloudWatch Logs groups for the two ECS tasks.
//
// The task definition's awslogs driver writes here; the task execution
// role's AmazonECSTaskExecutionRolePolicy already covers
// logs:CreateLogStream + PutLogEvents.

resource "aws_cloudwatch_log_group" "hook" {
  name              = "/ecs/${local.name_prefix}/hook"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "dashboard" {
  name              = "/ecs/${local.name_prefix}/dashboard"
  retention_in_days = var.log_retention_days
}
