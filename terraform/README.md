# Terraform — Judge AI Dredd infrastructure

End-to-end Terraform module that provisions everything needed to run the
Judge AI Dredd hook + dashboard services on AWS Fargate behind an ALB,
plus the DynamoDB tables and IAM they need.

Applied against a fresh AWS account, `tofu apply` will produce a
working Dredd deployment minus the container images themselves — those
get pushed to the ECR repos this module creates (see "First-apply flow"
below).

## What it creates

| Layer | Resources |
|---|---|
| Networking | **Reuses** the cloudRisk VPC (`vpc-05460c5378a13ddd8`) — IGW, NAT gateway, existing public+private subnets. Adds **one** small public subnet in 1b (`172.20.144.0/28`) so the ALB has the 2 AZs it requires |
| Security | ALB security group (443/80 from internet), task security group (ingress only from ALB) |
| Compute | ECS Fargate cluster (FARGATE + FARGATE_SPOT capacity providers); Container Insights off by default |
| Images | Two ECR repos: `judge-ai-dredd-hook`, `judge-ai-dredd-dashboard`, each with a 20-image lifecycle policy |
| IAM | Task-exec role (shared), hook task role (Dynamo R/W + Bedrock invoke + KMS), dashboard task role (Dynamo + KMS, no Bedrock) |
| Logging | Two CloudWatch log groups: `/ecs/<prefix>/hook`, `/ecs/<prefix>/dashboard`, default 30-day retention |
| Secrets | Secrets Manager placeholders for Clerk keys — operator populates values out-of-band |
| Load balancer | ALB + HTTPS listener (TLS 1.2/1.3), HTTP→HTTPS redirect, two target groups (hook with sticky sessions), host-based listener rules |
| TLS | ACM cert covering hook + dashboard hosts, DNS-validated against the supplied Route53 zone |
| DNS | Route53 A-alias records for `var.hook_host` and `var.dashboard_host` |
| Workloads | Two ECS task definitions + services (hook, dashboard) — default **1 replica each, no HA**, single-AZ (eu-west-1a) |
| Storage | `jaid-sessions`, `jaid-api-keys`, `jaid-approvals`, and `jaid-user-permissions` Dynamo tables |

What it deliberately doesn't do:

- **No VPC / NAT / IGW** — reuses the cloudRisk VPC's networking. To deploy into a different VPC, override `existing_vpc_id` / `existing_*_subnet_ids` / `existing_public_route_table_id` and provide a new public subnet CIDR in the same VPC.
- **No EFS** — session state is in Dynamo, console logs live in CloudWatch. The container's `/data` is ephemeral and gets recreated per task.
- **No KMS CMK management** — `var.sse_kms_key_arn` is optional and external. If unset, the Dynamo tables use the AWS-owned SSE key.
- **No HA** — single task replica each, single private subnet. Bump `hook_desired_count` and pass both private subnet IDs in `existing_private_subnet_ids` to get AZ redundancy.
- **No image build / push pipeline** — see "First-apply flow" for the manual steps.

## Required inputs

You must supply these as `-var` or in a `.tfvars`:

| Variable | Example | Why |
|---|---|---|
| `route53_zone_id` | `Z1ABCDEF123456` | Existing hosted zone that owns the two hostnames. ACM validates against this zone. |
| `hook_host` | `dredd-hook.example.com` | Public FQDN for the hook service. Must be inside the zone. |
| `dashboard_host` | `dredd.example.com` | Public FQDN for the dashboard. Must be inside the zone. |

Everything else has sensible defaults — see `variables.tf` for the full list.

Example `terraform.tfvars`:

```hcl
route53_zone_id = "Z1ABCDEF123456"
hook_host       = "dredd-hook.example.com"
dashboard_host  = "dredd.example.com"

# Optional overrides
environment             = "prod"
primary_region          = "eu-west-1"
bedrock_region          = "eu-west-2"
hook_desired_count      = 2
dashboard_desired_count = 1
# sse_kms_key_arn = "arn:aws:kms:eu-west-1:123456789012:key/abcd-..."
```

## First-apply flow

The first time you stand up Dredd in a fresh account, follow this
order. After that, ordinary `tofu apply` + image push is enough.

```bash
# 1. Set desired_count to 0 on the first apply so services don't fail
#    health-checks while there's no image yet.
tofu apply \
  -var hook_desired_count=0 -var dashboard_desired_count=0

# 2. Build and push the two images to the ECR repos tofu just created.
HOOK_REPO=$(tofu output -raw ecr_hook_repository_url)
DASH_REPO=$(tofu output -raw ecr_dashboard_repository_url)
REGION=$(tofu output -raw alb_dns_name | awk -F. '{print $(NF-3)}')

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${HOOK_REPO%/*}"

# From repo root:
docker build -f fargate/Dockerfile.hook-zip -t "$HOOK_REPO:latest" .
docker push "$HOOK_REPO:latest"

docker build -f fargate/Dockerfile.dashboard-zip -t "$DASH_REPO:latest" .
docker push "$DASH_REPO:latest"

# 3. Populate the Clerk secrets (values come from your Clerk dashboard).
aws secretsmanager put-secret-value \
  --secret-id "$(tofu output -json secret_arns | jq -r '."clerk-secret-key"')" \
  --secret-string "sk_live_..."

aws secretsmanager put-secret-value \
  --secret-id "$(tofu output -json secret_arns | jq -r '."clerk-publishable-key"')" \
  --secret-string "pk_live_..."

# Optional — pre-fetched JWKS for offline JWT verification:
aws secretsmanager put-secret-value \
  --secret-id "$(tofu output -json secret_arns | jq -r '."clerk-jwt-public-key"')" \
  --secret-string "-----BEGIN PUBLIC KEY-----..."

# 4. Bump desired_count to your real target.
tofu apply
```

## Existing tables collision

If `jaid-sessions` / `jaid-api-keys` already exist in the target account
(from a previous manual setup), the apply will fail on the table CREATE
because both have `deletion_protection_enabled = true`. Two ways out:

- **Side-by-side**: set `sessions_table_name = "jaid-sessions-tf"` and
  `api_keys_table_name = "jaid-api-keys-tf"` to create fresh tables under
  different names. Migrate data later.
- **Adopt the existing tables**: `tofu import` them, then `apply`
  should be a no-op:
  ```
  tofu import aws_dynamodb_table.jaid_sessions jaid-sessions
  tofu import aws_dynamodb_table.jaid_api_keys jaid-api-keys
  ```

## Backend

State lives in the `acta-terraform` S3 bucket (eu-west-1) under
`judgeaidredd/terraform.tfstate`, with native S3 locking
(`use_lockfile = true`) — no separate DynamoDB lock table needed. The
backend is wired in `versions.tf`.

If you need a separate state file for a non-prod stack, override the
key at init time:

```bash
tofu init -backend-config="key=judgeaidredd/staging/terraform.tfstate"
```

Apply requires AWS credentials that can `s3:GetObject/PutObject/DeleteObject`
on `s3://acta-terraform/judgeaidredd/*` and `s3:ListBucket` on the bucket.

## File layout

```
terraform/
├── versions.tf         Provider pin + S3 backend block
├── variables.tf        All inputs + computed locals (cloudRisk IDs as defaults)
├── outputs.tf          ARNs / URLs / ECR push targets / secret ARNs
├── vpc.tf              Extra public subnet in 1b for the ALB's 2-AZ requirement
├── security-groups.tf  ALB SG, task SG
├── ecs-cluster.tf      Fargate cluster + capacity providers
├── ecr.tf              Two ECR repos + lifecycle policies
├── iam.tf              Task-exec role, hook task role, dashboard task role
├── logs.tf             CloudWatch log groups
├── secrets.tf          Secrets Manager envelopes for Clerk keys
├── acm.tf              ACM cert + DNS validation records
├── alb.tf              ALB, listeners, target groups, host-based rules
├── dns.tf              Route53 A-aliases for hook + dashboard hosts
├── ecs-hook.tf         Hook task definition + service
├── ecs-dashboard.tf    Dashboard task definition + service
├── jaid-sessions.tf    Sessions Dynamo table
├── jaid-api-keys.tf    API-keys Dynamo table
├── jaid-approvals.tf   User-approvals Dynamo table (interactive-mode learning)
└── jaid-user-permissions.tf  Per-(user, project) Claude allow/deny/ask snapshot table
```
