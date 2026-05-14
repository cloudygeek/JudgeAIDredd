#!/usr/bin/env bash
# build-benchmarks-zip.sh — build judge-ai-dredd-benchmarks.zip
#
# Unified benchmark runner zip. The image baked from this zip
# supports BOTH the AgentDojo (`promptarmor-bedrock`) and InjecAgent
# runners — bedt3/4/5 can be repurposed across either workload via
# the /run body's `test` field. Replaces the previous role-specific
# Dockerfile.injecagent-zip / Dockerfile.promptarmor-bedrock-zip
# split.
#
# Output: $PROJECT_ROOT/judge-ai-dredd-benchmarks.zip (~56 MB).
# Upload via the AI Sandbox UI; CodeBuild builds + pushes.
#
# Layout (flat — every path is at the zip root):
#   /Dockerfile                                       (Dockerfile.benchmarks-zip)
#   /server.js                                        (renamed api-server.cjs)
#   /docker-entrypoint-injecagent.sh
#   /docker-entrypoint-promptarmor-bedrock.sh
#   /package.json
#   /benchmarks/{agentdojo,injecagent,...}/
#   /python-wheels/                                   (~49 MB)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZIP_PATH="$PROJECT_ROOT/judge-ai-dredd-benchmarks.zip"
STAGING="$(mktemp -d -t dredd-bench-zip-XXXXXX)"

echo "[build] project: $PROJECT_ROOT"
echo "[build] staging: $STAGING"
echo "[build] target:  $ZIP_PATH"

# Always blow the old zip away — zip appends rather than replaces.
rm -f "$ZIP_PATH"

# Bulk content shared between both runners.
cp -r "$PROJECT_ROOT/python-wheels" "$STAGING/python-wheels"
cp -r "$PROJECT_ROOT/benchmarks"    "$STAGING/benchmarks"
cp    "$PROJECT_ROOT/package.json"  "$STAGING/package.json"

# Both entrypoints — the whole point of this image.
cp "$PROJECT_ROOT/fargate/docker-entrypoint-injecagent.sh" \
   "$STAGING/docker-entrypoint-injecagent.sh"
cp "$PROJECT_ROOT/fargate/docker-entrypoint-promptarmor-bedrock.sh" \
   "$STAGING/docker-entrypoint-promptarmor-bedrock.sh"

# api-server.cjs renamed to server.js (flat-layout convention).
cp "$PROJECT_ROOT/fargate/api-server.cjs" "$STAGING/server.js"

# Unified Dockerfile.
cp "$PROJECT_ROOT/fargate/Dockerfile.benchmarks-zip" "$STAGING/Dockerfile"

# Build it.
( cd "$STAGING" && zip -qr "$ZIP_PATH" . )

# Cleanup staging.
rm -rf "$STAGING"

# Sanity: verify both entrypoints are at the zip root.
echo "[build] verifying flat layout..."
for f in Dockerfile server.js docker-entrypoint-injecagent.sh \
         docker-entrypoint-promptarmor-bedrock.sh package.json; do
  if ! unzip -l "$ZIP_PATH" "$f" >/dev/null 2>&1; then
    echo "[build] ERROR: $f missing from zip root" >&2
    exit 1
  fi
done

VERSION=$(grep '"version"' "$PROJECT_ROOT/package.json" | head -1 | sed -E 's/.*"([^"]+)".*/\1/' | head -2 | tail -1)
SIZE=$(du -h "$ZIP_PATH" | awk '{print $1}')

echo
echo "[build] OK"
echo "[build]   path:    $ZIP_PATH"
echo "[build]   size:    $SIZE"
echo "[build]   version: $VERSION (from package.json)"
echo
echo "Next: upload via AI Sandbox UI; CodeBuild will build + push."
echo "Then update the bedt* task definitions to the new image tag."
