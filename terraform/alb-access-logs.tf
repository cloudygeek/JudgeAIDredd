// ALB access logs → S3.
//
// Captures one record per request the ALB serves, including the client IP
// (the `client:port` field), the request line, target, latencies, and
// response code. This is the only place the *real* source IP is recorded
// independent of the app — the Fargate task only sees the ALB-appended
// X-Forwarded-For hop (which the app now logs + stamps onto session META;
// see src/server-core.ts getClientIp + handlers/intent.ts).
//
// Delivery requirements (AWS):
//   - The bucket must allow the regional ELB log-delivery account (for
//     regions launched before Aug 2022 — eu-west-1 included) AND/OR the
//     delivery.logs.amazonaws.com service principal to PutObject.
//   - ALB access logs support ONLY SSE-S3 (AES256). SSE-KMS with a customer
//     managed key is rejected by the delivery service, so this bucket
//     deliberately uses AES256, not the project SSE KMS key.

resource "aws_s3_bucket" "alb_logs" {
  bucket        = "${local.name_prefix}-alb-logs-${data.aws_caller_identity.current.account_id}"
  force_destroy = true // logs are reproducible; let `terraform destroy` clean up non-prod

  tags = {
    Name    = "${local.name_prefix}-alb-logs"
    Purpose = "ALB access logs - source-IP forensics"
  }
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket                  = aws_s3_bucket.alb_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    apply_server_side_encryption_by_default {
      // AES256 (SSE-S3) is the only algorithm the ALB log delivery accepts.
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    id     = "expire-access-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = var.alb_access_logs_retention_days
    }
  }
}

// Where ALB drops its objects: <prefix>/AWSLogs/<account>/elasticloadbalancing/...
locals {
  alb_logs_prefix      = "alb"
  alb_logs_account_arn = "${aws_s3_bucket.alb_logs.arn}/${local.alb_logs_prefix}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
}

data "aws_iam_policy_document" "alb_logs" {
  // 1. Regional ELB log-delivery account (pre-Aug-2022 regions, e.g.
  //    eu-west-1). Omitted automatically if the region isn't in the
  //    built-in map and no override is set.
  dynamic "statement" {
    for_each = local.elb_account_id != null ? [local.elb_account_id] : []
    content {
      sid     = "ELBRegionalAccountPutObject"
      effect  = "Allow"
      actions = ["s3:PutObject"]
      principals {
        type        = "AWS"
        identifiers = ["arn:${data.aws_partition.current.partition}:iam::${statement.value}:root"]
      }
      resources = [local.alb_logs_account_arn]
    }
  }

  // 2. Modern log-delivery service principal (newer regions + the path AWS
  //    now recommends everywhere). Requires the bucket-owner-full-control
  //    ACL on each delivered object.
  statement {
    sid     = "LogDeliveryPutObject"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }
    resources = [local.alb_logs_account_arn]
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }

  statement {
    sid     = "LogDeliveryGetBucketAcl"
    effect  = "Allow"
    actions = ["s3:GetBucketAcl"]
    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }
    resources = [aws_s3_bucket.alb_logs.arn]
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  policy = data.aws_iam_policy_document.alb_logs.json

  // Public-access-block must be in place before the policy so we never
  // briefly expose a permissive bucket.
  depends_on = [aws_s3_bucket_public_access_block.alb_logs]
}

output "alb_access_logs_bucket" {
  description = "S3 bucket holding ALB access logs (source-IP forensics)."
  value       = aws_s3_bucket.alb_logs.bucket
}
