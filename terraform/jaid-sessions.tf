// jaid-sessions — per-session state for the hook container.
//
// Single-table design keyed by SESSION#<session_id>, with sort keys for
// each kind of record (META, TURN#n, TOOL#turn#seq, FILE#W#hash,
// FILE#R#ts#seq, ENV#name, METRIC#n, PIVOT#seq). GSI1 is set only on
// META items (gsi1pk="SESSION", gsi1sk=<startedAt-iso>) so the dashboard
// can list sessions cheaply without scanning.
//
// TTL refreshed on every write, 30 days. Sessions that haven't been
// touched in 30d age out naturally.
resource "aws_dynamodb_table" "jaid_sessions" {
  name                        = "jaid-sessions"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled                 = true
    recovery_period_in_days = 35
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.sse_kms_key_arn
  }
}

output "jaid_sessions_arn" {
  value = aws_dynamodb_table.jaid_sessions.arn
}

output "jaid_sessions_gsi1_arn" {
  value = "${aws_dynamodb_table.jaid_sessions.arn}/index/gsi1"
}
