#!/usr/bin/env bash
set -euo pipefail

# Run Test 1 locally with effort sweep against Bedrock eu-central-1
# Usage: ./run-test1-local.sh

export AWS_REGION=eu-central-1

echo "Testing Bedrock access (eu-central-1)..."
aws bedrock-runtime converse \
  --region eu-central-1 \
  --model-id "eu.anthropic.claude-haiku-4-5-20251001-v1:0" \
  --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
  --inference-config '{"maxTokens":1}' \
  --output text --query "output.message.content[0].text" >/dev/null 2>&1 \
  && echo "  Bedrock OK" \
  || { echo "  FATAL: Bedrock access denied in eu-central-1"; exit 1; }

echo ""
echo "Running Test 1: all 8 configs × 3 effort levels (default, medium, high)"
echo "This will take ~30-60 minutes depending on judge latency."
echo ""

npx tsx src/test-pipeline-e2e.ts --judge-effort all

echo ""
echo "Results saved to results/pipeline-e2e-*.json"
