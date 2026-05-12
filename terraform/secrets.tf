// Secrets Manager entries for the runtime config that shouldn't live in
// terraform state or task-definition env vars.
//
// Terraform creates the secret *envelopes* (so the task definition's
// `secrets[]` can reference them by ARN) but deliberately does NOT
// populate the values. Filling them is a separate step:
//
//   aws secretsmanager put-secret-value \
//     --secret-id judge-ai-dredd/prod/clerk-secret-key \
//     --secret-string "sk_live_..."
//
// Until you populate them, ECS will fail to start the task with
// "ResourceInitializationError: unable to pull secrets" — that's the
// signal to go fill them in.

locals {
  // Keep the SET separate from the map so we can iterate cleanly.
  secret_keys = toset([
    "clerk-secret-key",      // dashboard only — server-side JWT verification
    "clerk-publishable-key", // both — injected into HTML for the browser SDK
    "clerk-jwt-public-key",  // dashboard only, OPTIONAL — pre-fetched JWKS to avoid egress to Clerk
  ])
}

resource "aws_secretsmanager_secret" "dredd" {
  for_each = local.secret_keys

  name        = "${local.name_prefix}/${each.value}"
  description = "${each.value} for ${local.name_prefix}"

  // Retention so an accidental destroy is recoverable for a week.
  recovery_window_in_days = 7
}

// Convenience: a single placeholder version for each secret so the
// console doesn't show "no value set" until the operator runs the
// put-secret-value command above. The placeholder is intentionally
// invalid so the app fails loudly rather than running with empty creds.
resource "aws_secretsmanager_secret_version" "placeholder" {
  for_each = aws_secretsmanager_secret.dredd

  secret_id     = each.value.id
  secret_string = "REPLACE_ME"

  // Don't keep overwriting after an operator has put a real value.
  lifecycle {
    ignore_changes = [secret_string]
  }
}
