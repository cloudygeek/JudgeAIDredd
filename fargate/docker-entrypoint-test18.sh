#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 18 — T3e Exfiltration Under Recommended PreToolUse Pipeline
#
# Runs T3e scenarios (CanaryServer-backed exfiltration measurement) with
# the paper's recommended pipeline (Cohere v4 + prompt v2 + Haiku 4.5 judge).
#
# Env overrides:
#   TEST18_MODELS       CSV of agent models (default: claude-sonnet-4-6,claude-opus-4-7)
#   TEST18_SCENARIOS    CSV of T3e scenarios (default: T3e.2,T3e.3,T3e.4)
#   TEST18_DEFENCES     CSV of defences (default: none,intent-tracker)
#   TEST18_REPS         Reps per cell (default: 20)
#   TEST18_MAX_TURNS    Max turns per query (default: 10)
#   TEST18_AGENT_EFFORT Agent reasoning effort (default: unset)
#   S3_BUCKET           Results bucket (default: cko-results)
#   S3_PREFIX           Results prefix (default: test18)
#   AWS_REGION          Bedrock region (default: eu-central-1)
# ============================================================================

# ── Identity ──────────────────────────────────────────────────────────────
echo ">>> Caller identity:"
aws sts get-caller-identity || echo "WARNING: unable to retrieve caller identity"
echo ""

# ── Claude Code SDK prerequisites ─────────────────────────────────────────
export HOME="${HOME:-/tmp/claude-home}"
mkdir -p "${HOME}/.claude"

# ── Config ────────────────────────────────────────────────────────────────
MODELS="${TEST18_MODELS:-claude-sonnet-4-6,claude-opus-4-7}"
SCENARIOS="${TEST18_SCENARIOS:-T3e.2,T3e.3,T3e.4}"
DEFENCES="${TEST18_DEFENCES:-none,intent-tracker}"
REPS="${TEST18_REPS:-20}"
MAX_TURNS="${TEST18_MAX_TURNS:-10}"
AGENT_EFFORT="${TEST18_AGENT_EFFORT:-}"
S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test18}"
S3_REGION="${S3_REGION:-eu-west-1}"
AWS_REGION="${AWS_REGION:-eu-central-1}"

JUDGE_MODEL="eu.anthropic.claude-haiku-4-5-20251001-v1:0"
EMBED_MODEL="eu.cohere.embed-v4:0"
JUDGE_PROMPT="B7.1"

RUN_ID="${TEST18_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUTPUT_DIR="results/test18-${RUN_ID}"
LOG_FILE="results/test18-run-${RUN_ID}.log"

exec > >(tee -a "${LOG_FILE}") 2>&1

echo "════════════════════════════════════════════════════════════════════════"
echo " Test 18: T3e Exfiltration — Recommended PreToolUse Pipeline"
echo "════════════════════════════════════════════════════════════════════════"
echo " RUN_ID       : ${RUN_ID}"
echo " MODELS       : ${MODELS}"
echo " SCENARIOS    : ${SCENARIOS}"
echo " DEFENCES     : ${DEFENCES}"
echo " REPS         : ${REPS}"
echo " MAX_TURNS    : ${MAX_TURNS}"
echo " AGENT_EFFORT : ${AGENT_EFFORT:-default}"
echo " JUDGE        : ${JUDGE_MODEL}"
echo " JUDGE_PROMPT : ${JUDGE_PROMPT}"
echo " EMBED        : ${EMBED_MODEL}"
echo " BEDROCK      : ${AWS_REGION}"
echo " S3           : s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "════════════════════════════════════════════════════════════════════════"

# ── Preflight ─────────────────────────────────────────────────────────────
echo ""
echo ">>> Bedrock preflight check (region: ${AWS_REGION})..."

aws bedrock-runtime converse \
    --region "${AWS_REGION}" \
    --model-id "${JUDGE_MODEL}" \
    --messages '[{"role":"user","content":[{"text":"say ok"}]}]' \
    --inference-config '{"maxTokens":1}' \
    --output text \
    --query "output.message.content[0].text" 2>&1 >/dev/null \
    && echo "    Judge model OK: ${JUDGE_MODEL}" \
    || { echo "ERROR: Judge model not accessible"; exit 1; }

echo ""
echo ">>> S3 preflight check..."
aws s3 ls "s3://${S3_BUCKET}/" --region "${S3_REGION}" --page-size 1 >/dev/null 2>&1 \
    && echo "    S3 OK" \
    || { echo "ERROR: Cannot list S3 bucket"; exit 1; }

S3_TEST_KEY="${S3_PREFIX}/.preflight-${RUN_ID}"
echo "preflight" | aws s3 cp - "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${S3_REGION}" 2>/dev/null \
    && echo "    S3 write OK" \
    || { echo "ERROR: Cannot write to S3"; exit 1; }
aws s3 rm "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${S3_REGION}" 2>/dev/null || true

# ── Run ───────────────────────────────────────────────────────────────────
EFFORT_ARGS=()
if [ -n "${AGENT_EFFORT}" ]; then
    EFFORT_ARGS+=(--agent-effort "${AGENT_EFFORT}")
fi

export CLAUDE_CODE_USE_BEDROCK=1

npx tsx src/runner-t3e-pretooluse.ts \
    --models "${MODELS}" \
    --scenarios "${SCENARIOS}" \
    --defences "${DEFENCES}" \
    --repetitions "${REPS}" \
    --max-turns "${MAX_TURNS}" \
    --judge-model "${JUDGE_MODEL}" \
    --judge-prompt "${JUDGE_PROMPT}" \
    --embed-model "${EMBED_MODEL}" \
    --canary-port 3003 \
    --output-dir "${OUTPUT_DIR}" \
    "${EFFORT_ARGS[@]}" \
    || echo "WARN: runner exited with error"

# ── Upload results ────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo " Uploading results → s3://${S3_BUCKET}/${S3_PREFIX}/${RUN_ID}/"
echo "════════════════════════════════════════════════════════════════════════"

aws s3 sync "${OUTPUT_DIR}/" "s3://${S3_BUCKET}/${S3_PREFIX}/${RUN_ID}/" \
    --region "${S3_REGION}" \
    && echo "    Results uploaded" \
    || echo "WARNING: S3 sync failed"

aws s3 cp "${LOG_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/${RUN_ID}/$(basename "${LOG_FILE}")" \
    --region "${S3_REGION}" 2>/dev/null || true

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo " Test 18 complete — ${RUN_ID}"
echo "════════════════════════════════════════════════════════════════════════"
