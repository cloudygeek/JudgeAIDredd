variable "sse_kms_key_arn" {
  description = "KMS CMK used for table-level SSE. Currently shared with the CKO platform-managed key."
  type        = string
  default     = "arn:aws:kms:eu-west-1:621978938576:key/7cddb0d2-682a-4750-b05b-330a1f646487"
}
