#!/usr/bin/env bash
# build-benchmarks-zip.sh — build judge-ai-dredd-benchmarks.zip
#
# Unified benchmark runner zip. The image baked from this zip
# supports the AgentDojo (`promptarmor-bedrock`), InjecAgent, and
# MT-AgentRisk runners — bedt3/4/5 can be repurposed across any of
# those workloads via the /run body's `test` field. Replaces the
# previous role-specific Dockerfile.{injecagent,promptarmor-bedrock}-zip
# split.
#
# Output: $PROJECT_ROOT/judge-ai-dredd-benchmarks.zip (~190 MB —
# bigger than the previous version because it bakes in the
# 59 MB MT-AgentRisk dataset AND the ~75 MB pre-resolved MCP
# node_modules tree the mt-agentrisk runner needs at runtime).
# Upload via the AI Sandbox UI; CodeBuild builds + pushes.
#
# Layout (flat — every path is at the zip root):
#   /Dockerfile                                       (Dockerfile.benchmarks-zip)
#   /server.js                                        (renamed api-server.cjs)
#   /docker-entrypoint-injecagent.sh
#   /docker-entrypoint-promptarmor-bedrock.sh
#   /docker-entrypoint-mt-agentrisk.sh
#   /package.json
#   /benchmarks/{agentdojo,injecagent,mt_agentrisk,...}/
#   /datasets/mt-agentrisk/                           (~59 MB)
#   /python-wheels/                                   (~49 MB)
#   /node_modules/                                    (~75 MB; vendored
#                                                     MCP servers — only
#                                                     consumed by the
#                                                     mt-agentrisk runner.
#                                                     CodeBuild can't
#                                                     reach public npm,
#                                                     so we resolve the
#                                                     tree locally here.)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZIP_PATH="$PROJECT_ROOT/judge-ai-dredd-benchmarks.zip"
STAGING="$(mktemp -d -t dredd-bench-zip-XXXXXX)"

echo "[build] project: $PROJECT_ROOT"
echo "[build] staging: $STAGING"
echo "[build] target:  $ZIP_PATH"

# Always blow the old zip away — zip appends rather than replaces.
rm -f "$ZIP_PATH"

# Bulk content shared across all three runners.
cp -r "$PROJECT_ROOT/python-wheels" "$STAGING/python-wheels"
cp -r "$PROJECT_ROOT/benchmarks"    "$STAGING/benchmarks"
cp    "$PROJECT_ROOT/package.json"  "$STAGING/package.json"

# MT-AgentRisk dataset (~59 MB). Only the mt-agentrisk runner uses
# it, but staging it once means the image build doesn't need a
# separate dataset-fetch step.
mkdir -p "$STAGING/datasets"
cp -r "$PROJECT_ROOT/datasets/mt-agentrisk" "$STAGING/datasets/mt-agentrisk"

# Vendored MCP servers for the mt-agentrisk runner. CodeBuild can't
# reach public npm directly (the cko-engineering-main mirror doesn't
# proxy @modelcontextprotocol/* / @playwright/* / @notionhq/*), so we
# resolve a clean tree locally and ship it inside the zip. The
# Dockerfile COPYs it to /app/node_modules and runs `node --check` on
# each MCP entrypoint as a smoke test.
#
# We always rebuild fresh (no incremental npm install) — keeps the
# closure deterministic across machines.
MCP_VENDOR="$STAGING/node_modules"
echo "[build] vendoring MCP servers -> $MCP_VENDOR"
MCP_STAGE="$(mktemp -d -t dredd-mcp-vendor-XXXXXX)"
cat > "$MCP_STAGE/package.json" <<'EOF'
{
  "name": "mt-agentrisk-mcp-bundle",
  "version": "1.0.0",
  "description": "Vendored MCP servers for the MT-AgentRisk benchmarks image",
  "private": true,
  "dependencies": {
    "@modelcontextprotocol/server-filesystem": "*",
    "@modelcontextprotocol/server-postgres": "*",
    "@playwright/mcp": "*",
    "@notionhq/notion-mcp-server": "*"
  }
}
EOF
( cd "$MCP_STAGE" && \
  npm install --no-audit --no-fund --omit=optional \
      --registry=https://registry.npmjs.org/ >/tmp/dredd-mcp-npm.log 2>&1 ) || {
  echo "[build] ERROR: npm install for MCP vendor failed — see /tmp/dredd-mcp-npm.log" >&2
  exit 1
}
mv "$MCP_STAGE/node_modules" "$MCP_VENDOR"
rm -rf "$MCP_STAGE"
# Sanity-check each entrypoint exists.
for f in \
    "@modelcontextprotocol/server-filesystem/dist/index.js" \
    "@modelcontextprotocol/server-postgres/dist/index.js" \
    "@playwright/mcp/cli.js" \
    "@notionhq/notion-mcp-server/bin/cli.mjs"; do
  if [[ ! -f "$MCP_VENDOR/$f" ]]; then
    echo "[build] ERROR: vendored MCP server missing: $f" >&2
    exit 1
  fi
done

# All three entrypoints — the whole point of this image.
cp "$PROJECT_ROOT/fargate/docker-entrypoint-injecagent.sh" \
   "$STAGING/docker-entrypoint-injecagent.sh"
cp "$PROJECT_ROOT/fargate/docker-entrypoint-promptarmor-bedrock.sh" \
   "$STAGING/docker-entrypoint-promptarmor-bedrock.sh"
cp "$PROJECT_ROOT/fargate/docker-entrypoint-mt-agentrisk.sh" \
   "$STAGING/docker-entrypoint-mt-agentrisk.sh"

# api-server.cjs renamed to server.js (flat-layout convention).
cp "$PROJECT_ROOT/fargate/api-server.cjs" "$STAGING/server.js"

# Unified Dockerfile.
cp "$PROJECT_ROOT/fargate/Dockerfile.benchmarks-zip" "$STAGING/Dockerfile"

# Drop __pycache__ / *.pyc from the staged tree so the image build
# doesn't carry stale bytecode (Python regenerates on first import).
find "$STAGING" -name __pycache__ -type d -prune -exec rm -rf {} \; 2>/dev/null || true
find "$STAGING" -name '*.pyc' -delete 2>/dev/null || true

# Build it.
( cd "$STAGING" && zip -qr "$ZIP_PATH" . )

# Cleanup staging.
rm -rf "$STAGING"

# Sanity: verify all three entrypoints are at the zip root.
echo "[build] verifying flat layout..."
for f in Dockerfile server.js docker-entrypoint-injecagent.sh \
         docker-entrypoint-promptarmor-bedrock.sh \
         docker-entrypoint-mt-agentrisk.sh package.json; do
  if ! unzip -l "$ZIP_PATH" "$f" >/dev/null 2>&1; then
    echo "[build] ERROR: $f missing from zip root" >&2
    exit 1
  fi
done

# Verify dataset present for the mt-agentrisk runner.
if ! unzip -l "$ZIP_PATH" 'datasets/mt-agentrisk/*' >/dev/null 2>&1; then
  echo "[build] ERROR: datasets/mt-agentrisk/ missing from zip" >&2
  exit 1
fi

# Verify each vendored MCP server entrypoint is present.
for f in \
    'node_modules/@modelcontextprotocol/server-filesystem/dist/index.js' \
    'node_modules/@modelcontextprotocol/server-postgres/dist/index.js' \
    'node_modules/@playwright/mcp/cli.js' \
    'node_modules/@notionhq/notion-mcp-server/bin/cli.mjs'; do
  if ! unzip -l "$ZIP_PATH" "$f" >/dev/null 2>&1; then
    echo "[build] ERROR: vendored MCP server missing from zip: $f" >&2
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
