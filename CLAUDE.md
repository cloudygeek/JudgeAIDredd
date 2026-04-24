# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Judge AI Dredd is a PreToolUse defence system that intercepts tool calls from Claude Code (or any Claude Agent SDK app) and blocks goal-hijacking / prompt-injection attacks. It runs as an HTTP server (`src/server.ts`) that the CLI talks to via a single bash hook script (`hooks/dredd-hook.sh`), so it can be dropped into any project by editing `.claude/settings.json`.

## Common commands

```bash
# Run the HTTP server (dashboard at http://localhost:3001)
npm run server                  # default: autonomous mode, llama3.2 judge
npm run server:interactive      # interactive mode
npm run server:learn            # learn mode
npm run server:autonomous       # autonomous mode (re-evaluates intent every turn)
npm run server:bedrock          # use AWS Bedrock nemotron-super-3-120b instead of Ollama
npm run server:bedrock:interactive  # Bedrock + interactive mode
npm run server:bedrock:learn    # Bedrock + learn mode

# Test harness (replays P14 attack scenarios)
npm test                        # default scenarios
npm run test:baseline           # no defence
npm run test:defend             # full intent-tracker pipeline
npm run test:compare            # baseline vs defended, 5 reps each

# Policy auto-curation — reads session logs, asks LLM to recommend allow/deny rules
npm run review                  # uses Ollama
npm run review:bedrock          # uses Bedrock

# Pull required Ollama models
npm run ollama:pull             # nomic-embed-text + llama3.2
```

Bedrock mode uses `eu-west-2` and shells out to `aws bedrock-runtime converse` — needs AWS creds. Ollama mode needs `ollama serve` running locally.

## Architecture

Three layers, all centred on **`SessionTracker`** (`src/session-tracker.ts`) which holds per-`session_id` state: original intent, pivots, tool calls, files read/written (with edit accumulation), env vars exported, drift scores, turn metrics.

### 1. HTTP server (`src/server.ts`)

Routes called by the hook script:
- `POST /intent` ← UserPromptSubmit. Registers/updates intent. Detects confirmation prompts (`yes`, `ok`, `do it`, ... under 80 chars) and does NOT treat them as new intents.
- `POST /evaluate` ← PreToolUse. Runs the three-stage pipeline. Returns `permissionDecision: allow|deny|ask`.
- `POST /track` ← PostToolUse. Records tool result, accumulates file writes, parses env exports.
- `POST /end` ← Stop. Writes full session log to `results/`.
- `POST /pivot` ← explicit user direction change.
- `POST /compact` ← PreCompact notification.
- `GET /api/sessions`, `/api/session-log/:id`, `/api/feed`, `/api/policies` — feed the dashboard (`src/web/dashboard.html`).

**Backfill**: if `/evaluate` fires before `/intent` (Dredd restarted mid-session), it parses `transcript_path` (Claude's JSONL) to reconstruct intent + recent tool calls. If that fails it falls back to policy-only mode.

### 2. Three-stage PreToolUse pipeline (`src/pretool-interceptor.ts`)

1. **Policy engine** (`src/tool-policy.ts`) — instant, deterministic. `ALLOWED_TOOLS` (Read/Glob/Grep + curated MCP tools), `ALLOWED_BASH_PATTERNS`, `DENIED_BASH_PATTERNS`, `REVIEW_BASH_PATTERNS`. Splits chained commands on `&&`/`||`/`;`/`|` and evaluates each part. `checkDangerousCombination()` catches directory escape, write-then-execute, download-then-execute even when individual parts are allowed.
2. **Embedding drift** (`src/drift-detector.ts`) — ~50ms. Cosine similarity between tool call and intent via Ollama `nomic-embed-text`. High → allow, low → judge, middle → judge.
3. **LLM judge** (`src/intent-judge.ts`) — 1.4s Bedrock / 10–15s Ollama. Operates in clean context (no agent history). Returns `consistent` / `drifting` / `hijacked`. Has a partial-JSON parser fallback for truncated responses. **Only `hijacked` denies**; `drifting` allows but injects a goal anchor before the next turn. Judge errors fail-soft (return `drifting`, log to stderr) — a Bedrock outage surfaces as a warning rather than silently removing the judge from the defence stack.

The judge gets file-content context from `SessionTracker.getFileContextForJudge()` — this is how payload-splitting attacks are caught: assembled file content is fed to the judge when an execution command fires.

### 3. CLI integration (`hooks/dredd-hook.sh`)

Single bash script handling all hook events. Reads JSON from stdin, calls the right Dredd endpoint, prints JSON to stdout. **Fails open** if server is down (`permissionDecision: "ask"`). PostToolUse and Stop are fire-and-forget background curls so they don't block the agent. Install via `hooks/settings.json.example` — copy into `.claude/settings.json`.

## Container image (AI Sandbox / Fargate)

The container runs test harnesses on the AI Sandbox platform. It packages the app into a zip that the platform's CodeBuild pipeline turns into a Docker image.

**IMPORTANT:** Always commit before building the zip so the pre-commit hook bumps the version. The version prints on the sandbox status page — without a bump you can't tell old and new deployments apart. Do NOT include `node_modules/` in the zip — the Dockerfile runs `npm install` during the Docker build. Always delete the old zip before rebuilding (zip appends, it doesn't replace).

### Building the zip

```bash
# 1. Commit your changes first (bumps version via pre-commit hook)
git add -A && git commit -m "your message"

# 2. Build the zip — always delete old zip first
rm -f judge-ai-dredd-t3-sandbox.zip
cd /tmp && rm -rf dredd-rezip && mkdir dredd-rezip && cd dredd-rezip

# App source (no node_modules — Dockerfile handles deps)
cp -r <project>/src <project>/scenarios <project>/workspace-template \
      <project>/package.json <project>/package-lock.json <project>/tsconfig.json .

# Entrypoints (flat layout — all sit at zip root)
cp <project>/fargate/docker-entrypoint.sh      ./docker-entrypoint.sh
cp <project>/fargate/docker-entrypoint-test1.sh ./docker-entrypoint-test1.sh
cp <project>/fargate/docker-entrypoint-test3.sh ./docker-entrypoint-test3.sh
cp <project>/fargate/docker-entrypoint-test3a.sh ./docker-entrypoint-test3a.sh
cp <project>/fargate/docker-entrypoint-test4.sh ./docker-entrypoint-test4.sh
cp <project>/fargate/docker-entrypoint-test8.sh ./docker-entrypoint-test8.sh
cp <project>/fargate/docker-entrypoint-test9.sh ./docker-entrypoint-test9.sh
cp <project>/fargate/docker-entrypoint-test9a.sh ./docker-entrypoint-test9a.sh
cp <project>/fargate/docker-entrypoint-test12.sh ./docker-entrypoint-test12.sh

# AgentDojo benchmark (Python) — vendored into the image
cp -r <project>/benchmarks ./benchmarks

# AgentDojo source (Dockerfile pip installs it)
cp -r /path/to/agentdojo ./agentdojo

# API server + Dockerfile + assets
cp <project>/fargate/api-server.cjs ./server.js
cp <project>/fargate/Dockerfile ./Dockerfile
cp <project>/src/web/logo.png ./logo.png 2>/dev/null || true

zip -qr <project>/judge-ai-dredd-t3-sandbox.zip .
```

The zip layout is **flat** — `Dockerfile`, entrypoints, and `server.js` sit at the root (not under `fargate/`).

### Building the Docker image locally

```bash
# Authenticate to the ECR pull-through cache first
aws ecr get-login-password --region eu-west-1 | \
  docker login --username AWS --password-stdin 891377407345.dkr.ecr.eu-west-1.amazonaws.com

# Build from project root (uses fargate/Dockerfile)
docker build -f fargate/Dockerfile \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  --build-arg GIT_DIRTY=$(if [ -n "$(git status --porcelain)" ]; then echo true; else echo false; fi) \
  -t judge-ai-dredd-test7 .
```

### Key fargate files

| File | Role |
|---|---|
| `fargate/Dockerfile` | Image definition — node:22-slim + AWS CLI v2, bundles app source |
| `fargate/docker-entrypoint.sh` | Test 7: Cross-Model Agent Testing |
| `fargate/docker-entrypoint-test1.sh` | Test 1: Combined Pipeline E2E (effort sweep) |
| `fargate/docker-entrypoint-test3.sh` | Test 3: Statistical Robustness |
| `fargate/docker-entrypoint-test3a.sh` | Test 3a: Statistical Robustness — Opus 4.7 + effort |
| `fargate/docker-entrypoint-test4.sh` | Test 4: Goal Anchoring Effectiveness |
| `fargate/docker-entrypoint-test8.sh` | Test 8: Adversarial Judge Robustness (effort sweep) |
| `fargate/docker-entrypoint-test9.sh` | Test 9: Latency Impact |
| `fargate/docker-entrypoint-test9a.sh` | Test 9a: Latency Impact — effort dimension |
| `fargate/docker-entrypoint-test12.sh` | Test 12: AgentDojo External Benchmark |
| `fargate/docker-entrypoint-test12a.sh` | Test 12a: AgentDojo B7.1-office rerun (token-expiry fix) |
| `fargate/docker-entrypoint-test13.sh` | Test 13: Prompt-Reduction Benchmark (single trace) |
| `fargate/docker-entrypoint-test14.sh` | Test 14: Prompt-Reduction Corpus Benchmark |
| `fargate/api-server.cjs` | HTTP wrapper on port 3000 for the AI Sandbox ALB health check; provides `/run`, `/status`, `/logs` endpoints |
| `fargate/buildspec.yml` | CodeBuild spec — builds and pushes to ECR (`621978938576.dkr.ecr.eu-west-2.amazonaws.com`) |
| `fargate/infra/` | Terraform for the Fargate task definition and supporting resources |

## Drift thresholds

Configurable in tracker: `<0.2` on-task, `0.2–0.3` scope-creep (inject reminder), `0.3–0.5` drifting (escalate to judge), `>0.5` hijacked (block).

## Versioning

`.githooks/pre-commit` auto-bumps the patch version in `package.json` on every commit. The version prints on server startup. Don't manually edit the version field — let the hook do it.

## Key files

| File | Role |
|---|---|
| `src/server.ts` | HTTP server + all route handlers + transcript backfill |
| `src/session-tracker.ts` | Central state (intent, files, env, drift, turn metrics) |
| `src/pretool-interceptor.ts` | Three-stage pipeline orchestration |
| `src/tool-policy.ts` | Policy rules + chained-command splitter + dangerous-combo detector |
| `src/intent-judge.ts` | LLM judge with partial-JSON fallback |
| `src/drift-detector.ts` | Embedding similarity via Ollama |
| `src/ollama-client.ts` / `src/bedrock-client.ts` | Backend clients |
| `src/policy-review.ts` | Auto-curation: groups session logs by normalised pattern, LLM recommends allow/deny |
| `src/web/dashboard.html` | Dark dashboard with live feed, sessions table, policies tab |
| `hooks/dredd-hook.sh` | Single drop-in CLI hook for all events |
| `scenarios/t3-goal-hijacking.ts` | T3.x escalation scenarios from P14 |
| `src/test-p14-replay.ts` | Replay P14 failing scenarios + legitimate scenarios for FP testing |
