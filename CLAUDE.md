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
npm run server:bedrock          # use AWS Bedrock claude-sonnet-4-6 instead of Ollama
npm run server:bedrock:interactive  # Bedrock + interactive mode
npm run server:bedrock:learn    # Bedrock + learn mode

# Pull required Ollama models (only needed for ollama backend)
npm run ollama:pull             # nomic-embed-text + llama3.2
```

The research scaffolding (P14 / AgentDojo / MT-AgentRisk benchmark
harnesses, scenario fixtures, canary detection, policy-auto-curation)
was removed from `main` after tag `research-v1`. Restore from that tag
if you need to re-run any of those experiments.

Bedrock mode uses `eu-west-2` and shells out to `aws bedrock-runtime converse` — needs AWS creds. Ollama mode needs `ollama serve` running locally.

## Architecture

Three layers, all centred on **`SessionTracker`** (`src/session-tracker.ts`) which holds per-`session_id` state: original intent, pivots, tool calls, files read/written (with edit accumulation), env vars exported, drift scores, turn metrics.

### 1. HTTP server (`src/server.ts`)

Routes called by the hook script:
- `POST /intent` ← UserPromptSubmit. Registers/updates intent. Detects confirmation prompts (`yes`, `ok`, `do it`, ... under 80 chars) and does NOT treat them as new intents. Persists `isConfirmation` on each TurnIntent so the dashboard's Goals view can mute confirmation noise.
- `POST /evaluate` ← PreToolUse. Runs the three-stage pipeline. Returns `permissionDecision: allow|deny|ask`.
- `POST /track` ← PostToolUse. Records tool result, accumulates file writes, parses env exports.
- `POST /end` ← Stop. Writes full session log to `results/`.
- `POST /pivot` ← explicit user direction change.
- `POST /compact` ← PreCompact notification.
- `POST /notification` ← Notification hook. Increments per-session friction counter — fires every time Claude Code surfaces a permission/notification dialog to the user despite Dredd's PreToolUse decision. The only signal that Dredd allowed something but the user got prompted anyway. Counter is in-memory on the hook container (resets on Fargate task replacement); read it back via `GET /api/notifications/:id` immediately after a run while ALB stickiness still pins to the same task.
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

The AI Sandbox containers run the hook + dashboard servers in Fargate. The app is packaged into a zip that the platform's CodeBuild pipeline turns into a Docker image. Two zips, two services — see "Building the zips" below.

**IMPORTANT:** Always commit before building the zip so the pre-commit hook bumps the version. The version prints on the sandbox status page — without a bump you can't tell old and new deployments apart. Do NOT include `node_modules/` in the zip — the Dockerfile runs `npm install` during the Docker build. Always delete the old zip before rebuilding (zip appends, it doesn't replace).

**Deploying changes:** Code changes (server, dashboard, hooks, policy, etc.) are NOT picked up by running sandbox containers until a new zip is built AND redeployed through the CodeBuild pipeline. If you edit `src/`, `hooks/`, or any file that gets packaged, you must rebuild the zip (see below) and push it so CodeBuild produces a new image — otherwise sandbox containers keep serving the previous version.

### Building the zips

There are **two role-specific zips** that share most of their content but
ship different entrypoints/Dockerfiles. Each zip's entrypoint defaults
`DREDD_ROLE` to its role so a Fargate task definition doesn't have to
set the env var. Both zips package the same `src/` — the role only
selects which server entry point boots.

| Zip | Default `DREDD_ROLE` | Used by |
|---|---|---|
| `judge-ai-dredd-hook.zip` | `hook` | the hook hot-path Fargate service |
| `judge-ai-dredd-dashboard.zip` | `dashboard` | the dashboard Fargate service |

Neither image installs the AWS CLI — both Bedrock and DynamoDB calls go
through the AWS SDK (`@aws-sdk/client-bedrock-runtime`,
`@aws-sdk/client-dynamodb`) directly.

```bash
# 1. Commit your changes first (bumps version via pre-commit hook)
git add -A && git commit -m "your message"

# 2. Build hook zip
mkdir /tmp/dredd-rezip-hook
cp -r <project>/src <project>/hooks \
      <project>/package.json <project>/package-lock.json <project>/tsconfig.json /tmp/dredd-rezip-hook/
cp <project>/fargate/docker-entrypoint-hook.sh /tmp/dredd-rezip-hook/docker-entrypoint.sh
cp <project>/fargate/Dockerfile.hook-zip /tmp/dredd-rezip-hook/Dockerfile
(cd /tmp/dredd-rezip-hook && zip -qr <project>/judge-ai-dredd-hook.zip .)

# 3. Build dashboard zip
mkdir /tmp/dredd-rezip-dash
cp -r <project>/src <project>/hooks \
      <project>/package.json <project>/package-lock.json <project>/tsconfig.json /tmp/dredd-rezip-dash/
cp <project>/fargate/docker-entrypoint-dashboard.sh /tmp/dredd-rezip-dash/docker-entrypoint.sh
cp <project>/fargate/Dockerfile.dashboard-zip /tmp/dredd-rezip-dash/Dockerfile
(cd /tmp/dredd-rezip-dash && zip -qr <project>/judge-ai-dredd-dashboard.zip .)
```

The zip layout is **flat** — `Dockerfile`, `docker-entrypoint.sh`,
`package.json`, and `src/` all sit at the zip root (not under `fargate/`).
Filename inside the zip is always `docker-entrypoint.sh` regardless of
role; the role-specific source lives at `fargate/docker-entrypoint-{hook,dashboard}.sh`.

### Building the Docker image locally

```bash
# Authenticate to the ECR pull-through cache first
aws ecr get-login-password --region eu-west-1 | \
  docker login --username AWS --password-stdin 891377407345.dkr.ecr.eu-west-1.amazonaws.com

# Build from project root (uses fargate/Dockerfile.judge)
docker build -f fargate/Dockerfile.judge \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  --build-arg GIT_DIRTY=$(if [ -n "$(git status --porcelain)" ]; then echo true; else echo false; fi) \
  -t judge-ai-dredd-judge .
```

## Standalone judge container (for vibe coders)

Lightweight image (`fargate/Dockerfile.judge`) — just the HTTP server + dashboard, no Python/Playwright/test harness. Designed to run on EFS-backed Fargate with `/data` as a persistent volume.

### Building and running

```bash
# Build
docker build -f fargate/Dockerfile.judge \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  -t judge-ai-dredd-judge .

# Run (all config via env vars)
docker run -p 3000:3000 \
  -v judge-data:/data \
  -e MODE=interactive \
  -e BACKEND=bedrock \
  -e AWS_REGION=eu-west-2 \
  judge-ai-dredd-judge
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `MODE` | `interactive` | `interactive` / `autonomous` / `learn` |
| `BACKEND` | `bedrock` | `bedrock` / `ollama` |
| `JUDGE_MODEL` | `eu.anthropic.claude-sonnet-4-6` | LLM judge model ID |
| `EMBEDDING_MODEL` | `eu.cohere.embed-v4:0` | Embedding model ID |
| `HARDENED` | `B7.1` | Prompt variant: `B7` / `B7.1` / `B7.1-office` / `standard` |
| `JUDGE_EFFORT` | (unset) | Optional effort level |
| `PORT` | `3000` | Server port |
| `DATA_DIR` | `/data` | Base directory for sessions and logs |
| `AWS_REGION` | `eu-west-2` | AWS region for Bedrock |
| `STORE_BACKEND` | `dynamo` (sandbox) / `memory` (local) | Session state backend |
| `DYNAMO_TABLE_NAME` | `jaid-sessions` | DynamoDB table for session state |
| `DYNAMO_REGION` | `eu-west-1` | Region of the Dynamo table (distinct from Bedrock region) |
| `DYNAMO_API_KEYS_TABLE_NAME` | `jaid-api-keys` | DynamoDB table for hook API keys |
| `DREDD_ROLE` | `hook` | Container role: `hook` (hot path + feed + mode) or `dashboard` (UI + session listing) |
| `DREDD_HOOK_URL` | (unset) | On the dashboard container, the URL the browser will POST /api/feed + /api/mode to |
| `DREDD_DASHBOARD_ORIGIN` | (unset) | On the hook container, the CORS Origin the dashboard is served from |
| `DREDD_AUTH_MODE` | `optional` | `off` / `optional` / `required` — hook Bearer-key enforcement |
| `CLERK_SECRET_KEY` | (unset) | **Dashboard role only.** Clerk secret used by `verifyToken` to validate session JWTs on every `/api/*` request. Without it the dashboard returns 503 on `/api/*` |
| `CLERK_PUBLISHABLE_KEY` | (unset) | **Dashboard role only.** Clerk publishable key (`pk_test_…` / `pk_live_…`) injected into the dashboard HTML so the browser can bootstrap `@clerk/clerk-js`. `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is read as a fallback |
| `CLERK_JWT_PUBLIC_KEY` | (unset) | **Dashboard role only.** Static PEM (or JWK JSON) for Clerk's session-token signing key. When set, `verifyToken` skips the network JWKS fetch entirely — required when the container can't reach `api.clerk.com` / `*.clerk.dev` due to firewall rules. Get the JWKS from `https://<frontend-api>/.well-known/jwks.json`; paste either the JWK or its PEM export |

Session logs: see the **Session storage** note below — Dynamo-backed for the shared sandbox deployment. Console logs (`dredd-YYYY-MM-DD.log`) still live on disk in `$DATA_DIR/logs/` and are viewable via the dashboard (Logs tab).

### Dashboard auth (Clerk)

Sign-in is required to view anything on the dashboard. Clerk verifies session JWTs server-side via `@clerk/backend` (`src/clerk-auth.ts`).

There are two roles, hard-coded by email in `src/clerk-auth.ts`:

- **admin** — `adrian.asher@checkout.com`, `adrianasher30@gmail.com`. Can list every user's API keys and sessions, view console logs, toggle the global trust mode, and download the integration bundle.
- **user** — any other Clerk-authenticated identity. Sees only sessions whose `ownerSub` matches their Clerk userId, only their own API keys, no mode toggle, no console logs.

Sessions are tied to Clerk identity via the API key path: when a user generates an API key from the dashboard's API Keys tab, the key's `ownerSub` is set to their Clerk userId. The hook server stamps this `ownerSub` on each session in `setSessionOwner` at `/intent` time. Dashboard `/api/sessions` filters on it for non-admin users.

Adding an admin requires a code change to `ADMIN_EMAILS` in `src/clerk-auth.ts` and a redeploy — there is no env-var override.

## Two-container architecture

The sandbox runs **two Fargate services** that share the same image. `DREDD_ROLE` picks which role boots.

| Role | URL | What it does |
|---|---|---|
| `hook` (default) | `https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal/` | Hot path: `POST /intent`, `/evaluate`, `/track`, `/end`, `/pivot`, `/compact`, `/register`. Plus status: `/health`, `/api/health`, `/api/data-status`, `/api/whoami`. Plus runtime toggle: `POST /api/mode`. Plus the in-memory feed ring: `GET /api/feed`. Runs the Bedrock/Ollama preflight. Authenticates hook Bearer tokens. |
| `dashboard` | `https://judge-ai-dredd.aisandbox.dev.ckotech.internal/` | UI: `GET /` (dashboard HTML), `/api/sessions`, `/api/session-log/:id`, `/api/policies`, `/api/logs*`, `/api/integration-bundle`, `/api/whoami`. Behind OIDC. No judge preflight. |

Cross-container calls go **from the browser**:
- Dashboard HTML → `$DREDD_HOOK_URL/api/feed` (live events)
- Dashboard HTML → `$DREDD_HOOK_URL/api/mode` (trust mode toggle)
- Dashboard HTML → `$DREDD_HOOK_URL/api/health` (version + active session count)

The hook container serves CORS headers scoped to `$DREDD_DASHBOARD_ORIGIN` on `/api/feed`, `/api/mode`, and `/api/health`.

Why split: the dashboard's slow DynamoDB reads shouldn't share an event loop with the hook's hot path. Splitting also lets the dashboard live behind OIDC while hooks keep using Bearer keys. Single image; the entrypoint just sets `DREDD_ROLE`.

**Source files:**
- `src/server.ts` — thin dispatcher, reads `DREDD_ROLE`
- `src/server-core.ts` — shared plumbing (CONFIG, stores, auth, body caps, path validation, backfill, `buildSessionLogShape`)
- `src/server-hook.ts` — hook endpoints + feed + mode + health + CORS
- `src/server-dashboard.ts` — dashboard HTML + sessions + logs + integration bundle. Injects `window.DREDD_HOOK_URL` into the served HTML so the page knows where cross-origin calls go.

## Session storage

The shared sandbox server behind `https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal/` uses a **DynamoDB-backed `SessionStore`** (`src/dynamo-session-store.ts`) wrapped in a write-through LRU cache (`src/cached-session-store.ts`). Behaviour:

- **Every state mutation is persisted synchronously** to `jaid-sessions` in eu-west-1 — `/intent`, `/evaluate`, `/track`, `/pivot`, `/compact`, `/end` all write to Dynamo as part of the request.
- **Reads hit the in-container cache first**; cache miss triggers a Query across all sort keys under `SESSION#<session_id>` to reconstruct full state.
- **ALB sticky cookies** (wired into `hooks/dredd-hook.sh` via a per-session `~/.claude/dredd/cookies/<session_id>.jar`) pin a session to one container so the cache stays hot. Task replacement surfaces as a transparent cache miss + `loadSession()` round-trip — no loss of session state.
- **No more `results/*.json` on disk.** Dashboard endpoints (`/api/sessions`, `/api/session-log/:id`) assemble the old JSON shape from Dynamo on demand; legacy `results/*.json` files still surface as a fallback.
- **Selection**: `STORE_BACKEND=dynamo` on sandbox containers (the entrypoint defaults to it). Local dev stays on `STORE_BACKEND=memory` (default) unless you export it.

Per-session item shape:
- `pk = SESSION#<session_id>`, `sk = META | TURN#<n> | TOOL#<turn>#<seq> | FILE#W#<pathHash> | FILE#R#<ts>#<seq> | ENV#<name> | METRIC#<n> | PIVOT#<ts>`
- GSI1 (`gsi1pk = "SESSION"`, `gsi1sk = startedAt`) is set only on META for cheap dashboard listing
- TTL `ttl` (epoch seconds), 30d, refreshed on every write

### Checking `/data` persistence

Session logs only survive container restart if `$DATA_DIR` is backed by a real volume (EFS on Fargate). Two ways to verify:

1. **At startup** — `fargate/docker-entrypoint-judge.sh` prints the `/proc/mounts` line for `$DATA_DIR`, total bytes, existing session/log file counts, and the newest 3 session filenames. Check the container's stdout on boot.
2. **On a running container** — `GET /api/data-status` returns the same info as JSON:
   ```bash
   curl -sk https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal/api/data-status | jq
   ```
   Look for `mount.fstype` (`nfs4`/`efs` = persistent) and `sessions.fileCount`. If `mount` shows `"note": "not a mount point — ephemeral container layer"`, the task definition is missing a volume and logs will not survive restart.

### Key fargate files

| File | Role |
|---|---|
| `fargate/Dockerfile` | Test runner image — node:22-slim + AWS CLI v2 + Python + Playwright |
| `fargate/Dockerfile.judge` | Standalone judge image (local builds from project root) |
| `fargate/Dockerfile.judge-zip` | DEPRECATED — single-role image; use Dockerfile.hook-zip or Dockerfile.dashboard-zip |
| `fargate/Dockerfile.hook-zip` | Hook-role image for the AI Sandbox zip — flat layout, no awscli, defaults DREDD_ROLE=hook |
| `fargate/Dockerfile.dashboard-zip` | Dashboard-role image for the AI Sandbox zip — flat layout, no awscli, defaults DREDD_ROLE=dashboard |
| `fargate/docker-entrypoint-hook.sh` | Hook entrypoint baked into the hook zip (DREDD_ROLE default: hook) |
| `fargate/docker-entrypoint-dashboard.sh` | Dashboard entrypoint baked into the dashboard zip (DREDD_ROLE default: dashboard) |
| `fargate/docker-entrypoint-judge.sh` | DEPRECATED — single-role entrypoint; kept as a fallback for any legacy task def that boots the combined image |
| `fargate/api-server.cjs` | HTTP wrapper on port 3000 for the AI Sandbox ALB health check; provides `/run`, `/status`, `/logs` endpoints |
| `fargate/buildspec.yml` | CodeBuild spec — builds and pushes to ECR (`621978938576.dkr.ecr.eu-west-2.amazonaws.com`) |

The sandbox server's **IAM task role and Fargate task definition live in the CKO AI Sandbox platform's IaC**, not in this repo.

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
| `src/sensitive-env.ts` | Sensitive env-var detection (name + value heuristics) for log redaction |
| `src/web/dashboard.html` | Dark dashboard with live feed, sessions table, policies tab, logs tab |
| `hooks/dredd-hook.sh` | Single drop-in CLI hook for all events |
