# Building the Test Container Image

The test container runs benchmark harnesses (T1–T25) on the AI Sandbox platform.
The platform's CodeBuild pipeline takes a zip file, builds a Docker image from the
Dockerfile inside it, and pushes to ECR.

## Prerequisites

- AWS CLI configured with access to the ECR pull-through cache (eu-west-1) and
  results bucket (eu-west-2)
- The `python-wheels/` directory populated with vendored AgentDojo wheel files
- The `datasets/mt-agentrisk/` directory with the MT-AgentRisk dataset clone

## Step 1: Commit (bumps version)

Always commit before building so the pre-commit hook bumps the version number.
The version prints on the sandbox status page — without a bump you can't tell
old and new deployments apart.

```bash
git add -A && git commit -m "your message"
```

## Step 2: Build the zip

The zip has a **flat layout** — Dockerfile, entrypoints, and server.js sit at
the root. Do NOT include `node_modules/` — the Dockerfile runs `npm install`
during the Docker build.

Always delete the old zip first (zip appends, it doesn't replace):

```bash
rm -f judge-ai-dredd-t3-sandbox.zip

cd /tmp && rm -rf dredd-rezip && mkdir dredd-rezip && cd dredd-rezip
PROJECT=~/IdeaProjects/JudgeAIDredd

# App source
cp -r "$PROJECT"/src "$PROJECT"/scenarios "$PROJECT"/workspace-template \
      "$PROJECT"/package.json "$PROJECT"/package-lock.json "$PROJECT"/tsconfig.json .

# Python wheels (AgentDojo + deps, ~49MB)
cp -r "$PROJECT"/python-wheels ./python-wheels

# MT-AgentRisk dataset (~59MB)
mkdir -p datasets
cp -r "$PROJECT"/datasets/mt-agentrisk ./datasets/mt-agentrisk

# Benchmarks (Python runners for AgentDojo, MT-AgentRisk, AgentLAB)
cp -r "$PROJECT"/benchmarks ./benchmarks

# Entrypoints (flat — all sit at zip root)
for f in "$PROJECT"/fargate/docker-entrypoint*.sh; do
  cp "$f" "./$(basename "$f")"
done

# API server + Dockerfile + assets
cp "$PROJECT"/fargate/api-server.cjs ./server.js
cp "$PROJECT"/fargate/Dockerfile ./Dockerfile
cp "$PROJECT"/src/web/logo.png ./logo.png 2>/dev/null || true

# Create zip
zip -qr "$PROJECT"/judge-ai-dredd-t3-sandbox.zip .
```

Expected size: ~66MB. If it's under 2MB you're missing `python-wheels` or `datasets`.

## Step 3: Upload to AI Sandbox

Upload `judge-ai-dredd-t3-sandbox.zip` via the AI Sandbox UI. CodeBuild will:

1. Authenticate to ECR (`621978938576.dkr.ecr.eu-west-2.amazonaws.com`)
2. Run `docker build` with the flat zip as build context
3. Push the image as `judge-ai-dredd-test7:latest`

## Step 4: Launch containers

Each container runs one test via environment variables. The API server (`server.js`)
listens on port 3000, passes the ALB health check, and spawns the selected
entrypoint when it receives `POST /run`.

Example: to run Test 24 (MT-AgentRisk) for sonnet-4.6 baseline:

```
POST /run
{
  "test": "24",
  "env": {
    "TEST24_MODEL": "sonnet-4.6",
    "TEST24_DEFENCE": "none",
    "AGENT_REGION": "eu-west-1",
    "JUDGE_REGION": "eu-west-1"
  }
}
```

## Building locally (for testing)

```bash
# Authenticate to the ECR pull-through cache
aws ecr get-login-password --region eu-west-1 | \
  docker login --username AWS --password-stdin \
  891377407345.dkr.ecr.eu-west-1.amazonaws.com

# Build from project root
docker build -f fargate/Dockerfile \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  --build-arg GIT_DIRTY=$(if [ -n "$(git status --porcelain)" ]; then echo true; else echo false; fi) \
  -t judge-ai-dredd-test7 .
```

## What's in the image

| Layer | Contents |
|-------|----------|
| Base | node:22-bookworm-slim |
| System | AWS CLI v2, Python 3, PostgreSQL 15, Chromium |
| Node | package.json deps (tsx, typescript, @anthropic-ai/claude-agent-sdk) |
| Python | AgentDojo + all deps from vendored wheels |
| MCP servers | @modelcontextprotocol/server-filesystem, @playwright/mcp, @notionhq/notion-mcp-server, postgres-mcp |
| App | src/, scenarios/, workspace-template/, benchmarks/ |
| Data | datasets/mt-agentrisk/ |
| Entrypoints | docker-entrypoint-test{1,3,3a,4,8,9,9a,10,12,12a-c,13-18,20,21,23-25}.sh |
| API | server.js (port 3000, ALB health check + /run + /status + /logs) |

## Key differences from the judge container

The standalone judge container (`fargate/Dockerfile.judge`, zip: `judge-ai-dredd-judge.zip`)
is lightweight — just the HTTP server + dashboard for vibe coders. It has no Python,
Playwright, PostgreSQL, test scenarios, or benchmark runners. See CLAUDE.md for its
build instructions.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Zip is ~1MB | Missing python-wheels/ or datasets/ | Re-run the build script above |
| `npm install` fails in build | Missing package-lock.json | Ensure it's copied to zip root |
| Container starts but test fails immediately | Version mismatch | Check version on /status matches commit |
| Opus 4.7 returns 319 errors | temperature parameter rejected | Fixed in v0.1.206 (MODELS_NO_TEMPERATURE) |
| Sonnet takes 30+ hours | Over-persistence on impossible tasks | Fixed in v0.1.206 (step budget cap + early termination) |
