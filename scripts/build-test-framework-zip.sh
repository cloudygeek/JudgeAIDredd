#!/usr/bin/env bash
# build-test-framework-zip.sh — build judge-ai-dredd-test-framework.zip
#
# Node-based runner image for the P15 test-framework. Different
# shape from the unified benchmarks zip (which is Python-based).
# Used for T-2 (T3e × PromptArmor on the paper's own corpus).
#
# Output: $PROJECT_ROOT/judge-ai-dredd-test-framework.zip
# Upload via the AI Sandbox UI; CodeBuild builds + pushes.
#
# Layout (flat — every path is at the zip root):
#   /Dockerfile                                       (Dockerfile.test-framework-zip)
#   /server.js                                        (renamed api-server.cjs)
#   /docker-entrypoint-test-framework.sh
#   /package.json                                     (project root, for version banner)
#   /test-framework/                                  full subtree (sans node_modules)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZIP_PATH="$PROJECT_ROOT/judge-ai-dredd-test-framework.zip"
STAGING="$(mktemp -d -t dredd-tf-zip-XXXXXX)"

echo "[build] project: $PROJECT_ROOT"
echo "[build] staging: $STAGING"
echo "[build] target:  $ZIP_PATH"

rm -f "$ZIP_PATH"

# Project-root package.json gives server.js the version banner.
cp "$PROJECT_ROOT/package.json" "$STAGING/package.json"

# Test-framework subtree, sans node_modules — `npm install` runs at
# image-build time so we don't need the resolved tree on the wire.
mkdir -p "$STAGING/test-framework"
( cd "$PROJECT_ROOT/test-framework" \
    && rsync -a --exclude=node_modules --exclude='*.log' --exclude=results \
        ./ "$STAGING/test-framework/" )

# Drop any cached artefacts the editor might have left behind.
find "$STAGING/test-framework" -name '.DS_Store' -delete 2>/dev/null || true
find "$STAGING/test-framework" -name '*.tsbuildinfo' -delete 2>/dev/null || true

cp "$PROJECT_ROOT/fargate/docker-entrypoint-test-framework.sh" \
   "$STAGING/docker-entrypoint-test-framework.sh"
cp "$PROJECT_ROOT/fargate/api-server.cjs" "$STAGING/server.js"
cp "$PROJECT_ROOT/fargate/Dockerfile.test-framework-zip" "$STAGING/Dockerfile"

( cd "$STAGING" && zip -qr "$ZIP_PATH" . )
rm -rf "$STAGING"

echo "[build] verifying flat layout..."
for f in Dockerfile server.js docker-entrypoint-test-framework.sh \
         package.json test-framework/package.json \
         test-framework/src/runner.ts \
         test-framework/src/promptarmor-observer.ts; do
  if ! unzip -l "$ZIP_PATH" "$f" >/dev/null 2>&1; then
    echo "[build] ERROR: $f missing from zip" >&2
    exit 1
  fi
done

VERSION=$(grep '"version"' "$PROJECT_ROOT/package.json" | head -1 \
            | sed -E 's/.*"([^"]+)".*/\1/' | head -2 | tail -1)
SIZE=$(du -h "$ZIP_PATH" | awk '{print $1}')

echo
echo "[build] OK"
echo "[build]   path:    $ZIP_PATH"
echo "[build]   size:    $SIZE"
echo "[build]   version: $VERSION (from package.json)"
echo
echo "Next: upload via AI Sandbox UI; CodeBuild will build + push."
echo "Then update a bedt task definition to the new image tag."
