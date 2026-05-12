// Hook task definition + service. The hook is on the request hot path
// from Claude Code; default desired_count = 2 for AZ redundancy.

resource "aws_ecs_task_definition" "hook" {
  family                   = "${local.name_prefix}-hook"
  cpu                      = var.hook_cpu
  memory                   = var.hook_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.task_exec.arn
  task_role_arn            = aws_iam_role.hook_task.arn

  container_definitions = jsonencode([{
    name      = "hook"
    image     = "${aws_ecr_repository.hook.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{
      containerPort = 3000
      hostPort      = 3000
      protocol      = "tcp"
    }]

    environment = [
      { name = "DREDD_ROLE", value = "hook" },
      { name = "MODE", value = var.dredd_mode },
      { name = "BACKEND", value = "bedrock" },
      { name = "JUDGE_MODEL", value = var.judge_model },
      { name = "EMBEDDING_MODEL", value = var.embedding_model },
      { name = "HARDENED", value = var.hardened },
      { name = "PORT", value = "3000" },
      { name = "DATA_DIR", value = "/data" },
      { name = "AWS_REGION", value = var.bedrock_region },
      { name = "STORE_BACKEND", value = "dynamo" },
      { name = "DYNAMO_TABLE_NAME", value = aws_dynamodb_table.jaid_sessions.name },
      { name = "DYNAMO_REGION", value = local.tables_region },
      { name = "DYNAMO_API_KEYS_TABLE_NAME", value = aws_dynamodb_table.jaid_api_keys.name },
      { name = "DREDD_AUTH_MODE", value = var.dredd_auth_mode },
      { name = "DREDD_DASHBOARD_ORIGIN", value = "https://${var.dashboard_host}" },
    ]

    // Secrets injected as env vars at task-start time. Values come from
    // Secrets Manager; the task_exec role has GetSecretValue.
    secrets = [
      { name = "CLERK_PUBLISHABLE_KEY", valueFrom = aws_secretsmanager_secret.dredd["clerk-publishable-key"].arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.hook.name
        "awslogs-region"        = var.primary_region
        "awslogs-stream-prefix" = "hook"
      }
    }
  }])
}

resource "aws_ecs_service" "hook" {
  name            = "${local.name_prefix}-hook"
  cluster         = aws_ecs_cluster.main.arn
  task_definition = aws_ecs_task_definition.hook.arn
  desired_count   = var.hook_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.existing_private_subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.hook.arn
    container_name   = "hook"
    container_port   = 3000
  }

  // Rolling deploy: keep at least 50% serving while a new revision
  // rolls out; double up to 200% so we never go below capacity.
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  // Give a fresh task 60s to settle before its target-group health
  // check counts. Cold-start of Node + Bedrock preflight is ~10-20s.
  health_check_grace_period_seconds = 60

  // Don't churn the task def revision on no-op image tag updates.
  // (Image push to the same tag does not change the task def ARN.)
  lifecycle {
    ignore_changes = [desired_count] // honour autoscaling if you add it later
  }

  depends_on = [aws_lb_listener_rule.hook]
}
