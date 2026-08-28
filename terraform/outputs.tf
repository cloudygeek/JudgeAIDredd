// Outputs — most useful for plugging Dredd into other tooling.

output "jaid_sessions_arn" {
  description = "ARN of the sessions Dynamo table."
  value       = aws_dynamodb_table.jaid_sessions.arn
}

output "jaid_api_keys_arn" {
  description = "ARN of the API-keys Dynamo table."
  value       = aws_dynamodb_table.jaid_api_keys.arn
}
