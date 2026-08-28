# Data sources that survived the 2026-08-28 compute-tier decommission.
# They were declared in iam.tf (now in decommissioned-2026-08-28/) but the
# KEPT alb-access-logs bucket policy still interpolates them.
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
