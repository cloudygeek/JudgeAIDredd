// Dashboard task definition + service. Lower replicas than the hook;
// the dashboard is operator-facing, not on the hot path.

resource "aws_ecs_task_definition" "dashboard" {
  family                   = "${local.name_prefix}-dashboard"
  cpu                      = var.dashboard_cpu
  memory                   = var.dashboard_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.task_exec.arn
  task_role_arn            = aws_iam_role.dashboard_task.arn

  container_definitions = jsonencode([{
    name      = "dashboard"
    image     = "${aws_ecr_repository.dashboard.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{
      containerPort = 3000
      hostPort      = 3000
      protocol      = "tcp"
    }]

    environment = [
      { name = "DREDD_ROLE", value = "dashboard" },
      { name = "PORT", value = "3000" },
      { name = "DATA_DIR", value = "/data" },
      { name = "AWS_REGION", value = var.primary_region },
      { name = "STORE_BACKEND", value = "dynamo" },
      { name = "DYNAMO_TABLE_NAME", value = aws_dynamodb_table.jaid_sessions.name },
      { name = "DYNAMO_REGION", value = local.tables_region },
      { name = "DYNAMO_API_KEYS_TABLE_NAME", value = aws_dynamodb_table.jaid_api_keys.name },
      { name = "DYNAMO_USER_PERMISSIONS_TABLE_NAME", value = aws_dynamodb_table.jaid_user_permissions.name },
      { name = "DYNAMO_BYOT_TABLE_NAME", value = aws_dynamodb_table.jaid_byot.name },
      { name = "BYOT_KMS_KEY_ID", value = var.sse_kms_key_arn },
      { name = "DREDD_HOOK_URL", value = "https://${var.hook_host}" },
    ]

    secrets = [
      { name = "CLERK_SECRET_KEY", valueFrom = aws_secretsmanager_secret.dredd["clerk-secret-key"].arn },
      { name = "CLERK_PUBLISHABLE_KEY", valueFrom = aws_secretsmanager_secret.dredd["clerk-publishable-key"].arn },
      { name = "CLERK_JWT_PUBLIC_KEY", valueFrom = aws_secretsmanager_secret.dredd["clerk-jwt-public-key"].arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.dashboard.name
        "awslogs-region"        = var.primary_region
        "awslogs-stream-prefix" = "dashboard"
      }
    }
  }])
}

resource "aws_ecs_service" "dashboard" {
  name            = "${local.name_prefix}-dashboard"
  cluster         = aws_ecs_cluster.main.arn
  task_definition = aws_ecs_task_definition.dashboard.arn
  desired_count   = var.dashboard_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.existing_private_subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.dashboard.arn
    container_name   = "dashboard"
    container_port   = 3000
  }

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener_rule.dashboard]
}
