# Terraform — DynamoDB tables

Terraform definitions for the two DynamoDB tables backing Judge AI Dredd.
These files **describe the currently-live tables** in account
`621978938576`, eu-west-1 — they are not the source-of-truth that created
them (both tables were created manually ahead of this file being added).
Running `terraform apply` against the live tables would be a no-op
(`terraform import` the existing state first; don't `apply` against a
dirty workspace).

## Tables

| Table | Purpose | File |
|---|---|---|
| `jaid-sessions` | Per-session state for the hook container (Dynamo-backed `SessionStore`). 30-day TTL on `ttl` attribute. | `jaid-sessions.tf` |
| `jaid-api-keys` | Hook API keys. Plaintext never stored — only the SHA-256 hash. 90-day TTL on `ttl`, set only on revoked keys. | `jaid-api-keys.tf` |

Both tables share the same shape:
- Composite primary key (`pk`, `sk`) — both String.
- Single GSI `gsi1` over (`gsi1pk`, `gsi1sk`).
- Billing mode `PAY_PER_REQUEST` (no provisioned capacity to tune).
- SSE with KMS customer-managed key (the CKO-provided CMK shared across
  both tables).
- Point-in-time recovery enabled (35-day restore window).
- Deletion protection enabled.
- TTL attribute `ttl` (epoch seconds).

## Ownership

**These tables were provisioned outside this repo** (manual AWS Console
creation during the Dynamo migration). This Terraform exists as
documentation + a path to IaC-ownership later. To move to full
Terraform ownership:

```
terraform init
terraform import aws_dynamodb_table.jaid_sessions jaid-sessions
terraform import aws_dynamodb_table.jaid_api_keys jaid-api-keys
terraform plan   # should show zero changes
```

If `plan` is non-empty after import, the live tables drifted from this
file — reconcile before applying.

## KMS key

The SSE key (`arn:aws:kms:eu-west-1:621978938576:key/7cddb0d2-682a-4750-b05b-330a1f646487`)
is managed by CKO's platform team, not this repo. We reference it by
ARN only.

## Backend

No backend configured yet — `terraform.tfstate` lives locally. Move to
an S3 backend with DynamoDB locking before more than one person owns
this.
