// ===========================================================================
// Identity / region
// ===========================================================================
variable "project" {
  description = "Resource name prefix. All resources get tagged Project=this."
  type        = string
  default     = "judge-ai-dredd"
}

variable "environment" {
  description = "Environment slug used in resource names (e.g. prod, staging, dev)."
  type        = string
  default     = "prod"
}

variable "primary_region" {
  description = "AWS region for VPC, ECS, ECR, ALB, CloudWatch logs, Secrets Manager."
  type        = string
  default     = "eu-west-1"
}

variable "bedrock_region" {
  description = "AWS region for Bedrock InvokeModel calls. Often differs from primary_region because Bedrock model availability is regional."
  type        = string
  default     = "eu-west-2"
}

variable "tables_region" {
  description = "Region the DynamoDB tables live in. Defaults to primary_region."
  type        = string
  default     = null
}

// ===========================================================================
// Networking — reuse the existing cloudRisk VPC + its NAT gateway.
//
// Defaults below are pre-filled for the cloudRisk VPC in account
// 110745800154 (eu-west-1). Override if you're deploying into a
// different VPC, or set existing_vpc_id="" to make this terraform fail
// loudly so you don't accidentally land Dredd in cloudRisk by default.
// ===========================================================================
variable "existing_vpc_id" {
  description = "VPC to deploy into. Default = the cloudRisk VPC (172.20.0.0/16), reusing its NAT gateway."
  type        = string
  default     = "vpc-05460c5378a13ddd8"
}

variable "existing_public_subnet_ids" {
  description = "Existing public subnets the ALB can use. Combined with the new public subnet created below when alb_internet_facing=true."
  type        = list(string)
  default     = ["subnet-0cbb7342f61c9b8ce"] // cloudRisk 1a public
}

variable "existing_private_subnet_ids" {
  description = "Existing private subnets the Fargate tasks land in. ECS picks one per task; single-AZ deployment for no-HA mode."
  type        = list(string)
  default     = ["subnet-0074a7bdcd03efb32"] // cloudRisk 1a private
}

variable "existing_public_route_table_id" {
  description = "Public route table the new public subnet associates with — must already route 0.0.0.0/0 to an IGW."
  type        = string
  default     = "rtb-0dc68af7555c13eb0" // cloudRisk public RT (has IGW route)
}

variable "new_public_subnet_cidr" {
  description = "CIDR for the additional public subnet created in this stack (ALB needs ≥2 AZs; cloudRisk only ships one public subnet)."
  type        = string
  default     = "172.20.144.0/28"
}

variable "new_public_subnet_az" {
  description = "AZ for the additional public subnet. Must differ from the AZ of the existing public subnet."
  type        = string
  default     = "eu-west-1b"
}

variable "alb_internet_facing" {
  description = "If true, ALB is internet-facing and uses public subnets (existing + new). If false, ALB is internal and uses private subnets only — no new public subnet is created."
  type        = bool
  default     = true
}

// ===========================================================================
// DNS / TLS
// ===========================================================================
variable "route53_zone_id" {
  description = "Existing Route53 hosted zone ID that owns hook_host and dashboard_host. ACM cert is DNS-validated against this zone."
  type        = string
}

variable "hook_host" {
  description = "FQDN the hook service answers on (e.g. dredd-hook.example.com)."
  type        = string
}

variable "dashboard_host" {
  description = "FQDN the dashboard service answers on (e.g. dredd.example.com)."
  type        = string
}

// ===========================================================================
// DynamoDB tables
// ===========================================================================
variable "sessions_table_name" {
  description = "Name of the per-session-state Dynamo table."
  type        = string
  default     = "jaid-sessions"
}

variable "api_keys_table_name" {
  description = "Name of the API-keys Dynamo table."
  type        = string
  default     = "jaid-api-keys"
}

variable "approvals_table_name" {
  description = "Name of the user-approvals Dynamo table (interactive-mode learning)."
  type        = string
  default     = "jaid-approvals"
}

variable "user_permissions_table_name" {
  description = "Name of the per-(user, project) user-permissions Dynamo table — holds the user's Claude Code allow/deny/ask lists uploaded by the hook."
  type        = string
  default     = "jaid-user-permissions"
}

variable "sse_kms_key_arn" {
  description = "Optional customer-managed KMS CMK for DynamoDB SSE. Empty string = use AWS-owned key."
  type        = string
  default     = ""
}

// ===========================================================================
// ECR / image config
// ===========================================================================
variable "ecr_image_tag_mutability" {
  description = "MUTABLE allows overwriting tags (latest); IMMUTABLE forces a fresh tag per push."
  type        = string
  default     = "MUTABLE"
}

variable "image_tag" {
  description = "ECR image tag the ECS task definitions reference."
  type        = string
  default     = "latest"
}

// ===========================================================================
// ECS / task sizing — single-replica, no-HA defaults.
// ===========================================================================
variable "hook_cpu" {
  description = "Fargate CPU units for the hook task (1024 = 1 vCPU)."
  type        = number
  default     = 1024
}

variable "hook_memory" {
  description = "Fargate memory MiB for the hook task."
  type        = number
  default     = 2048
}

variable "dashboard_cpu" {
  description = "Fargate CPU units for the dashboard task."
  type        = number
  default     = 512
}

variable "dashboard_memory" {
  description = "Fargate memory MiB for the dashboard task."
  type        = number
  default     = 1024
}

variable "hook_desired_count" {
  description = "Number of hook task replicas. Default 1 (no HA). Set to 0 for the first apply if images aren't pushed yet."
  type        = number
  default     = 1
}

variable "dashboard_desired_count" {
  description = "Number of dashboard task replicas. Default 1 (no HA)."
  type        = number
  default     = 1
}

// ===========================================================================
// Dredd runtime config (turns into ECS container env vars)
// ===========================================================================
variable "dredd_mode" {
  description = "Initial trust mode: interactive / autonomous / learn."
  type        = string
  default     = "interactive"
  validation {
    condition     = contains(["interactive", "autonomous", "learn"], var.dredd_mode)
    error_message = "dredd_mode must be one of: interactive, autonomous, learn."
  }
}

variable "dredd_auth_mode" {
  description = "Hook Bearer-API-key enforcement: off / optional / required."
  type        = string
  default     = "required"
  validation {
    condition     = contains(["off", "optional", "required"], var.dredd_auth_mode)
    error_message = "dredd_auth_mode must be one of: off, optional, required."
  }
}

variable "judge_model" {
  description = "Bedrock model ID used by the LLM judge."
  type        = string
  default     = "eu.anthropic.claude-sonnet-4-6"
}

variable "embedding_model" {
  description = "Bedrock embedding model ID."
  type        = string
  default     = "eu.cohere.embed-v4:0"
}

variable "hardened" {
  description = "Judge prompt variant: B7 / B7.1 / B7.1-office / standard."
  type        = string
  default     = "B7.1"
}

// ===========================================================================
// CloudWatch
// ===========================================================================
variable "log_retention_days" {
  description = "CloudWatch Logs retention."
  type        = number
  default     = 30
}

variable "enable_container_insights" {
  description = "ECS Container Insights — useful for cluster metrics but adds ~$13/month. Off by default to keep no-HA deploys cheap."
  type        = bool
  default     = false
}

// ===========================================================================
// Locals derived from variables
// ===========================================================================
locals {
  tables_region = coalesce(var.tables_region, var.primary_region)
  name_prefix   = "${var.project}-${var.environment}"

  // Public subnets the ALB uses when internet-facing: the existing ones
  // plus the one we add (for the second AZ ALB needs).
  alb_public_subnet_ids = var.alb_internet_facing ? concat(
    var.existing_public_subnet_ids,
    [aws_subnet.alb_extra[0].id]
  ) : []

  // ALB subnets: public when internet-facing, private when internal.
  alb_subnet_ids = var.alb_internet_facing ? local.alb_public_subnet_ids : var.existing_private_subnet_ids
}
