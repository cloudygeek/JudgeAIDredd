# Dedicated KMS key for BYOT (bring-your-own-token). Used ONLY by the
# application layer (src/byot/byot-crypto.ts → KmsByotCrypto) to encrypt /
# decrypt the per-user Bedrock bearer tokens stored in jaid-byot.
#
# Deliberately separate from var.sse_kms_key_arn (which drives DynamoDB
# table SSE): enabling real BYOT token encryption must NOT change the
# at-rest encryption of the existing hot-path tables (jaid-sessions, etc.).
# The jaid-byot table itself keeps its default SSE — the sensitive field
# (the token) is already KMS-encrypted at the app layer before it is stored.
#
# Default key policy (account root + IAM-governed): the dashboard task role
# is granted kms:Encrypt and the hook task role kms:Decrypt via their IAM
# policies (see iam.tf, KmsEncryptByotToken / KmsDecryptByotToken). No
# custom key policy is required.
resource "aws_kms_key" "byot" {
  description             = "JAID BYOT per-user Bedrock token encryption (app-layer KmsByotCrypto)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "byot" {
  name          = "alias/jaid-byot"
  target_key_id = aws_kms_key.byot.key_id
}
