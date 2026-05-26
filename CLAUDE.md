# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Judge AI Dredd is a PreToolUse defence system that intercepts tool calls from Claude Code (or any Claude Agent SDK app) and blocks goal-hijacking / prompt-injection attacks. It runs as an HTTP server (`src/server.ts`) that the CLI talks to via a single bash hook script (`hooks/dredd-hook.sh`), so it can be dropped into any project by editing `.claude/settings.json`.

## Production endpoints

The deployed prod stack lives in AWS account `110745800154` (eu-west-1) and the `acta.io` Route53 zone (`Z3ASY8UIU7J3MV`):

| Role | URL | Purpose |
|---|---|---|
| Hook | `https://dredd-hook.acta.io` | Hot path the CLI hook script POSTs to (`/intent`, `/evaluate`, `/track`, `/end`, `/pivot`, `/compact`, `/notification`). Bearer-API-key auth. |
| Dashboard | `https://dredd.acta.io` | Operator UI (sessions, live feed, approvals, API keys, logs, integration bundle). Clerk-gated. |

These hostnames are baked into `terraform/variables.tf` as the defaults for `hook_host` / `dashboard_host` (with `route53_zone_id` defaulting to the acta.io zone) — a fresh `tofu apply` in this repo targets prod with no extra flags. To deploy elsewhere, override those three vars in a `.tfvars`.

## Integrating another machine with this prod stack

For an additional developer or machine to start having their Claude Code sessions judged by the prod Dredd:

1. **Sign in to `https://dredd.acta.io`** with Clerk (Google SSO). On first sign-in the user gets a `user`-role identity scoped to their own sessions/keys; admins are hard-coded in `src/clerk-auth.ts` (see "Dashboard auth").
2. **API Keys tab → Generate key.** The plaintext key is shown ONCE — copy it into `~/.claude/dredd/api-key` (chmod 600). The key is hashed before storage; revoke from the same UI any time.
3. **Integration tab → Download bundle.** The dashboard ships a zip containing:
    - `dredd-hook.sh` — the hook script with `DREDD_URL=https://dredd-hook.acta.io` baked in (so no env-var setup is needed)
    - `settings.json.example` — drop-in for `~/.claude/settings.json` wiring the hook into UserPromptSubmit / PreToolUse / PostToolUse / Stop / SessionEnd / Notification
    - `README.txt` — install steps
4. **Drop the hook + settings into place**, restart Claude Code. Verify with `curl -H "Authorization: Bearer $(cat ~/.claude/dredd/api-key)" https://dredd-hook.acta.io/api/health`.

Bypassing the bundle is fine too — point your local hook at `DREDD_URL=https://dredd-hook.acta.io` via env var or by editing the first line of the shipped `hooks/dredd-hook.sh`. The hook is self-contained bash + jq + curl, no Node runtime needed on the client.

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
- `POST /notification` ← Notification hook. Increments per-session friction counter — fires every time Claude Code surfaces a permission/notification dialog to the user despite Dredd's PreToolUse decision. The only signal that Dredd allowed something but the user got prompted anyway. Counter is in-memory on the hook container (resets on container restart); read it back via `GET /api/notifications/:id` immediately after a run while sticky-session routing still pins to the same task.
- `GET /api/sessions`, `/api/session-log/:id`, `/api/feed`, `/api/policies` — feed the dashboard (`src/web/dashboard.html`).

**Backfill**: if `/evaluate` fires before `/intent` (Dredd restarted mid-session), it parses `transcript_path` (Claude's JSONL) to reconstruct intent + recent tool calls. If that fails it falls back to policy-only mode.

### 2. Three-stage PreToolUse pipeline (`src/pretool-interceptor.ts`)

1. **Policy engine** (`src/tool-policy.ts`) — instant, deterministic. `ALLOWED_TOOLS` (Read/Glob/Grep + curated MCP tools), `ALLOWED_BASH_PATTERNS`, `DENIED_BASH_PATTERNS`, `REVIEW_BASH_PATTERNS`. Splits chained commands on `&&`/`||`/`;`/`|` and evaluates each part. `checkDangerousCombination()` catches directory escape, write-then-execute, download-then-execute even when individual parts are allowed.
2. **Embedding drift** (`src/drift-detector.ts`) — ~50ms. Cosine similarity between tool call and intent via Ollama `nomic-embed-text`. High → allow, low → judge, middle → judge.
3. **LLM judge** (`src/intent-judge.ts`) — 1.4s Bedrock / 10–15s Ollama. Operates in clean context (no agent history). Returns `consistent` / `drifting` / `hijacked`. Has a partial-JSON parser fallback for truncated responses. **Only `hijacked` denies**; `drifting` allows but injects a goal anchor before the next turn. Judge errors fail-soft (return `drifting`, log to stderr) — a Bedrock outage surfaces as a warning rather than silently removing the judge from the defence stack.

The judge gets file-content context from `SessionTracker.getFileContextForJudge()` — this is how payload-splitting attacks are caught: assembled file content is fed to the judge when an execution command fires.

### 3. CLI integration (`hooks/dredd-hook.sh`)

Single bash script handling all hook events. Reads JSON from stdin, calls the right Dredd endpoint, prints JSON to stdout. **Fails open** if server is down (`permissionDecision: "ask"`). PostToolUse and Stop are fire-and-forget background curls so they don't block the agent. Install via `hooks/settings.json.example` — copy into `.claude/settings.json`.

**Self-contained delivery:** the `dredd-hook.sh` served via the integration bundle and `GET /api/hook-script` is **baked** by `src/hook-bake.ts` — `dredd-managed-allow.sh` is inlined in place of the repo's `source` directive so the delivered file has no external dependency. The repo hook sources the sibling lib at dev time; the baked version is a single self-contained script.

## Container images

The hook and dashboard run as two separate container images built from the same source tree. `DREDD_ROLE` (set by each image's entrypoint) selects which server boots. Designed to run on Fargate / ECS / any container runtime with an attached persistent volume for `$DATA_DIR` (`/data` by default — used for console logs and any disk fallback).

**IMPORTANT:** Always commit before building so the pre-commit hook bumps the version. The version prints on the landing page and in `/api/health` — without a bump you can't tell old and new deployments apart. Do NOT include `node_modules/` in the zip — the Dockerfile runs `npm install` during the Docker build. Always delete the old zip before rebuilding (zip appends, it doesn't replace).

**Deploying changes:** Code changes (server, dashboard, hooks, policy, etc.) are NOT picked up by running containers until a new image is built and the running task definition is updated to it. If you edit `src/`, `hooks/`, or any file that gets packaged, rebuild the image and redeploy — containers keep serving the previous version otherwise.

### Building the zips

There are **two role-specific zips** that share most of their content but
ship different entrypoints/Dockerfiles. Each zip's entrypoint defaults
`DREDD_ROLE` to its role so a task definition doesn't have to set the
env var. Both zips package the same `src/` — the role only selects
which server entry point boots. The zip format is what container-build
pipelines (CodeBuild, Cloud Build, etc.) commonly accept as a source
artifact; if you're building locally with `docker build`, you can skip
the zip step entirely.

| Zip | Default `DREDD_ROLE` | Image role |
|---|---|---|
| `judge-ai-dredd-hook.zip` | `hook` | hot-path service that Claude Code's hook script talks to |
| `judge-ai-dredd-dashboard.zip` | `dashboard` | operator UI: sessions, logs, policies, API keys |

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

### Building the Docker images locally

```bash
# Hook role
docker build -f fargate/Dockerfile.hook-zip \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  --build-arg GIT_DIRTY=$(if [ -n "$(git status --porcelain)" ]; then echo true; else echo false; fi) \
  -t judge-ai-dredd-hook .

# Dashboard role
docker build -f fargate/Dockerfile.dashboard-zip \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  -t judge-ai-dredd-dashboard .
```

### Combined single-role image

`fargate/Dockerfile.judge` builds a single image that boots either role based on `DREDD_ROLE` at runtime — handy for self-hosted setups that want one image. Designed to run with `/data` mounted from a persistent volume (EFS, an EBS volume, or a local bind mount during development).

```bash
docker build -f fargate/Dockerfile.judge \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  -t judge-ai-dredd .

# Run (all config via env vars)
docker run -p 3000:3000 \
  -v judge-data:/data \
  -e MODE=interactive \
  -e BACKEND=bedrock \
  -e AWS_REGION=eu-west-2 \
  judge-ai-dredd
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
| `STORE_BACKEND` | `memory` (default) — set to `dynamo` in production | Session state backend |
| `DYNAMO_TABLE_NAME` | `jaid-sessions` | DynamoDB table for session state |
| `DYNAMO_REGION` | `eu-west-1` | Region of the Dynamo table (distinct from Bedrock region) |
| `DYNAMO_API_KEYS_TABLE_NAME` | `jaid-api-keys` | DynamoDB table for hook API keys |
| `DYNAMO_USER_PERMISSIONS_TABLE_NAME` | `jaid-user-permissions` | DynamoDB table for per-(user, project) Claude Code allow/deny/ask lists uploaded by the hook |
| `DREDD_USER_PERMISSIONS_ENABLED` | `false` | Phase 6 rollout flag — when `true`, the PreToolUse pipeline reads the session's user-permissions snapshot and enforces user-deny / annotates user-allow. When `false`, uploads + storage + dashboard surfacing still work but the pipeline ignores the lists. Flip to `true` once the upload path has soaked |
| `DREDD_PATTERN_LEARNING_ENABLED` | `false` | Phase 8b umbrella flag. When `true`, `/evaluate` does one `listForScope` Query on `jaid-approvals` + one Bedrock embed per call, and folds matches with cosine ≥ 0.6 into the judge prompt as `<prior_approvals>` evidence of legitimate intent. Verdicts unchanged in soft-only mode |
| `DREDD_PATTERN_LEARNING_HARD_ENABLED` | `false` | Phase 8b hard-mode flag. Only consulted when the umbrella is `true`. When `true`, ≥2 matches with cosine ≥ 0.85 short-circuit the pipeline to `stage=pattern-trust-allow` BEFORE Stage 1 policy — overrides Dredd's hard denies (`rm -rf`, dangerous combinations) by design. Flip only after observing soft-mode telemetry |
| `DREDD_MANAGED_ALLOW_SCOPE` | `conservative` | **Hook-side env var.** Picks which patterns Dredd splices into the project's `.claude/settings.local.json` on every UserPromptSubmit so Claude Code stops re-prompting for tool calls Dredd already authorises. `conservative` = ~19 read-only / inspection patterns (Read, Glob, Grep, awk/sed/grep/ls/cat/head/tail/wc/echo/pwd/file/date/jq/find/rg/node --check). `off` = never splice anything |
| `DREDD_MANAGED_ALLOW_RULES` | (unset) | **Hook-side env var.** Optional operator override — a raw JSON array that replaces the scope-driven defaults. e.g. `'["Bash(awk:*)","Read"]'` |
| `DREDD_MANAGED_DIR` | `$HOME/.claude/dredd/managed` | **Hook-side env var.** Where Dredd writes per-(project, session) sidecars tracking which allow rules it has injected. Also holds `manage.log` for audit |
| `DREDD_MANAGED_SIDECAR_STALE_SECS` | `86400` | **Hook-side env var.** Sidecar age (seconds) before the next UserPromptSubmit sweeps it as a crash-recovery measure. Lower for tests |
| `DREDD_ROLE` | `hook` | Container role: `hook` (hot path + feed + mode) or `dashboard` (UI + session listing) |
| `DREDD_HOOK_URL` | (unset) | On the dashboard container, the URL the browser will POST /api/feed + /api/mode to |
| `DREDD_DASHBOARD_ORIGIN` | (unset) | On the hook container, the CORS Origin the dashboard is served from |
| `DREDD_AUTH_MODE` | `required` | `off` / `optional` / `required` — hook Bearer-key enforcement |
| `CLERK_SECRET_KEY` | (unset) | **Dashboard role only.** Clerk secret used by `verifyToken` to validate session JWTs on every `/api/*` request. Without it the dashboard returns 503 on `/api/*` |
| `CLERK_PUBLISHABLE_KEY` | (unset) | Clerk publishable key (`pk_test_…` / `pk_live_…`) injected into the dashboard HTML AND the hook container's landing page (`GET /`) so the browser can bootstrap `@clerk/clerk-js`. The hook page is gated on Clerk sign-in even though the hook's `/intent`, `/evaluate`, `/track`, etc. API endpoints remain on Bearer-API-key + CORS — the gate is presentation-only. `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is read as a fallback. If unset on a role, that role's HTML page stays gated with "auth not configured" |
| `CLERK_JWT_PUBLIC_KEY` | (unset) | **Dashboard role only.** Static PEM (or JWK JSON) for Clerk's session-token signing key. When set, `verifyToken` skips the network JWKS fetch entirely — required when the container can't reach `api.clerk.com` / `*.clerk.dev` due to firewall rules. Get the JWKS from `https://<frontend-api>/.well-known/jwks.json`; paste either the JWK or its PEM export |
| `DYNAMO_BYOT_TABLE_NAME` | `jaid-byot` | DynamoDB table for per-user BYOT Bedrock token configs (encrypted at the app layer by `ByotCrypto`) |
| `DREDD_BYOT_ENABLED` | `false` | Hot-path resolver gate. When `true`, `/evaluate` resolves a per-user `BedrockAuth` and threads it to the judge, drift detector, and embedding calls. When `false`, all Bedrock calls use the platform task role. The dashboard write path + storage work regardless — flip to `true` once the write path has soaked |
| `BYOT_KMS_KEY_ID` | (from `var.sse_kms_key_arn`) | ARN or key-ID of the KMS key used by `KmsByotCrypto` to envelope-encrypt user tokens. Reuses the stack's existing SSE KMS key by default (set via terraform). `FakeByotCrypto` is used when the store backend is `memory` and no key is configured |

Session logs: see the **Session storage** note below — Dynamo-backed when `STORE_BACKEND=dynamo`, otherwise in-process memory. Console logs (`dredd-YYYY-MM-DD.log`) still live on disk in `$DATA_DIR/logs/` and are viewable via the dashboard (Logs tab).

### Dashboard auth (Clerk)

Sign-in is required to view anything on the dashboard. Clerk verifies session JWTs server-side via `@clerk/backend` (`src/clerk-auth.ts`).

There are two roles, hard-coded by email in `src/clerk-auth.ts`:

- **admin** — `adrian.asher@checkout.com`, `adrianasher30@gmail.com`. Can list every user's API keys and sessions, view console logs, toggle the global trust mode, and download the integration bundle.
- **user** — any other Clerk-authenticated identity. Sees only sessions whose `ownerSub` matches their Clerk userId, only their own API keys, no mode toggle, no console logs.

Sessions are tied to Clerk identity via the API key path: when a user generates an API key from the dashboard's API Keys tab, the key's `ownerSub` is set to their Clerk userId. The hook server stamps this `ownerSub` on each session in `setSessionOwner` at `/intent` time. Dashboard `/api/sessions` filters on it for non-admin users.

Adding an admin requires a code change to `ADMIN_EMAILS` in `src/clerk-auth.ts` and a redeploy — there is no env-var override.

## Two-container architecture

Production deployments run **two services** behind separate URLs that share the same source. `DREDD_ROLE` picks which role boots.

| Role | What it does |
|---|---|
| `hook` (default) | Hot path: `POST /intent`, `/evaluate`, `/track`, `/end`, `/pivot`, `/compact`, `/register`. Plus status: `/health`, `/api/health`, `/api/data-status`, `/api/whoami`. Plus runtime toggle: `POST /api/mode`. Plus the in-memory feed ring: `GET /api/feed`. Runs the Bedrock/Ollama preflight. Authenticates hook Bearer tokens. Landing page at `GET /` (Clerk-gated). |
| `dashboard` | UI: `GET /` (dashboard HTML), `/api/sessions`, `/api/session-log/:id`, `/api/policies`, `/api/logs*`, `/api/integration-bundle`, `/api/whoami`. Clerk-gated. No judge preflight. |

Cross-container calls go **from the browser**:
- Dashboard HTML → `$DREDD_HOOK_URL/api/feed` (live events)
- Dashboard HTML → `$DREDD_HOOK_URL/api/mode` (trust mode toggle)
- Dashboard HTML → `$DREDD_HOOK_URL/api/health` (version + active session count)

The hook container serves CORS headers scoped to `$DREDD_DASHBOARD_ORIGIN` on `/api/feed`, `/api/mode`, and `/api/health`.

Why split: the dashboard's slow DynamoDB reads shouldn't share an event loop with the hook's hot path. Splitting also lets the dashboard live behind its own auth boundary while the hook keeps using Bearer API keys for tool calls. Single image; the entrypoint just sets `DREDD_ROLE`.

**Source files:**
- `src/server.ts` — thin dispatcher, reads `DREDD_ROLE`
- `src/server-core.ts` — shared plumbing (CONFIG, stores, auth, body caps, path validation, backfill, `buildSessionLogShape`)
- `src/server-hook.ts` — hook endpoints + feed + mode + health + CORS
- `src/server-dashboard.ts` — dashboard HTML + sessions + logs + integration bundle. Injects `window.DREDD_HOOK_URL` into the served HTML so the page knows where cross-origin calls go.

## Session storage

When `STORE_BACKEND=dynamo`, the server uses a **DynamoDB-backed `SessionStore`** (`src/dynamo-session-store.ts`) wrapped in a write-through LRU cache (`src/cached-session-store.ts`). Behaviour:

- **Every state mutation is persisted synchronously** to `jaid-sessions` (region `$DYNAMO_REGION`) — `/intent`, `/evaluate`, `/track`, `/pivot`, `/compact`, `/end` all write to Dynamo as part of the request.
- **Reads hit the in-container cache first**; cache miss triggers a Query across all sort keys under `SESSION#<session_id>` to reconstruct full state.
- **Sticky-session cookies** (wired into `hooks/dredd-hook.sh` via a per-session `~/.claude/dredd/cookies/<session_id>.jar`) pin a session to one container so the cache stays hot. Task replacement surfaces as a transparent cache miss + `loadSession()` round-trip — no loss of session state.
- **No more `results/*.json` on disk.** Dashboard endpoints (`/api/sessions`, `/api/session-log/:id`) assemble the old JSON shape from Dynamo on demand; legacy `results/*.json` files still surface as a fallback.
- **Selection**: `STORE_BACKEND=memory` (default) for local dev, `STORE_BACKEND=dynamo` in production. The entrypoint scripts set the production default for the hook and dashboard images.

Per-session item shape:
- `pk = SESSION#<session_id>`, `sk = META | TURN#<n> | TOOL#<turn>#<seq> | FILE#W#<pathHash> | FILE#R#<ts>#<seq> | ENV#<name> | METRIC#<n> | PIVOT#<ts>`
- GSI1 (`gsi1pk = "SESSION"`, `gsi1sk = startedAt`) is set only on META for cheap dashboard listing
- TTL `ttl` (epoch seconds), 30d, refreshed on every write

### Checking `/data` persistence

Console logs (and any legacy on-disk session fallbacks) only survive container restart if `$DATA_DIR` is backed by a real volume — EFS, an EBS volume, or a host bind mount. Two ways to verify:

1. **At startup** — the entrypoint scripts (`fargate/docker-entrypoint-{hook,dashboard,judge}.sh`) print the `/proc/mounts` line for `$DATA_DIR`, total bytes, existing session/log file counts, and the newest 3 session filenames. Check the container's stdout on boot.
2. **On a running container** — `GET /api/data-status` returns the same info as JSON:
   ```bash
   curl -sk https://<hook-host>/api/data-status | jq
   ```
   Look for `mount.fstype` (`nfs4`/`efs` = persistent) and `sessions.fileCount`. If `mount` shows `"note": "not a mount point — ephemeral container layer"`, the task definition is missing a volume and logs will not survive restart.

### Key fargate files

| File | Role |
|---|---|
| `fargate/Dockerfile.hook-zip` | Hook-role production image — flat layout, no awscli, entrypoint defaults `DREDD_ROLE=hook` |
| `fargate/Dockerfile.dashboard-zip` | Dashboard-role production image — flat layout, no awscli, entrypoint defaults `DREDD_ROLE=dashboard` |
| `fargate/Dockerfile.judge` | Combined single-role image — boots either role at runtime via `DREDD_ROLE` env var. Useful for self-hosted setups that want one image |
| `fargate/docker-entrypoint-hook.sh` | Hook entrypoint baked into the hook image |
| `fargate/docker-entrypoint-dashboard.sh` | Dashboard entrypoint baked into the dashboard image |
| `fargate/docker-entrypoint-judge.sh` | Combined-image entrypoint — sets defaults shared by both roles |

The container runtime (Fargate task definition / ECS service / etc.) and its IAM task role are not part of this repo — see **Infrastructure** below for what is owned here.

## Infrastructure

This repo owns the **full prod stack** in `terraform/` (OpenTofu, S3 backend, account `110745800154` / eu-west-1). A fresh `tofu apply` stands up everything behind `dredd-hook.acta.io` / `dredd.acta.io`:

| File | Resource |
|---|---|
| `terraform/vpc.tf` | VPC wiring — the extra public subnet the ALB needs for a 2nd AZ |
| `terraform/security-groups.tf` | ALB SG (443/80 from internet) + task SG (3000 from ALB only) |
| `terraform/alb.tf` | Application Load Balancer, HTTPS listener, host-based routing to the hook / dashboard target groups (hook TG has `lb_cookie` stickiness) |
| `terraform/alb-access-logs.tf` | S3 bucket + delivery policy for ALB access logs (per-request client-IP forensics; AES256-only, lifecycle expiry via `alb_access_logs_retention_days`) |
| `terraform/acm.tf` / `terraform/dns.tf` | ACM cert (DNS-validated) + Route53 A-aliases to the ALB |
| `terraform/ecr.tf` | ECR repos for the hook + dashboard images |
| `terraform/ecs-cluster.tf` / `ecs-hook.tf` / `ecs-dashboard.tf` | Fargate cluster + the two services/task-defs |
| `terraform/secrets.tf` | Secrets Manager entries (Clerk keys) injected into tasks |
| `terraform/logs.tf` | CloudWatch log groups (retention `log_retention_days`, default 180) |
| `terraform/iam.tf` | Task-exec + per-role task IAM (Dynamo, Bedrock, Secrets, SSE KMS) |
| `terraform/jaid-sessions.tf` / `jaid-api-keys.tf` / `jaid-approvals.tf` / `jaid-user-permissions.tf` | The four DynamoDB tables |
| `terraform/variables.tf` / `versions.tf` / `outputs.tf` | Inputs (incl. `sse_kms_key_arn`), provider pin, outputs |

**Deploys are CLI-owned, not terraform-owned.** The documented workflow (build image → push to ECR → `aws ecs update-service --force-new-deployment`) registers new task-def revisions and repoints the service outside terraform. So both ECS services set `lifecycle { ignore_changes = [task_definition, desired_count] }` — terraform defines the infra but the CLI is the source of truth for the running revision. **Do not** remove that ignore unless you intend terraform to own deploys (it would otherwise revert the live service to whatever revision is in state on the next apply). Bump `image_tag` + apply only if you deliberately want a terraform-driven deploy.

The DynamoDB tables and SSE KMS key were originally created manually; the Terraform is import-compatible with their current shape (see `terraform/README.md`). The SSE KMS key is referenced by ARN only — managed externally.

**Out of scope:** the CI/CD pipeline that builds the images, and the EFS/persistent-volume wiring if you attach one for `$DATA_DIR`.

### Client-IP capture & ALB access logs

The Fargate tasks sit behind the ALB, so the only IP a task sees is the ALB-appended trailing `X-Forwarded-For` hop. `getClientIp()` in `src/server-core.ts` reads that **rightmost** hop (the leftmost is client-spoofable; the task SG only accepts ALB traffic, so the trailing hop is the trustworthy one — relies on the ALB's default XFF *append* mode). Every hot-path request logs a `[REQ] <ip> <method> <path>` access line (health/status endpoints excluded), and `/intent` stamps the IP onto the session's Dynamo META (`clientIp`, first-write-wins) for a durable session↔IP join surfaced in the session-log shape. Independently, `alb-access-logs.tf` enables ALB access logs to S3 for a request-level record that doesn't depend on the app.

## Trust modes — decision semantics on `permissionDecision`

When the three-stage pipeline returns `!allowed`, the response shape depends on the trust mode:

| Mode | `permissionDecision` | Effect | Use case |
|---|---|---|---|
| **autonomous** | `deny` | Hard-block — the agent gets a rejection it must work around | No human in the loop; Dredd enforces |
| **interactive** | `ask` | Surfaced to the user as a permission prompt with Dredd's reasoning | Human-in-the-loop; Dredd warns, user adjudicates |
| **learn** | (no decision returned) | Claude Code falls back to user permission config; Dredd logs only | Shadow mode for measurement |

The `ask` decision in interactive mode reads `permissionDecisionReason` as a user-facing warning (e.g. "this tool call looks suspicious. Similarity 0.07 < threshold 0.15. Review and approve only if this matches your intent.").

The catastrophic case (session-locked after N consecutive hijack verdicts) hard-denies in *all* modes — at that point Dredd no longer trusts the session at all and the user must explicitly flip the per-session mode to learn or autonomous via the dashboard.

## Drift thresholds

Configurable in tracker: `<0.2` on-task, `0.2–0.3` scope-creep (inject reminder), `0.3–0.5` drifting (escalate to judge), `>0.5` hijacked (block).

## Cost & cache-engagement notes

`GET /api/bedrock-metrics` (admin-only Bearer API key) returns in-process per-caller stats: calls, cacheHits, cachedTokenShare, avgInputTokens, estimatedCostUsd. The judge log line in `pretool-interceptor.ts` also carries `in=N/cr=N/cw=N out=N` per call for ad-hoc CloudWatch greps.

**Known issue (2026-05-21, deferred — apply when scaling): prompt cache silently disabled on `eu.anthropic.claude-sonnet-4-6`.** The AWS docs say Sonnet 4.6's minimum cacheable prefix is 1,024 tokens. Empirically on the EU cross-region inference profile the cutoff is closer to **~2,048 tokens**. Our B7.1 system prompt is ~1,766 tokens — under the real threshold — so Bedrock silently skips the cache point and the entire system prompt is billed as uncached input on every call. Confirmed via direct boto3 test: 1,994-token prefix → 0 cache writes; 2,108-token prefix → 2,096 written then read on the next call.

When we scale beyond a single user it'll be worth fixing. The cheapest fix is to add ~300 tokens of static "operating notes / reference examples" at the END of the B7.1 system prompt (`intent-judge.ts` HARDENED_V2_SYSTEM_PROMPT). Padding must be byte-identical across calls to keep the cache key stable. Cost math on the deferred fix:

- One-time write per 5-minute window: 300 padding tokens × $4.125/M = $0.0012
- Savings per cache read: ~2,200 cached tokens × ($3.30 − $0.33)/M = $0.0065
- Break-even at <1 cache hit per write window; with the current judge rate the cache discount drops Sonnet input cost by roughly 40–50% on steady-state traffic.

If we ever cut over to a different model ID (e.g. `anthropic.claude-sonnet-4-6` without the `eu.` prefix, or Claude Sonnet 4.7), re-run the threshold probe via the boto3 snippet in commit history before relying on the documented minimum.

## User permissions — Claude Code allow/deny/ask integration

Two independent features that both touch Claude Code's `permissions.{allow,deny,ask}` configuration. Both ship in the hook + server; both are env-gated.

### 1. Server-side user-permissions snapshot

Every UserPromptSubmit, the hook reads the merged `.permissions.{allow,deny,ask}` from `~/.claude/settings.json`, `$CWD/.claude/settings.json`, and `$CWD/.claude/settings.local.json` (local-wins precedence, sorted + deduped). Uploads a hash + payload to `/intent`:

- **Always sends `user_permissions_hash`** when the user has any rules configured.
- **Sends the full `user_permissions: { allow, deny, ask }` payload only when**:
  - First upload for this (user, project), OR
  - Hash differs from the local cache (`~/.claude/dredd/perm-state/<projectHash>.json`), OR
  - Heartbeat: every 50 prompts or every 24h (whichever first).

Server stores per-(ownerSub, projectRootHash) in `jaid-user-permissions` (Phase 2a). On every `/intent` it copies the lists into the session's META row so `/evaluate` can read them off the hot path without a cross-session lookup. If the hook sends a hash the server doesn't recognise, it replies `{ user_permissions_resync: true }`; the hook clears its local cache and re-sends the full payload next prompt.

**Pipeline integration** (Phase 4) is gated on `DREDD_USER_PERMISSIONS_ENABLED`. When enabled:

| Combination | Verdict |
|---|---|
| User-deny matches | **deny** (Stage 0 short-circuit, judge never runs) — forced hard-deny even in interactive mode |
| User-allow matches a tool the pipeline already allowed | **allow** with `userPermissionMatch: { kind: "allow", rule }` annotation (informational only) |
| User-allow matches a tool the pipeline would deny | **deny** stands; reason text gains `" — note: matches your allow list, but Dredd's checks deny"` |

User-allow **never** weakens a Dredd deny — `tool-policy.ts` dangerous-combo deny and `pretool-interceptor.ts` Stage 1 deny always win. User-deny is additive: Dredd is at least as restrictive as the user.

### 2. Hook-managed `settings.local.json` (Phase 7)

Independent of the snapshot feature. The hook splices a conservative set of allow rules into `$CWD/.claude/settings.local.json` on every UserPromptSubmit so Claude Code stops surfacing its native permission prompt for tool calls Dredd already authorises (the friction problem behind the original 19-prompt screenshot).

Scope is selected via `DREDD_MANAGED_ALLOW_SCOPE`:

- `conservative` (default) — ~19 read-only / inspection patterns (`Read`, `Glob`, `Grep`, `Bash(awk:*)`, `Bash(sed:*)`, …). NOT `rm`, `curl`, `git push`, `sudo` — those still need Dredd's judgement.
- `off` — never splice anything.
- `DREDD_MANAGED_ALLOW_RULES='["custom","rules"]'` overrides the scope's default set entirely.

**Lifecycle** (all in `hooks/dredd-managed-allow.sh`, sourced by `dredd-hook.sh`):

| Event | Action |
|---|---|
| UserPromptSubmit (top of branch) | Sweep stale sidecars older than `DREDD_MANAGED_SIDECAR_STALE_SECS` (24h default). For each, if no other sidecars for the project, strip the stale sidecar's rules from `settings.local.json`. |
| UserPromptSubmit (after `/intent` returns 200) | Reconcile: compute `add = desired - prior`, `remove = prior - desired`, apply both to `settings.local.json` atomically, refresh sidecar. Idempotent. |
| SessionEnd | If no other sidecars for this project, strip this session's rules from `settings.local.json`. Always delete the sidecar. |

**Refcount safety**: rules stay in `settings.local.json` as long as *any* sidecar references them. Sidecar presence is the refcount — no separate counter.

**User rules are untouched**: only the rules listed in the sidecar's `rulesManaged` are added/removed. Anything else in `permissions.allow` (the user's own entries, other tools' contributions) is preserved verbatim. Atomic writes via `mktemp + mv` ensure no clobber on concurrent UserPromptSubmits.

**Audit**: every add/remove appends a one-line entry to `$DREDD_MANAGED_DIR/manage.log` with action (`add` / `remove` / `session-end-*` / `sweep-*` / `manual-cleanup-*`), session, project hash, and the rules touched.

**Manual recovery**: `hooks/dredd-cleanup.sh` is a standalone CLI that flushes Dredd-managed rules + sidecars on demand. `--project <path>` (default `$PWD`), `--all`, `--dry-run`, `--yes` (skip prompt), `--quiet`, `--help`. Useful when debugging or after uninstalling Dredd.

### How the snapshot feature avoids hashing its own writes

`build_user_permissions_payload` in `dredd-hook.sh` reads each settings layer separately and subtracts the sidecar's `rulesManaged` from the project-local layer **before** merging. Without this, every UserPromptSubmit would see new rules in `settings.local.json` (that Dredd itself just wrote), recompute a new hash, and trigger a full re-upload — defeating the cache. The subtraction means the snapshot reflects the user's intent, not Dredd's injection.

Caveat: a user who manually duplicates a Dredd-managed rule into their own `settings.local.json` will see it drop from the snapshot. Their `~/.claude/settings.json` and project-shared `$CWD/.claude/settings.json` entries are unaffected.

### 3. Approval pattern-trust (Phase 8)

Layers on top of the existing approval-learning (`src/approval-store.ts`, `jaid-approvals`). Every PostToolUse that promotes a pending approval to a durable record now also stores an **embedding** of `JSON({tool, fingerprintJson})` alongside the existing `goalEmbedding` (Phase 8a, `src/handlers/track.ts`). Best-effort: a Bedrock blip stores `[]` and the approval still lands.

At `/evaluate` time (Phase 8b), with `DREDD_PATTERN_LEARNING_ENABLED=true`:

1. **Stage 0.5: pattern-trust** runs after user-deny, before Stage 1 policy. `approvals.listForScope({ownerSub, projectRoot})` returns every live approval in scope; the interceptor embeds the current call once and cosine-similar-compares against each.
2. **Soft path** (always when umbrella on): top 5 matches with cosine ≥ `SOFT_THRESHOLD` (0.6) get rendered into `<prior_approvals>` in the judge's system prompt as evidence of legitimate intent. The judge still decides — soft context is one signal among several.
3. **Hard path** (`DREDD_PATTERN_LEARNING_HARD_ENABLED=true`): ≥ `HARD_MIN_COUNT` (2) matches at cosine ≥ `HARD_THRESHOLD` (0.85) short-circuit to `stage="pattern-trust-allow"` — **overrides Dredd's hard denies** (`DENIED_BASH_PATTERNS`, dangerous combinations). By design: a user who has consented to `rm -rf` twice in this project is trusted to do it again.

What still wins over pattern-trust:

| Signal | Beats pattern-trust? |
|---|---|
| `userPermissions.deny` rule match | Yes — Stage 0 user-deny fires first |
| Hijack-locked session (autonomous mode) | Yes — handled in the handler before interceptor runs |
| Hard path disabled | Yes — only soft signal flows |
| Empty `priorApprovals` (umbrella off OR no rows) | Yes — Stage 0.5 is a no-op |
| Intent-drift backstop on the existing fingerprint-exact path | Approval lookup excludes drift-stale rows — applies to the pattern-trust lookup too via `listForScope` |

Thresholds (constants in `pretool-interceptor.ts` for now; env-tunable later when telemetry warrants):
- `SOFT_THRESHOLD = 0.6`, `HARD_THRESHOLD = 0.85`, `HARD_MIN_COUNT = 2`, `JUDGE_CONTEXT_LIMIT = 5`.

`InterceptionResult.patternTrust` carries `{ hard, matched, topSim, topSummary }`; the dashboard renders a `trust×N` chip on the live feed + Tool Calls table (Phase 8c). The session-detail JSON's `interceptorLog` includes the same field per call so historical analysis is straightforward.

### 4. BYOT — per-user Bedrock token

Lets a user supply their own Amazon Bedrock API key (+ region) so that all per-session Bedrock calls — judge, classifier, and drift embeddings — run on their AWS account. Scope is every Bedrock call in the hot path; the startup connectivity preflight remains on platform creds. Fail-soft: if a bearer call fails on an auth or throttle error, the pipeline retries on the platform task role and records the fallback on the BYOT record.

**Storage:** `jaid-byot` DynamoDB table. One item per Clerk user: `pk = USER#<ownerSub>`, `sk = BYOT`. The token is KMS-encrypted at the application layer (`src/byot/byot-crypto.ts`; `KmsByotCrypto` in production, `FakeByotCrypto` for local `STORE_BACKEND=memory` without a KMS key); table SSE adds at-rest encryption on top. No TTL — config persists until the user removes it.

**`CredentialProvider` seam** (`src/byot/credential-provider.ts`): `DefaultCredentialProvider` always returns `{kind:"default"}` (platform role); `BearerCredentialProvider` reads the `jaid-byot` row, decrypts the token, and caches the result in-process for 5 minutes. The seam is extensible — an `assume-role` variant can slot into `BedrockAuth` without call-site churn. Both providers fail-soft: a decrypt error or missing row returns `{kind:"default"}` and never throws.

**Dashboard write path** (`POST /api/byot`): before storing, `ByotService.validateAndStore` runs a capability probe (`src/byot/capability-probe.ts`) against every distinct model the pipeline uses (judge + embedding). All must pass in the user's chosen region; partial failure returns the failing model list to the UI. `GET /api/byot` returns a non-sensitive `ByotConfigStatusView` (exposes `last4`, `status`, `region` — never the token or ciphertext). `DELETE /api/byot` removes the row.

**Fallback telemetry:** a runtime auth failure writes `status="runtime-fallback"`, `lastFallbackAt`, `lastFallbackReason` directly onto the BYOT record (`ByotStore.markRuntimeFallback`). Surfaced by `GET /api/byot` and shown as a warning banner on the dashboard BYOT tab. The hook task role has `dynamodb:UpdateItem` on `jaid-byot` for this write.

**Gating:** `DREDD_BYOT_ENABLED` gates only the hot-path resolver. The dashboard write path, `jaid-byot` storage, and `GET /api/byot` work regardless of the flag — store and soak before enabling the hot path.

### Test surface

```
hooks/tests/test_user_permissions_upload.sh         # Phase 1: hook hash-cache + upload protocol  (34)
hooks/tests/test_phase7a_managed_allow.sh           # primitives                                   (35)
hooks/tests/test_phase7b_reconcile.sh               # UserPromptSubmit reconcile                   (21)
hooks/tests/test_phase7c_cleanup.sh                 # SessionEnd + stale sweep                     (22)
hooks/tests/test_phase7d_cleanup_cli.sh             # hooks/dredd-cleanup.sh CLI                   (17)
hooks/tests/test_phase2b_intent.ts                  # server store + tracker round-trip           (17, npx tsx)
hooks/tests/test_phase3_matcher.ts                  # pattern matcher                              (46, npx tsx)
hooks/tests/test_phase4_pipeline.ts                 # interceptor integration                      (17, npx tsx)
hooks/tests/test_phase8a_approval_embedding.ts      # ApprovalRecord.inputEmbedding round-trip      (8, npx tsx)
hooks/tests/test_phase8b_pattern_trust.ts           # Stage 0.5 against stub /api/embed           (10, npx tsx)
hooks/tests/test_byot_crypto.ts                     # FakeByotCrypto encrypt/decrypt + context      (3, npx tsx)
hooks/tests/test_byot_store.ts                      # InMemoryByotStore + DynamoByotStore           (9, npx tsx)
hooks/tests/test_byot_provider.ts                   # BearerCredentialProvider cache + fail-soft    (9, npx tsx)
hooks/tests/test_byot_client.ts                     # per-credential Bedrock client cache keying    (4, npx tsx)
hooks/tests/test_byot_probe.ts                      # capability probe against stub Bedrock         (varies, npx tsx)
hooks/tests/test_byot_pipeline.ts                   # provider + service end-to-end round-trip      (5, npx tsx)
```

All green at last full run. The bash suites are self-contained (mktemp sandboxes + python stub HTTP server); the `.ts` ones run via `npx tsx`.

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
| `src/user-permission-matcher.ts` | Pattern matcher for Claude Code `permissions.{allow,deny}` syntax (Bash prefix, path globs, WebFetch domain, MCP names) with asymmetric chained-Bash semantics |
| `src/user-permissions-store.ts` | Interface + `InMemoryUserPermissionsStore` for the per-(user, project) snapshot |
| `src/dynamo-user-permissions-store.ts` | `DynamoUserPermissionsStore` against `jaid-user-permissions` |
| `hooks/dredd-hook.sh` | Single drop-in CLI hook for all events |
| `hooks/dredd-managed-allow.sh` | Sourced primitives + reconcile / cleanup / sweep functions for the Phase 7 managed-allow feature |
| `hooks/dredd-cleanup.sh` | Standalone CLI for manual recovery of managed-allow state |
| `src/byot/types.ts` | `BedrockAuth` union + `ByotConfigRecord` / `ByotConfigStatusView` types |
| `src/byot/byot-crypto.ts` | `ByotCrypto` interface; `KmsByotCrypto` (production) + `FakeByotCrypto` (local/test) |
| `src/byot/credential-provider.ts` | `CredentialProvider` seam; `DefaultCredentialProvider` (flag-off) + `BearerCredentialProvider` (decrypt + in-process cache) |
| `src/byot/capability-probe.ts` | `probeRegionCapabilities` — validates a token against every pipeline model before storage |
| `src/byot/byot-service.ts` | Write-path orchestration: validate → encrypt → store; `getStatus`; `remove`; delegates to store/crypto/probe |
| `src/byot-store.ts` | `ByotStore` interface + `InMemoryByotStore` |
| `src/dynamo-byot-store.ts` | `DynamoByotStore` against `jaid-byot` (pk=`USER#<ownerSub>`, sk=`BYOT`); `markRuntimeFallback` uses conditional `UpdateItem` |
| `src/hook-bake.ts` | `buildBakedHook` — inlines `dredd-managed-allow.sh` + bakes `DREDD_URL`; used by both the integration bundle and `/api/hook-script` |
| `terraform/jaid-byot.tf` | `jaid-byot` DynamoDB table (PAY_PER_REQUEST, SSE via `var.sse_kms_key_arn`, PITR, no TTL) |
