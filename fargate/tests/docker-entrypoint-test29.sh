#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 29 — Stop-Hook Cross-Vendor Verification (M6 Resolution)
#
# Dispatches the Stop-hook prototype configuration (IntentTracker with
# post-turn judge) against non-Anthropic defended agents on T3.1–T3.4,
# closing out the §3.5 cross-model finding with cross-vendor evidence.
#
# Two sub-tests, toggled by TEST29_VARIANT:
#   TEST29_VARIANT=gpt4o-mini  → gpt-4o-mini-2024-07-18 via OpenAI API
#   TEST29_VARIANT=qwen3-235b  → qwen.qwen3-235b-a22b-2507-v1:0 via Bedrock Converse
#
# Each variant runs:
#   - both defence arms (none, intent-tracker)
#   - all four T3 scenarios (T3.1, T3.2, T3.3, T3.4)
#   - TEST29_REPS repetitions per cell (default: 45)
#
# Companion test plan: docs/test-plan-stophook-cross-vendor-2026-05-01.md
#
# Env overrides:
#   TEST29_VARIANT      Required — gpt4o-mini | qwen3-235b
#   TEST29_REPS         Reps per cell (default: 45)
#   TEST29_MAX_TURNS    Max turns per scenario (default: 10)
#   TEST29_DEFENCES     CSV of defence arms (default: none,intent-tracker)
#   TEST29_SCENARIOS    CSV of scenario IDs or "all" (default: all)
#
#   OPENAI_API_KEY      Required if VARIANT=gpt4o-mini
#   AWS_REGION          Bedrock region for judge/embed (default: eu-central-1)
#   AGENT_REGION        Bedrock region for Qwen agent (default: eu-central-1)
#   JUDGE_REGION        Bedrock region for judge (default: eu-central-1)
#
#   JUDGE_MODEL         Judge model (default: eu.anthropic.claude-sonnet-4-6)
#                       Matches the §3.5 cross-model Stop-hook configuration.
#   JUDGE_PROMPT        Judge prompt variant (default: standard — §3.5 baseline)
#   EMBED_MODEL         Embedding model (default: amazon.titan-embed-text-v2:0
#                       — §3.5 Stop-hook prototype used Titan v2)
#
#   S3_BUCKET           Results bucket (default: cko-results)
#   S3_PREFIX           S3 prefix (default: test29-<variant>)
#   S3_REGION           S3 region (default: eu-west-1)
# ============================================================================

# ── Identity ──────────────────────────────────────────────────────────────
echo ">>> Caller identity:"
aws sts get-caller-identity || echo "WARNING: unable to retrieve caller identity"
echo ""

# ── Config ────────────────────────────────────────────────────────────────
VARIANT="${TEST29_VARIANT:-}"
REPS="${TEST29_REPS:-45}"
MAX_TURNS="${TEST29_MAX_TURNS:-10}"
DEFENCES="${TEST29_DEFENCES:-none,intent-tracker}"
SCENARIOS="${TEST29_SCENARIOS:-all}"

AWS_REGION="${AWS_REGION:-eu-central-1}"
AGENT_REGION="${AGENT_REGION:-${AWS_REGION}}"
JUDGE_REGION="${JUDGE_REGION:-${AWS_REGION}}"
S3_REGION="${S3_REGION:-eu-west-1}"
S3_BUCKET="${S3_BUCKET:-cko-results}"

# §3.5 Stop-hook prototype baseline configuration.
JUDGE_MODEL="${JUDGE_MODEL:-eu.anthropic.claude-sonnet-4-6}"
JUDGE_PROMPT="${JUDGE_PROMPT:-standard}"
EMBED_MODEL="${EMBED_MODEL:-amazon.titan-embed-text-v2:0}"

# Resolve variant → (agent-backend, agent-model, S3 prefix)
case "${VARIANT}" in
    gpt4o-mini)
        AGENT_BACKEND="openai"
        AGENT_MODEL="gpt-4o-mini"
        S3_PREFIX_DEFAULT="test29a"
        ;;
    qwen3-235b)
        AGENT_BACKEND="converse"
        AGENT_MODEL="qwen3-235b"
        S3_PREFIX_DEFAULT="test29b"
        ;;
    "")
        echo "FATAL: TEST29_VARIANT must be set (gpt4o-mini | qwen3-235b)"
        exit 1
        ;;
    *)
        echo "FATAL: unknown TEST29_VARIANT='${VARIANT}' (expected: gpt4o-mini | qwen3-235b)"
        exit 1
        ;;
esac
S3_PREFIX="${S3_PREFIX:-${S3_PREFIX_DEFAULT}}"

RUN_ID="${TEST29_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUTPUT_DIR="results/test29-${VARIANT}-${RUN_ID}"
LOG_FILE="results/test29-${VARIANT}-run-${RUN_ID}.log"

mkdir -p results
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "════════════════════════════════════════════════════════════════════════"
echo " Test 29: Stop-Hook Cross-Vendor (${VARIANT})"
echo "════════════════════════════════════════════════════════════════════════"
echo " RUN_ID        : ${RUN_ID}"
echo " VARIANT       : ${VARIANT}"
echo " AGENT_BACKEND : ${AGENT_BACKEND}"
echo " AGENT_MODEL   : ${AGENT_MODEL}"
echo " SCENARIOS     : ${SCENARIOS}"
echo " DEFENCES      : ${DEFENCES}"
echo " REPS          : ${REPS}"
echo " MAX_TURNS     : ${MAX_TURNS}"
echo " AGENT_REGION  : ${AGENT_REGION}"
echo " JUDGE         : ${JUDGE_MODEL}"
echo " JUDGE_PROMPT  : ${JUDGE_PROMPT}"
echo " JUDGE_REGION  : ${JUDGE_REGION}"
echo " EMBED         : ${EMBED_MODEL}"
echo " OUTPUT_DIR    : ${OUTPUT_DIR}"
echo " S3            : s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "════════════════════════════════════════════════════════════════════════"

# ── Preflight — Agent backend ─────────────────────────────────────────────
echo ""
echo ">>> Preflight: agent backend (${AGENT_BACKEND})"

if [ "${AGENT_BACKEND}" = "openai" ]; then
    if [ -z "${OPENAI_API_KEY:-}" ]; then
        echo "FATAL: OPENAI_API_KEY not set (required for VARIANT=gpt4o-mini)"
        exit 1
    fi
    echo "    OpenAI API key present (${#OPENAI_API_KEY} chars)"
    echo "    Probing OpenAI /v1/models..."
    HTTP_CODE=$(curl -s -o /tmp/openai-probe.json -w "%{http_code}" \
        -H "Authorization: Bearer ${OPENAI_API_KEY}" \
        https://api.openai.com/v1/models || echo "000")
    if [ "${HTTP_CODE}" != "200" ]; then
        echo "FATAL: OpenAI models endpoint returned ${HTTP_CODE}"
        head -c 500 /tmp/openai-probe.json || true
        echo ""
        exit 1
    fi
    echo "    OpenAI reachable (HTTP 200)"
elif [ "${AGENT_BACKEND}" = "converse" ]; then
    AGENT_MODEL_ID="qwen.qwen3-235b-a22b-2507-v1:0"
    echo "    Testing agent model ${AGENT_MODEL_ID} in ${AGENT_REGION}..."
    aws bedrock-runtime converse \
        --region "${AGENT_REGION}" \
        --model-id "${AGENT_MODEL_ID}" \
        --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
        --inference-config '{"maxTokens":1}' \
        --output text --query "output.message.content[0].text" >/dev/null 2>&1 \
        && echo "    Agent model OK" \
        || { echo "FATAL: agent model ${AGENT_MODEL_ID} not accessible in ${AGENT_REGION}"; exit 1; }
fi

# ── Preflight — Judge model ────────────────────────────────────────────────
echo ""
echo ">>> Bedrock preflight: judge model (region: ${JUDGE_REGION})..."
aws bedrock-runtime converse \
    --region "${JUDGE_REGION}" \
    --model-id "${JUDGE_MODEL}" \
    --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
    --inference-config '{"maxTokens":1}' \
    --output text --query "output.message.content[0].text" >/dev/null 2>&1 \
    && echo "    Judge model OK: ${JUDGE_MODEL}" \
    || { echo "FATAL: Judge model not accessible in ${JUDGE_REGION}"; exit 1; }

# ── Preflight — Embed model ────────────────────────────────────────────────
echo ""
echo ">>> Bedrock preflight: embed model (region: ${JUDGE_REGION})..."
aws bedrock-runtime invoke-model \
    --region "${JUDGE_REGION}" \
    --model-id "${EMBED_MODEL}" \
    --body '{"inputText":"ok"}' \
    --content-type "application/json" \
    --accept "application/json" \
    /tmp/embed-probe.json >/dev/null 2>&1 \
    && echo "    Embed model OK: ${EMBED_MODEL}" \
    || { echo "WARN: embed model probe failed — tracker may still work via a different payload shape"; }

# ── Preflight — S3 access ──────────────────────────────────────────────
echo ""
echo ">>> S3 preflight check..."
aws s3 ls "s3://${S3_BUCKET}/" --region "${S3_REGION}" --page-size 1 >/dev/null 2>&1 \
    && echo "    S3 OK" \
    || { echo "FATAL: Cannot list S3 bucket"; exit 1; }

S3_TEST_KEY="${S3_PREFIX}/.preflight-${RUN_ID}"
echo "preflight" | aws s3 cp - "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${S3_REGION}" 2>/dev/null \
    && echo "    S3 write OK" \
    || { echo "FATAL: Cannot write to S3"; exit 1; }
aws s3 rm "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${S3_REGION}" 2>/dev/null || true

# ── Run Test 29 runner ─────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo " Starting Test 29 runner"
echo "════════════════════════════════════════════════════════════════════════"

# IntentTracker reads AWS_REGION for Bedrock judge+embed calls.
export AWS_REGION="${JUDGE_REGION}"
# Qwen converse executor reads AGENT_REGION (falls back to AWS_REGION).
export AGENT_REGION

npx tsx src/tests/runner-stop-cross-vendor.ts \
    --agent-backend "${AGENT_BACKEND}" \
    --models "${AGENT_MODEL}" \
    --scenarios "${SCENARIOS}" \
    --defences "${DEFENCES}" \
    --repetitions "${REPS}" \
    --max-turns "${MAX_TURNS}" \
    --judge-model "${JUDGE_MODEL}" \
    --judge-backend "bedrock" \
    --judge-prompt "${JUDGE_PROMPT}" \
    --embed-model "${EMBED_MODEL}" \
    --embed-backend "bedrock" \
    --output-dir "${OUTPUT_DIR}" \
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
echo " Test 29 (${VARIANT}) complete — ${RUN_ID}"
echo "════════════════════════════════════════════════════════════════════════"
