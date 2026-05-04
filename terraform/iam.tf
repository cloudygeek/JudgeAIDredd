// IAM policy snippet for the Fargate task role.
//
// This is a documentation artefact — the actual sandbox task role lives
// in the CKO AI Sandbox platform's IaC, not here. Attach the equivalent
// of this policy to whichever role the `judge-ai-dredd-interactive` and
// `judge-ai-dredd` Fargate services assume.
//
// Scoped tightly: only the two tables and their GSIs, only the actions
// the app actually issues. No Scan, no DeleteTable, no UpdateTable.
data "aws_iam_policy_document" "jaid_dynamodb_access" {
  statement {
    sid    = "SessionStoreReadWrite"
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

  statement {
    sid    = "ApiKeyStoreReadWrite"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    ]
    resources = [
      aws_dynamodb_table.jaid_api_keys.arn,
      "${aws_dynamodb_table.jaid_api_keys.arn}/index/gsi1",
    ]
  }

  // Allow the task role to use the KMS CMK for SSE reads/writes. The
  // CMK is managed by the CKO platform team; this statement just asks
  // permission to use it against our two tables.
  statement {
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
      values   = ["dynamodb.eu-west-1.amazonaws.com"]
    }
  }
}

output "task_role_policy_json" {
  description = "JSON policy doc to attach to the Fargate task role."
  value       = data.aws_iam_policy_document.jaid_dynamodb_access.json
}
