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
      { name = "DYNAMO_USER_PERMISSIONS_TABLE_NAME", value = aws_dynamodb_table.jaid_user_permissions.name },
      { name = "DYNAMO_BYOT_TABLE_NAME", value = aws_dynamodb_table.jaid_byot.name },
      { name = "DREDD_BYOT_ENABLED", value = var.byot_enabled },
      { name = "BYOT_KMS_KEY_ID", value = var.sse_kms_key_arn },
      { name = "DREDD_USER_PERMISSIONS_ENABLED", value = tostring(var.user_permissions_enforced) },
      { name = "DREDD_PATTERN_LEARNING_ENABLED", value = tostring(var.pattern_learning_enabled) },
      { name = "DREDD_PATTERN_LEARNING_HARD_ENABLED", value = tostring(var.pattern_learning_hard_enabled) },
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

  // Deploys happen out-of-band via the CLI workflow documented in
  // CLAUDE.md (build image → push to ECR → `aws ecs update-service
  // --force-new-deployment`), which registers new task-def revisions
  // and points the service at them without terraform. So terraform must
  // NOT manage the live task_definition pointer — otherwise every apply
  // tries to revert the service to whatever revision is in state (e.g.
  // rolling prod's Clerk-secrets revision :5 back to :4). Bump image_tag
  // + apply only if you want terraform to own a deploy; otherwise the
  // CLI is the source of truth for the running revision.
  lifecycle {
    ignore_changes = [
      desired_count,   // honour autoscaling if you add it later
      task_definition, // CLI / CI owns the running revision (see above)
    ]
  }

  depends_on = [aws_lb_listener_rule.hook]
}
