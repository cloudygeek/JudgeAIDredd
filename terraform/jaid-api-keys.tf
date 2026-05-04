// jaid-api-keys — hook authentication.
//
// Stores the SHA-256 hash of each API key, never the plaintext. GSI1 is
// set only on active keys (gsi1pk="USER#<ownerSub>", gsi1sk="APIKEY#<createdAt>")
// so the dashboard's "list my keys" query returns active keys only
// without a FilterExpression. Revoke clears gsi1pk/gsi1sk and sets a
// 90-day TTL so revoked keys age out automatically.
resource "aws_dynamodb_table" "jaid_api_keys" {
  name                        = "jaid-api-keys"
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

output "jaid_api_keys_arn" {
  value = aws_dynamodb_table.jaid_api_keys.arn
}

output "jaid_api_keys_gsi1_arn" {
  value = "${aws_dynamodb_table.jaid_api_keys.arn}/index/gsi1"
}
