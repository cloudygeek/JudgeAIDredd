// IAM roles & policies for the two Fargate task definitions.
//
// Three roles in total:
//   - task_exec      (one, shared): pulls images from ECR, writes logs,
//                                   reads Secrets Manager
//   - hook_task      (hook only):   Dynamo R/W on sessions, R on api-keys,
//                                   Bedrock InvokeModel, KMS for SSE
//   - dashboard_task (dashboard):   Dynamo R on sessions, R/W on api-keys,
//                                   KMS for SSE. No Bedrock.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

// ===========================================================================
// Task execution role — used by ECS itself to start the task.
// ===========================================================================
resource "aws_iam_role" "task_exec" {
  name = "${local.name_prefix}-task-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "task_exec_managed" {
  role       = aws_iam_role.task_exec.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

// Allow task_exec to read the Secrets Manager entries the task defs
// reference. The managed policy above covers ECR + CloudWatch but NOT
// Secrets Manager, so we attach an inline scoped policy below.
data "aws_iam_policy_document" "task_exec_secrets" {
  statement {
    sid       = "ReadDreddSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for s in aws_secretsmanager_secret.dredd : s.arn]
  }

  // Decrypt the Secrets Manager AWS-managed key when fetching values.
  statement {
    sid       = "DecryptSecretsManagerKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.primary_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "task_exec_secrets" {
  name   = "${local.name_prefix}-task-exec-secrets"
  policy = data.aws_iam_policy_document.task_exec_secrets.json
}

resource "aws_iam_role_policy_attachment" "task_exec_secrets" {
  role       = aws_iam_role.task_exec.name
  policy_arn = aws_iam_policy.task_exec_secrets.arn
}

// ===========================================================================
// Hook task role — runtime permissions for the hook container.
// ===========================================================================
resource "aws_iam_role" "hook_task" {
  name = "${local.name_prefix}-hook-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

data "aws_iam_policy_document" "hook_task" {
  statement {
    sid    = "SessionsTableReadWrite"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:BatchGetItem",
    ]
    resources = [
      aws_dynamodb_table.jaid_sessions.arn,
      "${aws_dynamodb_table.jaid_sessions.arn}/index/gsi1",
    ]
  }

  // Hook reads api-keys to authenticate inbound calls. Only Get/Query;
  // CRUD on api-keys is done by the dashboard.
  statement {
    sid    = "ApiKeysTableRead"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
    ]
    resources = [
      aws_dynamodb_table.jaid_api_keys.arn,
      "${aws_dynamodb_table.jaid_api_keys.arn}/index/gsi1",
    ]
  }

  // Hook reads + writes approvals: lookup on every PreToolUse (read),
  // upsert when a user accepts an "ask" prompt (UpdateItem), touch
  // lastUsedAt on each hit (UpdateItem). No revoke from the hook —
  // that's a dashboard-only operation.
  statement {
    sid    = "ApprovalsTableReadWrite"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [
      aws_dynamodb_table.jaid_approvals.arn,
      "${aws_dynamodb_table.jaid_approvals.arn}/index/gsi1",
    ]
  }

  // Hook reads + writes user-permissions: GetItem on every /intent to
  // see if the uploaded hash matches the stored snapshot, PutItem when
  // the hook ships a full payload (hash change / heartbeat). No
  // DeleteItem — TTL ages out abandoned (user, project) rows.
  statement {
    sid    = "UserPermissionsTableReadWrite"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [
      aws_dynamodb_table.jaid_user_permissions.arn,
    ]
  }

  // Bedrock — judge model + embedding model. Scoped to inference
  // profiles + foundation models in any region (cross-region inference
  // profiles can route to multiple regions, so we don't pin to one).
  statement {
    sid    = "BedrockInvoke"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:bedrock:*::foundation-model/*",
      "arn:${data.aws_partition.current.partition}:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*",
    ]
  }

  // KMS for the SSE CMK, scoped via the dynamodb service condition so
  // the key can only be used through Dynamo (not arbitrary decrypts).
  // Skipped if no CMK was configured (var.sse_kms_key_arn == "").
  dynamic "statement" {
    for_each = var.sse_kms_key_arn != "" ? [1] : []
    content {
      sid    = "KmsForDynamoSSE"
      effect = "Allow"
      actions = [
        "kms:Decrypt",
        "kms:Encrypt",
        "kms:GenerateDataKey",
        "kms:DescribeKey",
      ]
      resources = [var.sse_kms_key_arn]
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["dynamodb.${local.tables_region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_policy" "hook_task" {
  name   = "${local.name_prefix}-hook-task"
  policy = data.aws_iam_policy_document.hook_task.json
}

resource "aws_iam_role_policy_attachment" "hook_task" {
  role       = aws_iam_role.hook_task.name
  policy_arn = aws_iam_policy.hook_task.arn
}

// ===========================================================================
// Dashboard task role — runtime permissions for the dashboard container.
// ===========================================================================
resource "aws_iam_role" "dashboard_task" {
  name = "${local.name_prefix}-dashboard-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

data "aws_iam_policy_document" "dashboard_task" {
  // Dashboard lists + reads sessions; doesn't write.
  statement {
    sid    = "SessionsTableRead"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
    ]
    resources = [
      aws_dynamodb_table.jaid_sessions.arn,
      "${aws_dynamodb_table.jaid_sessions.arn}/index/gsi1",
    ]
  }

  // Dashboard mints, lists, revokes API keys. Scan is required for the
  // admin "all users' keys" view in /api/keys — without it, admins fall
  // back to listByOwner and only see their own keys.
  statement {
    sid    = "ApiKeysTableReadWrite"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    ]
    resources = [
      aws_dynamodb_table.jaid_api_keys.arn,
      "${aws_dynamodb_table.jaid_api_keys.arn}/index/gsi1",
    ]
  }

  // Dashboard lists, inspects, and revokes user approvals. Scan for the
  // admin "all approvals" view; UpdateItem for soft-revoke (the revoke
  // path sets revokedAt and removes the GSI1 keys atomically).
  statement {
    sid    = "ApprovalsTableReadRevoke"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:UpdateItem",
    ]
    resources = [
      aws_dynamodb_table.jaid_approvals.arn,
      "${aws_dynamodb_table.jaid_approvals.arn}/index/gsi1",
    ]
  }

  // Dashboard reads user-permissions for Phase 5 surfacing (session
  // detail "User Permissions" section, admin "all users' policies"
  // view). Read-only — the dashboard never edits the user's local
  // settings.json; the hook is the only writer.
  statement {
    sid    = "UserPermissionsTableRead"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
    ]
    resources = [
      aws_dynamodb_table.jaid_user_permissions.arn,
    ]
  }

  dynamic "statement" {
    for_each = var.sse_kms_key_arn != "" ? [1] : []
    content {
      sid    = "KmsForDynamoSSE"
      effect = "Allow"
      actions = [
        "kms:Decrypt",
        "kms:Encrypt",
        "kms:GenerateDataKey",
        "kms:DescribeKey",
      ]
      resources = [var.sse_kms_key_arn]
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["dynamodb.${local.tables_region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_policy" "dashboard_task" {
  name   = "${local.name_prefix}-dashboard-task"
  policy = data.aws_iam_policy_document.dashboard_task.json
}

resource "aws_iam_role_policy_attachment" "dashboard_task" {
  role       = aws_iam_role.dashboard_task.name
  policy_arn = aws_iam_policy.dashboard_task.arn
}
