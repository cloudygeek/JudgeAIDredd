// jaid-byot — per-user BYOT (bring-your-own-token) configuration.
//
// Stores one KMS-encrypted Amazon Bedrock bearer API key per Clerk user,
// along with the target region and a status field for runtime-fallback
// tracking. One row per ownerSub (no TTL — config persists until the user
// deletes it via the dashboard DELETE /api/byot).
//
// pk   = USER#<ownerSub>
// sk   = BYOT
//
// Access patterns:
//   - GetItem(pk, sk) on every /evaluate when DREDD_BYOT_ENABLED=true
//     (via the BearerCredentialProvider in-process cache — only on cache miss)
//   - PutItem from the dashboard when the user saves a new token
//   - DeleteItem from the dashboard when the user revokes their token
//   - UpdateItem from the hook when a runtime auth failure is recorded
//     (sets status="runtime-fallback", lastFallbackAt, lastFallbackReason)
//
// No GSI in v1 — all access is by ownerSub, which is the pk.
// No TTL — rows are removed only by explicit user action (DELETE /api/byot).
resource "aws_dynamodb_table" "jaid_byot" {
  name                        = var.byot_table_name
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
