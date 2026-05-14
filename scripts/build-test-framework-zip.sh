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
#   /vendor/claude-code-pkg/                          @anthropic-ai/claude-code (npm tarball, unpacked)
#   /vendor/claude-code-linux-x64-pkg/                @anthropic-ai/claude-code-linux-x64 (~222M)
#   /vendor/test-framework-node_modules/              test-framework deps for linux-x64
#
# Why vendored: CodeArtifact's cko-engineering-main mirror does not
# currently proxy the @anthropic-ai/* scope, and CodeBuild rewrites
# any `--registry=...` flag in Dockerfile RUN commands back to the
# mirror, so we can't reach public npm at image-build time. We
# pre-resolve everything on the dev box (where public npm IS
# reachable) and bake it into the zip.

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

# ── Vendor @anthropic-ai/claude-code + linux-x64 native + test-framework deps
# Re-resolve from the public npm registry (this dev box must have public
# npm reachable — CodeBuild does not). Output goes into $STAGING/vendor/
# which the Dockerfile COPYs at image-build time.
VENDOR_TMP="$(mktemp -d -t dredd-tf-vendor-XXXXXX)"
echo "[build] vendoring @anthropic-ai/claude-code (npm pack → unpack)..."
( cd "$VENDOR_TMP" \
    && npm pack --silent --registry=https://registry.npmjs.org \
        @anthropic-ai/claude-code @anthropic-ai/claude-code-linux-x64 \
        >/dev/null )

mkdir -p "$STAGING/vendor/claude-code-pkg" \
         "$STAGING/vendor/claude-code-linux-x64-pkg"
# Glob is specific — `claude-code-2.*.tgz` matches the wrapper, not
# the linux-x64 native tarball.
tar -xzf "$VENDOR_TMP"/anthropic-ai-claude-code-2.*.tgz \
    -C "$STAGING/vendor/claude-code-pkg" --strip-components=1
tar -xzf "$VENDOR_TMP"/anthropic-ai-claude-code-linux-x64-2.*.tgz \
    -C "$STAGING/vendor/claude-code-linux-x64-pkg" --strip-components=1
rm -rf "$VENDOR_TMP"

echo "[build] vendoring test-framework node_modules (linux-x64)..."
TF_VENDOR_TMP="$(mktemp -d -t dredd-tf-deps-XXXXXX)"
cp "$PROJECT_ROOT/test-framework/package.json"      "$TF_VENDOR_TMP/"
cp "$PROJECT_ROOT/test-framework/package-lock.json" "$TF_VENDOR_TMP/" 2>/dev/null || true
( cd "$TF_VENDOR_TMP" \
    && npm install --silent --registry=https://registry.npmjs.org \
        --os=linux --cpu=x64 --include=optional --ignore-scripts \
        >/dev/null )
mkdir -p "$STAGING/vendor/test-framework-node_modules"
( cd "$TF_VENDOR_TMP/node_modules" \
    && rsync -a ./ "$STAGING/vendor/test-framework-node_modules/" )
rm -rf "$TF_VENDOR_TMP"

VENDOR_BYTES=$(du -sh "$STAGING/vendor" | awk '{print $1}')
echo "[build] vendor/ size: $VENDOR_BYTES"

# Drop node_modules/.bin/ from the staged vendor tree — its entries
# are symlinks to the real cli files, and zip+CodeBuild's unzip both
# tend to dereference symlinks. Once dereferenced, the .bin/tsx file
# becomes a copy of tsx/dist/cli.mjs that fails on its own relative
# `import './package-*.mjs'` lines (the sibling files live in
# tsx/dist/, not .bin/).
#
# The entrypoint invokes the real cli files directly
# (`node test-framework/node_modules/tsx/dist/cli.mjs ...`) so
# nothing on PATH actually needs the shims.
rm -rf "$STAGING/vendor/test-framework-node_modules/.bin"
( cd "$STAGING" && zip -qr "$ZIP_PATH" . )
rm -rf "$STAGING"

echo "[build] verifying flat layout..."
for f in Dockerfile server.js docker-entrypoint-test-framework.sh \
         package.json test-framework/package.json \
         test-framework/src/runner.ts \
         test-framework/src/promptarmor-observer.ts \
         vendor/claude-code-pkg/package.json \
         vendor/claude-code-pkg/install.cjs \
         vendor/claude-code-linux-x64-pkg/claude \
         vendor/test-framework-node_modules/@anthropic-ai/claude-agent-sdk/package.json; do
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
