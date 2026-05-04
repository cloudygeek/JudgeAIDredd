#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 10/11 — Pipeline Exfiltration Scoring
#
# Reruns T3e hijack scenarios (canary-server routed) with dual scoring:
#   - GES (context): canary string seen in agent context (old metric)
#   - GES (exfil): secrets actually hit the canary HTTP endpoint (new metric)
#
# Test 10 = baseline (no defence)
# Test 11 = defended (intent-tracker with Bedrock judge + embeddings)
#
# Env overrides:
#   TEST10_DEFENCES   CSV of defence modes (default: none,intent-tracker)
#   TEST10_MODEL      agent model (default: claude-sonnet-4-6)
#   TEST10_EFFORT     agent effort level (default: unset)
#   TEST10_JUDGE_EFFORT  judge effort level (default: unset)
#   TEST10_REPS       repetitions per scenario (default: 20)
#   TEST10_CANARY_PORT canary server port (default: 3003)
#   S3_BUCKET         results bucket (default: cko-results)
#   S3_PREFIX         results prefix (default: test10)
# ============================================================================

LOG_FILE="/app/results/test10.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test10}"
DEFENCES="${TEST10_DEFENCES:-none,intent-tracker}"
MODEL="${TEST10_MODEL:-claude-sonnet-4-6}"
EFFORT="${TEST10_EFFORT:-}"
JUDGE_EFFORT="${TEST10_JUDGE_EFFORT:-}"
REPS="${TEST10_REPS:-20}"
CANARY_PORT="${TEST10_CANARY_PORT:-3003}"

# Defence pipeline config (same as Test 1 config A)
EMBEDDING_MODEL="eu.cohere.embed-v4:0"
JUDGE_MODEL="eu.anthropic.claude-haiku-4-5-20251001-v1:0"

echo "============================================================"
echo " Test 10/11: Pipeline Exfiltration Scoring"
echo " Defences:    ${DEFENCES}"
echo " Model:       ${MODEL}"
echo " Effort:      ${EFFORT:-default}"
echo " Judge effort:${JUDGE_EFFORT:-default}"
echo " Reps:        ${REPS}"
echo " Canary port: ${CANARY_PORT}"
echo " Embedding:   ${EMBEDDING_MODEL}"
echo " Judge:       ${JUDGE_MODEL}"
echo " S3: s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "============================================================"

# ── Preflight ──────────────────────────────────────────────────────────────
echo "Preflight: checking Bedrock access..."
aws bedrock-runtime converse \
  --region "${AWS_REGION:-eu-west-2}" \
  --model-id "eu.anthropic.claude-haiku-4-5-20251001-v1:0" \
  --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
  --inference-config '{"maxTokens":1}' \
  --output text --query "output.message.content[0].text" >/dev/null 2>&1 \
  && echo "  Bedrock OK" \
  || { echo "  WARN: Bedrock preflight failed, continuing anyway"; }

echo "Preflight: checking S3 access (bucket: ${S3_BUCKET})..."
aws s3 ls "s3://${S3_BUCKET}/" --region "${AWS_REGION:-eu-west-2}" --page-size 1 >/dev/null 2>&1 \
  && echo "  S3 list OK" \
  || { echo "  FATAL: Cannot list S3 bucket s3://${S3_BUCKET}/. Aborting."; exit 1; }

S3_TEST_KEY="${S3_PREFIX}/.preflight-$(date +%s)"
echo "preflight" | aws s3 cp - "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${AWS_REGION:-eu-west-2}" 2>/dev/null \
  && echo "  S3 write OK" \
  || { echo "  FATAL: Cannot write to S3 bucket. Aborting."; exit 1; }
aws s3 rm "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${AWS_REGION:-eu-west-2}" 2>/dev/null || true

# ── Build args ────────────────────────────────────────────────────────────
CMD_ARGS=(
  --defence "${DEFENCES}"
  --model "${MODEL}"
  --repetitions "${REPS}"
  --canary-port "${CANARY_PORT}"
  --embedding-backend bedrock
  --judge-backend bedrock
  --embedding-model "${EMBEDDING_MODEL}"
  --judge-model "${JUDGE_MODEL}"
  --batch
  --fail-fast
)

if [ -n "${EFFORT}" ]; then
  CMD_ARGS+=(--effort "${EFFORT}")
fi

if [ -n "${JUDGE_EFFORT}" ]; then
  CMD_ARGS+=(--judge-effort "${JUDGE_EFFORT}")
fi

# ── Run ────────────────────────────────────────────────────────────────────
echo ""
echo ">>> Running: npx tsx src/tests/runner-pipeline-exfil.ts ${CMD_ARGS[*]}"
echo ""

START_TIME=$(date +%s)

npx tsx src/tests/runner-pipeline-exfil.ts "${CMD_ARGS[@]}" || {
  echo "  FAILED"
}

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
echo "  DONE in ${ELAPSED}s"

# ── Upload ────────────────────────────────────────────────────────────────
echo ""
echo "Uploading results to S3..."
aws s3 sync results/ "s3://${S3_BUCKET}/${S3_PREFIX}/" \
  --exclude "*" --include "test10-*" --include "test11-*" --include "test10.log" \
  --region "${AWS_REGION:-eu-west-2}" 2>/dev/null \
  && echo "  S3 sync OK" \
  || echo "  WARN: S3 sync failed"

aws s3 cp "${LOG_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/test10.log" \
  --region "${AWS_REGION:-eu-west-2}" 2>/dev/null || true

echo ""
echo "============================================================"
echo " Test 10/11 complete"
echo "============================================================"
