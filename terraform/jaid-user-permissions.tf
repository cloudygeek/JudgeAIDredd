// jaid-user-permissions — per-(user, project) snapshot of the user's
// Claude Code allow/deny/ask lists, uploaded by the hook on
// UserPromptSubmit (see hooks/dredd-hook.sh::build_user_permissions_payload).
//
// pk          = USER#<ownerSub>
// sk          = PROJECT#<projectRootHash16>     (sha256(projectRoot) first 16 hex chars)
// hash        = SHA-256 of the canonical merged {allow,deny,ask} payload —
//               lets /intent short-circuit when the hook re-sends the same hash
// allow/deny/ask = list<string>, sorted+deduped, the merged
//               user-global / project / project-local view from the hook
// projectRoot = the un-hashed cwd string, stored for operator debugging
//               (the hashed projectRootHash16 is the index key)
// updatedAt   = ISO-8601 timestamp of last upsert
// ttl         = epoch-seconds, 90d from updatedAt, refreshed every upsert.
//               Frequently-used projects stay live; abandoned ones age out.
//
// Access patterns:
//   - GetItem(pk, sk) on every /intent — checked once per UserPromptSubmit
//   - PutItem on every /intent that ships a full payload (hash change /
//     heartbeat / first-time). Idempotent — the hook resends the same item
//     shape, so concurrent UserPromptSubmits on the same (user, project)
//     are last-write-wins but converge.
//   - Query(pk = USER#<ownerSub>) — dashboard "what permissions has this
//     user shared, across projects?" (Phase 5). No GSI needed since pk
//     scopes to a single user already.
//
// No GSI in v1. If we later want operator-wide listings ("all users that
// have allowlisted Bash(rm:*)") add a GSI keyed by rule fingerprint.
resource "aws_dynamodb_table" "jaid_user_permissions" {
  name                        = var.user_permissions_table_name
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
