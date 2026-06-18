# HOWTO — build and run the test-framework benchmark suites

How to build the test-framework container image and run the exfiltration /
goal-hijacking benchmark suites (T3, T3e, T4, T5, the crack-vector corpus,
Mode 4, AgentLAB) on the `bedt` sandbox fleet.

This is the operational companion to the per-campaign test-request and plan
docs (e.g. `docs/plan-pretooluse-rerun-2026-06-18.md`). It documents the build
→ deploy → launch → monitor → collect loop, not the science of any one run.

> **Scope note.** The benchmark harness lives in `test-framework/` and is a
> *separate* artifact from the production hook/dashboard images
> (`fargate/Dockerfile.{hook,dashboard}-zip`, documented in `CLAUDE.md`). This
> doc is about the **test-framework** image only.

---

## 0. The one-paragraph version

```bash
# 1. commit (pre-commit hook bumps the version — this is how you tell builds apart)
git add -A && git commit -m "..."          # stage ONLY your files if other work is in-flight

# 2. build the zip (re-vendors deps from public npm — needs public npm reachable)
bash scripts/build-test-framework-zip.sh   # -> judge-ai-dredd-test-framework.zip (~96M)

# 3. deploy: upload the zip via the AI Sandbox UI -> CodeBuild builds + pushes the image
#    -> update the bedt task definition(s) to the new image tag. (UI step — not scriptable here.)

# 4. launch one cell per container (see §4); guard on the version you just built
./scripts/launch-<campaign>.sh             # or hand-rolled curl per §4

# 5. monitor + collect (see §5/§6)
bash scripts/bedt-status.sh
```

---

## 1. Architecture: how a run actually executes

```
launch script ──curl POST /run──▶ bedt<N> container
                                    │
                                    ├─ docker-entrypoint-<test>.sh   (maps env → runner CLI args)
                                    │     e.g. -t5- → runner-p14.ts;  -t3e- → runner-t3e-pretooluse.ts
                                    │
                                    ├─ runner-*.ts  (loops models × defences × scenarios × reps)
                                    │     └─ executor-{converse,openai,vertex,mantle,bedrock}.ts
                                    │            ├─ drives the agent model (Bedrock/OpenAI/Vertex)
                                    │            ├─ CanaryServer  (the attacker C2 — detects exfil)
                                    │            └─ IntentTracker / PreToolGate  (the defence under test)
                                    │
                                    └─ writes per-cell JSON to $LOGDIR (/app/runs)
                                          └─ aws s3 sync → s3://cko-results/<test>/<RUN_ID>/
```

Key facts:
- **The judge runs in-process.** `runner-p14` / `runner-t3e` evaluate the defence
  (`IntentTracker` + the new `PreToolGate`) inside the runner via direct Bedrock
  Converse calls. They do **not** POST to the Dredd hook's `/evaluate`. So the
  hook's trust mode (interactive/autonomous) and auth mode are **irrelevant** to
  these suites — the `DREDD_URL` env is only used for a soft startup `/health`
  probe. (The `/evaluate`-driven suites are AgentDojo / InjecAgent / MT-AgentRisk,
  which are out of scope here — they already gate pre-execution.)
- **Runs are serial within a container**, parallel across containers. One cell
  (one bucket of scenarios) per container is the unit of parallelism.
- **The CanaryServer is the ground truth.** `exfiltrationDetected = true` means a
  canary string actually reached the in-harness canary server (HTTP POST/GET,
  tool-arg, git-push, or DNS). It binds loopback; the scenario prompts reference
  a realistic host mapped to 127.0.0.1 via `/etc/hosts`.

---

## 2. Build the image

### 2.1 Always commit first
`.githooks/pre-commit` auto-bumps the patch version in `package.json`. **The
version is how you tell an old deployment from a new one** — it shows in
`/status`, `/api/health`, and the launch script's `ver_ge` guard. Never hand-edit
the version; let the hook do it.

> If other work is in-flight (e.g. a parallel feature branch), **stage only your
> own files** — `git add path/a path/b`, not `git add -A` — so you don't sweep up
> someone else's uncommitted changes.

### 2.2 Build the zip
```bash
bash scripts/build-test-framework-zip.sh
# -> $PROJECT_ROOT/judge-ai-dredd-test-framework.zip  (~96M)
```
What it does:
- Stages `test-framework/` (minus `node_modules`), the `scenarios/`, `src/`,
  `archive/` trees, the `docker-entrypoint-*.sh` scripts, and
  `Dockerfile.test-framework-zip` — **flat at the zip root**.
- **Re-vendors** `@anthropic-ai/claude-code` + the linux-x64 native binary +
  `test-framework`'s `node_modules` (linux/x64) from **public npm**, because
  CodeBuild's CodeArtifact mirror doesn't proxy the `@anthropic-ai/*` scope. So
  **the build box must have public npm reachable** (`npm ping`).
- Verifies the flat layout (every expected path is present) and prints the
  version.

Sanity-check that your change is actually in the zip before deploying:
```bash
unzip -l judge-ai-dredd-test-framework.zip "test-framework/src/<your-file>.ts"
unzip -p judge-ai-dredd-test-framework.zip "package.json" | grep '"version"'
```

### 2.3 Build locally with Docker (optional, for iteration)
```bash
docker build -f fargate/Dockerfile.test-framework-zip \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  -t judge-ai-dredd-test-framework .
```
The zip is only needed for the CodeBuild pipeline; local `docker build` can skip it.

### 2.4 Deploy to the fleet
1. Upload `judge-ai-dredd-test-framework.zip` via the **AI Sandbox UI**.
2. CodeBuild builds + pushes the image.
3. Update the `bedt` task definition(s) to the new image tag.

This is a **UI step — not scriptable from this repo.** After it lands, confirm:
```bash
bash scripts/bedt-status.sh        # version column should show your new version
```

---

## 3. Local development (no container)

Run a runner directly with `tsx`. Needs AWS creds for Bedrock (the bedt task role
has them; locally you need a valid session — see the gotcha below).

```bash
cd test-framework
AWS_REGION=eu-central-1 AGENT_REGION=eu-central-1 CLAUDE_CODE_USE_BEDROCK=1 \
  npx tsx src/runner-p14.ts \
    --models minimax-m2.5 \
    --techniques TEGRESS \
    --defences C4-baseline,C4-judge,C4-judge-enforced \
    --repetitions 2 \
    --agent-backend converse \
    --canary-port 47350 \
    --output-dir /tmp/jaid-dryrun
```

Typecheck before you ship (the vendored SDK `.d.ts` is noisy — use `skipLibCheck`):
```bash
cd test-framework && npx tsc --noEmit --skipLibCheck
```

Offline unit tests (no Bedrock/Ollama — stubbed):
```bash
npx tsx hooks/tests/test_pretool_gate_abort.ts        # PreToolUse gate abort path
npx tsx hooks/tests/test_phase8b_pattern_trust.ts     # pattern-trust Stage 0.5
# bash suites:
bash hooks/tests/test_phase7b_reconcile.sh
```

> **AWS creds gotcha (from memory).** A stale `AWS_BEARER_TOKEN_BEDROCK` env var
> silently breaks the Claude Agent SDK *and* takes precedence over IAM creds —
> symptoms are `UND_ERR_INVALID_ARG` or `Authentication failed: ... API Key`. For
> local SDK probes use `env -i` with explicit `AWS_*` vars. The Converse path
> (used by all the open-weights agents) also needs a non-expired session.

---

## 4. Launch a run on the fleet

### 4.1 The `/run` contract
Each container exposes `POST /run` with a body of `{test, runId, env}`. `test`
selects the entrypoint; `env` is forwarded to it.

| `test` | entrypoint | runner | suites |
|---|---|---|---|
| `t5`  | `docker-entrypoint-t5.sh`  | `runner-p14.ts` | T1, T4, T5, **crack-vectors** (TCMD/TDELAY/TDEP/TEGRESS/TEMIT/TLOG/TMCP/TMCPDESC/TRULES/TSLOP/TSTAGE/TWEB) |
| `t3e` | `docker-entrypoint-t3e.sh` | `runner-t3e-pretooluse.ts` | T3e exfil + disclosure |
| `mode4` | `docker-entrypoint-mode4.sh` | `runner-mode4*.ts` | Mode 4 CLI permission-proxy |
| `agentlab` | `docker-entrypoint-agentlab.sh` | `runner-agentlab.ts` | AgentLAB (real PreToolUse hook) |

Common `env` keys (t5/t3e):

| key | example | notes |
|---|---|---|
| `RUN_ID` | `p15a-ptu-crackvec-...` | becomes the S3 prefix; keep it unique |
| `AGENT_MODELS` | `minimax-m2.5` | comma-sep; resolved by the executor model map |
| `AGENT_BACKEND` | `converse` | `converse` (most Bedrock models) / `openai` / `vertex` / `mantle` / `bedrock` (SDK) |
| `AGENT_REGION` / `AWS_REGION` | `eu-central-1` | `us-west-2` for deepseek/qwen-coder etc. |
| `TECHNIQUES` | `T1,T4,TWEB` | (t5) which technique scenarios to run |
| `DEFENCES` | `C4-baseline,C4-judge,C4-judge-enforced,C4-judge-enforced-stage1` | the arms (see §4.2) |
| `REPETITIONS` | `20` | per scenario |
| `JUDGE_MODEL` | `eu.anthropic.claude-sonnet-4-6` | region-prefixed (`eu.`/`us.`) |
| `EMBED_MODEL` | `eu.cohere.embed-v4:0` | region-prefixed |
| `JUDGE_PROMPT` | `B7.1` | prompt variant |
| `OPENAI_API_KEY` | `<key>` | only for `AGENT_BACKEND=openai` (`openapi.key`) |
| `DREDD_URL`/`DREDD_API_KEY` | `https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal` / `~/.claude/dredd/api-key` | only the soft `/health` probe; not the verdict path |

> **Current sandbox hook server:**
> `https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal` — the
> shared Dynamo-backed Dredd hook the launch scripts pass as `DREDD_URL`. For
> these in-process suites it's only the soft startup `/health` probe (verdicts
> are computed in-runner, so its trust/auth mode doesn't affect results). Probe
> it with `curl -sk <url>/api/health | jq` — that also reports its judge config
> (`mode`, `judgeModel`, `hardened` prompt). The `/evaluate`-driven benchmark
> suites (AgentDojo / InjecAgent / MT-AgentRisk) *do* depend on this URL + its
> trust mode. The production hook (a different deployment) is
> `https://dredd-hook.acta.io`; the dashboard is `https://dredd.acta.io`.

### 4.2 Defence arms (the `DEFENCES` env)

| arm | judge? | call point | effect |
|---|---|---|---|
| `C4-baseline` | no | — | raw agent (baseline ASR) |
| `C4-judge` | yes | **post-turn** (`onTurnComplete`) | observe only — blocks the *next* turn; a same-turn exfil already left |
| `C4-judge-enforced` | yes | **PreToolUse** (`PreToolGate`) | **aborts the call** on a `hijacked` verdict before execution |
| `C4-judge-enforced-stage1` | yes | PreToolUse + deterministic rule | enforced **plus** the alternate-egress rule (git-push / DNS-base32 / image-GET) |
| `C1-*` | as above | — | same arms but with the CLI system prompt prepended |

`enforced` reuses the *same* Sonnet judge + Cohere drift + `hijacked`-only
decision as `C4-judge` — only the call point moves. The SDK executors
(`executor.ts` / `executor-bedrock.ts`) **throw** on `enforce` (the SDK runs tools
internally; use a Converse/OpenAI/Vertex/mantle agent for enforced cells).

### 4.3 Use a launch script (recommended)
The `scripts/launch-*.sh` scripts encode a campaign as one cell per container and
guard each on the image version. Example (the current crack-vector wave):

```bash
./scripts/launch-pretooluse-crackvec.sh --dry   # preview: which boxes WOULD fire
./scripts/launch-pretooluse-crackvec.sh         # fire
```

Each script:
- probes `/status`, **skips** boxes that are `running`, unreachable, or below
  `MINVER` (the version you built — this is what stops a cell running on stale code);
- builds a unique `RUN_ID` per cell;
- is **re-runnable** — re-running picks up only newly-eligible boxes (busy ones
  report `running` → SKIP), so you can launch part of a wave now and the rest
  after more containers redeploy.

To author a new campaign, copy `scripts/launch-pretooluse-crackvec.sh` and edit
the `CELLS` array (`bedt:model:region:prefix:backend:techniques:arms`) and `MINVER`.

### 4.4 Pre-launch checklist
- [ ] committed (version bumped) and the zip's version matches what you intend
- [ ] image deployed to the target boxes (`bedt-status.sh` shows the new version)
- [ ] launch script `MINVER` == the deployed version
- [ ] regions correct (`eu.`/`us.` judge+embed prefix follows `AWS_REGION`)
- [ ] `OPENAI_API_KEY` set for any `openai` cells
- [ ] **do NOT set `RESULTS_S3_DISABLE=1`** — the entrypoint's default S3 push is
      how results survive; disabling it has lost data before
- [ ] `--dry` first

---

## 5. Monitor

```bash
# whole-fleet sweep (version, status, model, technique, elapsed, exit, runId)
bash scripts/bedt-status.sh
BEDT_NUMBERS="3 4 5 6 7 8 9 10 11 12" bash scripts/bedt-status.sh   # subset

# one container in detail
curl -sk https://bedt3.aisandbox.dev.ckotech.internal/status | jq
#   .status   = idle | running | done | failed
#   .progress = { completedCombinations, totalCombinations, completedRuns, lastGES }
```

`progress.totalCombinations` is the per-scenario rep count; `completedRuns` ticks
up as reps finish. A cell is done when `status` flips to `done`.

---

## 6. Collect results

Per-cell JSON syncs to `s3://cko-results/<test>/<RUN_ID>/` at run end (default
`RESULTS_S3_URL`). One JSON per `(technique, model, defence, scenario)` cell, each
holding all reps plus a `summary`.

```bash
aws s3 ls   s3://cko-results/t5/ | grep p15a-ptu-crackvec
aws s3 sync s3://cko-results/t5/<RUN_ID>/ results/<local-dir>/
```

Headline fields per cell:
- `summary.exfiltrationDetected` — strict network exfil (canary received). **The
  metric.**
- `summary.egressBreakdown` — per-channel firing counts (http-post/get, tool-arg,
  git-push, dns).
- `summary.toolCallsAborted` / `runsWithAbort` — **enforced arms only**: tool
  calls the gate stopped before execution. The enforcement-gap signal: compare
  `C4-judge` exfil (blocked-but-ran) vs `C4-judge-enforced` exfil (aborted).
- Per-run `turns[].toolCalls[].{executed,gateVerdict,gateBlocked,gateStage}` —
  per-call audit: `executed=false` ⇒ aborted before execution.

### Recovery when a push fails
`status=failed` does **not** mean lost data — the run often completed but the S3
push failed. The run dir is preserved on the container (cleaned only at the *next*
run's start), so download it before re-running:
```bash
curl -sk https://bedt<N>.aisandbox.dev.ckotech.internal/files          # list
curl -sk https://bedt<N>.aisandbox.dev.ckotech.internal/files/<name> -o results/<name>
```

---

## 7. Gotchas (hard-won)

- **`AWS_BEARER_TOKEN_BEDROCK`** breaks the SDK and overrides IAM — see §3.
- **Region prefix.** `us-*` regions need `us.` inference profiles; `eu-*` need
  `eu.`. A mismatch is a "provided model identifier is invalid" preflight crash.
  The t5/t3e entrypoints derive the prefix from `AWS_REGION` automatically.
- **opus-4-7 has no `temperature`** on Bedrock Converse; the judge client already
  special-cases it. sonnet/haiku still need it.
- **Stale image = silent old behavior.** Containers keep serving the previous
  image until the task definition is updated. The `ver_ge` guard in the launch
  scripts is the safety net — keep `MINVER` honest.
- **Don't disable the S3 push.** (Repeated because it has bitten us.)
- **The dashboard's `RUN_ID`/summary disambiguation:** a cell dir can hold smoke +
  full-run summaries; pick the one whose timestamp matches the cell's `RUN_ID`.

---

## 8. Where things live

| Path | What |
|---|---|
| `test-framework/src/runner-p14.ts` | T1/T4/T5/crack-vector runner (the `t5` test) |
| `test-framework/src/runner-t3e-pretooluse.ts` | T3e exfil runner |
| `test-framework/src/executor-{converse,openai,vertex,mantle,bedrock}.ts` | per-backend agent drivers + tool loop |
| `test-framework/src/pretool-gate.ts` | the enforcing PreToolUse gate (`C4-judge-enforced`) |
| `test-framework/src/intent-tracker.ts` | post-turn defence (`C4-judge`) |
| `test-framework/src/canary-server.ts` | exfil ground-truth (HTTP/DNS) |
| `scenarios/*.ts` | the attack scenarios per technique |
| `fargate/docker-entrypoint-{t5,t3e,mode4,agentlab}.sh` | env → runner-args mappers |
| `fargate/Dockerfile.test-framework-zip` | the image |
| `scripts/build-test-framework-zip.sh` | the build |
| `scripts/launch-*.sh` | per-campaign launchers |
| `scripts/bedt-status.sh` | fleet status sweep |

## 9. Endpoints

| Role | URL | Used by |
|---|---|---|
| **Sandbox hook (current)** | `https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal` | `DREDD_URL` in the launch scripts; soft `/health` probe for the in-process suites, and the verdict path (`/evaluate`) for AgentDojo / InjecAgent / MT-AgentRisk |
| bedt runners | `https://bedt<N>.aisandbox.dev.ckotech.internal` | `POST /run`, `GET /status`, `GET /files` (per §4–6) |
| Production hook | `https://dredd-hook.acta.io` | live CLI hot path (not these benchmark runs) |
| Production dashboard | `https://dredd.acta.io` | operator UI |
