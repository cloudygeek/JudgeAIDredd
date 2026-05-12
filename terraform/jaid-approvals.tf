// jaid-approvals — interactive-mode "learning" of user-approved tool calls.
//
// When Dredd returns permissionDecision="ask" and the user accepts, the
// hook role records an approval keyed by (ownerSub, projectRoot,
// fingerprintHash). The next time the same fingerprint appears in the
// same scope the three-stage pipeline short-circuits to allow.
//
// pk          = APPROVAL#<ownerSub>#<projectRootHash16>
// sk          = FP#<fingerprintHash>
// gsi1pk      = USER#<ownerSub>          — present on active rows only
// gsi1sk      = APPROVAL#<grantedAt>#<fingerprintHash>
// ttl         = epoch-seconds of expiresAt (30d from lastUsedAt; refreshed
//               on every hit, so frequently-used approvals stick around
//               while stale ones age out automatically)
//
// GSI1 powers the dashboard's "my approvals" listing — Query by USER#<sub>
// with ScanIndexForward=false returns newest-first without a FilterExpression.
// Revoked rows have GSI1 keys REMOVED so they drop off the listing immediately,
// then age out via a shorter ttl (1d) for audit.
resource "aws_dynamodb_table" "jaid_approvals" {
  name                        = var.approvals_table_name
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

  dynamic "server_side_encryption" {
    for_each = var.sse_kms_key_arn != "" ? [1] : []
    content {
      enabled     = true
      kms_key_arn = var.sse_kms_key_arn
    }
  }
}
