#!/usr/bin/env bash
set -euo pipefail

# Run Test 1 locally with a clean env (no inherited Claude session tokens).
# Uses eu-west-2 for Bedrock so Nemotron works.
# Ollama must be running locally for nomic-embed-text configs (A,C,E,G).
#
# Usage: ./run-test1-local.sh [config-filter] [effort-levels]
#   e.g.  ./run-test1-local.sh A,C,G default,medium,high

CONFIG_FILTER="${1:-A,C,E,G}"
EFFORT_LEVELS="${2:-default,medium,high}"

# Gate: refuse to run with uncommitted changes unless overridden
if [[ -n "$(git status --porcelain)" ]]; then
  echo "FATAL: working tree dirty — commit or stash before running a reference test."
  echo "  Override with ALLOW_DIRTY=1 for ad-hoc experimentation."
  [[ "${ALLOW_DIRTY:-0}" == "1" ]] || exit 1
  echo "  ALLOW_DIRTY=1 set — proceeding with dirty tree."
fi

# Strip the current Claude session's env to avoid inheriting Bedrock tokens
# that are scoped to eu-west-2 / this process.
exec env -i \
  HOME="$HOME" \
  PATH="$PATH" \
  SHELL="$SHELL" \
  TERM="${TERM:-xterm-256color}" \
  USER="$USER" \
  AWS_REGION=eu-west-2 \
  AWS_DEFAULT_REGION=eu-west-2 \
  bash -c "
set -euo pipefail

echo '============================================================'
echo ' Test 1 Local Runner (clean env)'
echo ' Region:  eu-west-2'
echo ' Configs: ${CONFIG_FILTER}'
echo ' Effort:  ${EFFORT_LEVELS}'
echo '============================================================'
echo ''

echo 'Checking AWS identity...'
aws sts get-caller-identity 2>&1 || { echo 'FATAL: No valid AWS credentials (expected SSO/profile, not session token)'; exit 1; }
echo ''

echo 'Testing Bedrock access (eu-west-2)...'
aws bedrock-runtime converse \\
  --region eu-west-2 \\
  --model-id 'eu.anthropic.claude-haiku-4-5-20251001-v1:0' \\
  --messages '[{\"role\":\"user\",\"content\":[{\"text\":\"ok\"}]}]' \\
  --inference-config '{\"maxTokens\":1}' \\
  --output text --query 'output.message.content[0].text' >/dev/null 2>&1 \\
  && echo '  Bedrock Haiku OK' \\
  || { echo '  FATAL: Bedrock access denied in eu-west-2'; exit 1; }

echo 'Testing Nemotron access (eu-west-2)...'
aws bedrock-runtime converse \\
  --region eu-west-2 \\
  --model-id 'nvidia.nemotron-super-3-120b' \\
  --messages '[{\"role\":\"user\",\"content\":[{\"text\":\"ok\"}]}]' \\
  --inference-config '{\"maxTokens\":1}' \\
  --output text --query 'output.message.content[0].text' >/dev/null 2>&1 \\
  && echo '  Bedrock Nemotron OK' \\
  || echo '  WARN: Nemotron not accessible — configs A,B will fail'

echo ''
echo 'Starting Test 1...'
echo ''

npx tsx src/tests/test-pipeline-e2e.ts --config '${CONFIG_FILTER}' --judge-effort '${EFFORT_LEVELS}'

echo ''
echo 'Results saved to results/pipeline-e2e-*.json'
"
