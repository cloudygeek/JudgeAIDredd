#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — build, push, register, and optionally run the Test 7 Fargate task
#
# Prerequisites:
#   - aws CLI configured with credentials for your account
#   - docker installed and running
#   - An ECS cluster already exists (or will be created)
#
# One-time setup: run with --setup to create IAM roles, ECR repo, and S3 bucket
# Subsequent runs: run without flags to build + push + register + run
#
# Usage:
#   ./fargate/infra/deploy.sh --setup            # First time only
#   ./fargate/infra/deploy.sh                    # Build, push, register, run
#   ./fargate/infra/deploy.sh --parallel         # Launch one task per model
#   ./fargate/infra/deploy.sh --register-only    # Register task def, don't run
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config — edit these ───────────────────────────────────────────────────────
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGION="eu-west-2"
ECR_REPO="judge-ai-dredd-test7"
CLUSTER="judge-ai-dredd"
RESULTS_BUCKET="judge-ai-dredd-results-${ACCOUNT_ID}"
ANTHROPIC_SECRET_NAME="judge-ai-dredd/anthropic-api-key"

# Subnet and security group for the Fargate task (must have outbound internet access)
# Edit these to match your VPC — or pass as env vars.
SUBNET_ID="${SUBNET_ID:-}"
SECURITY_GROUP_ID="${SECURITY_GROUP_ID:-}"

TASK_ROLE_NAME="judge-ai-dredd-task-role"
EXECUTION_ROLE_NAME="judge-ai-dredd-execution-role"
IMAGE_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:latest"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── Parse args ────────────────────────────────────────────────────────────────
SETUP=false
PARALLEL=false
REGISTER_ONLY=false

for arg in "$@"; do
    case "${arg}" in
        --setup)          SETUP=true ;;
        --parallel)       PARALLEL=true ;;
        --register-only)  REGISTER_ONLY=true ;;
    esac
done

# ── Helper ────────────────────────────────────────────────────────────────────
step() { echo ""; echo "──── $* ────"; }

# ═══════════════════════════════════════════════════════════════════════════════
# ONE-TIME SETUP
# ═══════════════════════════════════════════════════════════════════════════════
if [ "${SETUP}" = "true" ]; then
    step "Creating S3 results bucket: ${RESULTS_BUCKET}"
    aws s3api create-bucket \
        --bucket "${RESULTS_BUCKET}" \
        --region "${REGION}" \
        --create-bucket-configuration LocationConstraint="${REGION}" \
        2>/dev/null || echo "(bucket already exists)"

    # Block public access
    aws s3api put-public-access-block \
        --bucket "${RESULTS_BUCKET}" \
        --public-access-block-configuration \
          BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

    step "Storing Anthropic API key in Secrets Manager"
    if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
        echo "ERROR: set ANTHROPIC_API_KEY env var before running --setup"
        exit 1
    fi
    aws secretsmanager create-secret \
        --name "${ANTHROPIC_SECRET_NAME}" \
        --region "${REGION}" \
        --secret-string "${ANTHROPIC_API_KEY}" \
        2>/dev/null || \
    aws secretsmanager put-secret-value \
        --secret-id "${ANTHROPIC_SECRET_NAME}" \
        --region "${REGION}" \
        --secret-string "${ANTHROPIC_API_KEY}"

    step "Creating ECR repository: ${ECR_REPO}"
    aws ecr create-repository \
        --repository-name "${ECR_REPO}" \
        --region "${REGION}" \
        2>/dev/null || echo "(repository already exists)"

    step "Creating ECS cluster: ${CLUSTER}"
    aws ecs create-cluster \
        --cluster-name "${CLUSTER}" \
        --capacity-providers FARGATE \
        --region "${REGION}" \
        2>/dev/null || echo "(cluster already exists)"

    step "Creating IAM task role: ${TASK_ROLE_NAME}"
    TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
    aws iam create-role \
        --role-name "${TASK_ROLE_NAME}" \
        --assume-role-policy-document "${TRUST}" \
        2>/dev/null || echo "(task role already exists)"

    # Substitute bucket name in the policy
    TASK_POLICY=$(sed "s|<YOUR_RESULTS_BUCKET>|${RESULTS_BUCKET}|g" \
        "${SCRIPT_DIR}/iam-task-policy.json" | \
        sed "s|<ACCOUNT_ID>|${ACCOUNT_ID}|g")
    aws iam put-role-policy \
        --role-name "${TASK_ROLE_NAME}" \
        --policy-name "judge-ai-dredd-task-policy" \
        --policy-document "${TASK_POLICY}"

    step "Creating IAM execution role: ${EXECUTION_ROLE_NAME}"
    aws iam create-role \
        --role-name "${EXECUTION_ROLE_NAME}" \
        --assume-role-policy-document "${TRUST}" \
        2>/dev/null || echo "(execution role already exists)"

    aws iam attach-role-policy \
        --role-name "${EXECUTION_ROLE_NAME}" \
        --policy-arn "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"

    EXEC_POLICY=$(sed "s|<ACCOUNT_ID>|${ACCOUNT_ID}|g" \
        "${SCRIPT_DIR}/iam-execution-policy.json")
    aws iam put-role-policy \
        --role-name "${EXECUTION_ROLE_NAME}" \
        --policy-name "judge-ai-dredd-execution-policy" \
        --policy-document "${EXEC_POLICY}"

    echo ""
    echo "Setup complete."
    echo "Next: run ./fargate/infra/deploy.sh (without --setup) to build and run."
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════════
# BUILD + PUSH
# ═══════════════════════════════════════════════════════════════════════════════
step "Authenticating Docker to ECR"
aws ecr get-login-password --region "${REGION}" \
    | docker login --username AWS --password-stdin \
      "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

step "Building Docker image (context: ${PROJECT_ROOT})"
docker build \
    -f "${PROJECT_ROOT}/fargate/Dockerfile" \
    -t "${ECR_REPO}:latest" \
    "${PROJECT_ROOT}"

step "Tagging and pushing to ECR"
docker tag "${ECR_REPO}:latest" "${IMAGE_URI}"
docker push "${IMAGE_URI}"

# ═══════════════════════════════════════════════════════════════════════════════
# REGISTER TASK DEFINITION
# ═══════════════════════════════════════════════════════════════════════════════
step "Registering task definition"

TASK_DEF=$(sed \
    -e "s|<ACCOUNT_ID>|${ACCOUNT_ID}|g" \
    -e "s|<YOUR_RESULTS_BUCKET>|${RESULTS_BUCKET}|g" \
    "${SCRIPT_DIR}/task-definition.json")

TASK_DEF_ARN=$(echo "${TASK_DEF}" | \
    aws ecs register-task-definition \
        --region "${REGION}" \
        --cli-input-json /dev/stdin \
        --query "taskDefinition.taskDefinitionArn" \
        --output text)

echo "Registered: ${TASK_DEF_ARN}"

[ "${REGISTER_ONLY}" = "true" ] && echo "Done (--register-only)." && exit 0

# ═══════════════════════════════════════════════════════════════════════════════
# RUN TASK(S)
# ═══════════════════════════════════════════════════════════════════════════════
if [ -z "${SUBNET_ID}" ] || [ -z "${SECURITY_GROUP_ID}" ]; then
    echo ""
    echo "ERROR: Set SUBNET_ID and SECURITY_GROUP_ID before running tasks."
    echo "  The subnet must have outbound internet access (NAT gateway or public subnet)."
    echo "  The security group needs no inbound rules; allow all outbound."
    echo ""
    echo "  SUBNET_ID=subnet-xxx SECURITY_GROUP_ID=sg-xxx ./fargate/infra/deploy.sh"
    exit 1
fi

run_task() {
    local overrides="$1"
    local label="$2"

    step "Launching Fargate task: ${label}"
    TASK_ARN=$(aws ecs run-task \
        --cluster "${CLUSTER}" \
        --task-definition "${TASK_DEF_ARN}" \
        --launch-type FARGATE \
        --region "${REGION}" \
        --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_ID}],securityGroups=[${SECURITY_GROUP_ID}],assignPublicIp=ENABLED}" \
        --overrides "${overrides}" \
        --query "tasks[0].taskArn" \
        --output text)
    echo "  Task ARN: ${TASK_ARN}"
    echo "  Logs:     https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#logsV2:log-groups/log-group/\$252Fecs\$252Fjudge-ai-dredd\$252Ftest7"
}

if [ "${PARALLEL}" = "true" ]; then
    # One task per model — runs all three in parallel, ~4h instead of ~12h
    RUN_ID="test7-$(date -u +%Y%m%dT%H%M%SZ)"

    for model in "claude-haiku-4-5" "claude-sonnet-4-6" "claude-opus-4-6"; do
        OVERRIDES=$(cat <<EOF
{
  "containerOverrides": [{
    "name": "test7",
    "environment": [
      {"name": "TEST7_MODELS",  "value": "${model}"},
      {"name": "TEST7_RUN_ID",  "value": "${RUN_ID}"}
    ]
  }]
}
EOF
)
        run_task "${OVERRIDES}" "${model}"
    done

    echo ""
    echo "All 3 tasks launched. Results will appear at:"
    echo "  s3://${RESULTS_BUCKET}/test7/${RUN_ID}/"

else
    # Single task — runs all 240 combinations sequentially (~12h)
    run_task '{"containerOverrides":[]}' "all-models (sequential)"
fi
