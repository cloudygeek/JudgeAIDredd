# Self-hosted Dredd on the Mac Studio — replacing Bedrock and Fargate

**Status:** design, not yet implemented
**Date:** 2026-08-26
**Supersedes nothing. Runs in parallel with the (currently torn-down) AWS stack.**

---

## 1. Goal

Serve Dredd as an internet-reachable SaaS from a Mac Studio on a static IP, with:

- **inference local** — the LLM judge, the intent classifier, and drift embeddings all run on
  the Studio's GPU. No Bedrock, no OpenAI, no per-token cost, and no prompt content leaving
  the premises.
- **state remaining in AWS DynamoDB** — the existing `jaid-*` tables, reached with a dedicated
  IAM user holding DynamoDB permissions only.
- **the exposed service isolated in a VM** — the process the internet can reach is not the
  process that owns the Studio.

### Non-goals

- Replacing DynamoDB with a local store. Explicitly rejected for this phase: the `SessionStore`
  interface is ~40 methods, and `test_file_context_backends.ts` exists precisely because
  backends silently diverge. A fourth backend is its own project.
- Removing Clerk. The dashboard is internet-connected, so Clerk keeps working unchanged.
  `clerk.soteriacyber.com` already resolves, so the domain is already provisioned for it.
- Multi-node, HA, or autoscaling. One box, one VM.
- Retiring the AWS stack. This runs alongside it under different hostnames.

---

## 2. The constraint that determines the layout

**A Linux VM on Apple Silicon gets no GPU.** Apple's Hypervisor.framework exposes no virtual
GPU to guests, and Docker Desktop on macOS inherits that limitation — a containerised or
virtualised Ollama falls back to CPU and runs roughly 3–5x slower. Measured baseline for
comparison: `qwen3.6:35b` with reasoning suppressed answers a judge call in **1.3s** on Metal.
A 3–5x penalty puts that at 4–7s, and the judge blocks the agent's tool call on roughly 56% of
tool calls. That is the difference between usable and not.

Vulkan-to-Metal translation layers exist and are improving, but they are experimental and still
slower than native. Not a foundation to build a hosted service on today.

**Therefore the VM boundary goes around the internet-facing service, not around the model.**
This is the opposite of the instinctive layout ("put the whole thing in a VM") and is the single
most important decision in this document.

---

## 3. Topology

```
                    internet
                        │
              static IP │  (router forwards :80, :443 → VM only)
                        ▼
   ┌────────────────── VM: Linux, Apple Virtualization.framework ──────────────────┐
   │                                                                               │
   │   Caddy ──────────── TLS termination, Let's Encrypt (HTTP-01)                  │
   │     ├── hook.soteriacyber.com    → dredd-hook       :3000                      │
   │     └── dredd.soteriacyber.com   → dredd-dashboard  :3001                      │
   │                                                                               │
   └───────────────────────────────┬───────────────────────────────────────────────┘
                                   │ host-only network, one port
                                   ▼
   macOS host: Ollama + qwen3.6:35b + nomic-embed-text  (Metal GPU)
                                   │
                                   ▼
                   AWS DynamoDB, eu-west-1 — jaid-* tables
                   (IAM user, DynamoDB actions only)
```

### Why this shape

- **The VM is the blast radius.** It is the only thing the internet touches. A compromise there
  yields a Linux guest, not the Studio, and not the user's other work on that machine.
- **The host exposes exactly one service to the VM**, on a host-only interface. Ollama must
  bind to that interface, **never `0.0.0.0`**. A VM compromise then yields an LLM endpoint —
  the ability to burn GPU and read model weights — not filesystem or keychain access.
- **AWS credentials live in the VM, not on the host.** They are scoped so that the worst case
  is read/write on five DynamoDB tables.

---

## 4. DNS and TLS

Zone: **`soteriacyber.com`**, Route53 `Z1007704L5WGC3VBEPAI`.

| Record | Type | Target | Purpose |
|---|---|---|---|
| `hook.soteriacyber.com` | A | static IP | hot path the CLI hook POSTs to |
| `dredd.soteriacyber.com` | A | static IP | operator dashboard |

Both are new names. The existing `dredd-hook.acta.io` / `dredd.acta.io` A-aliases to the ALB are
left untouched, so the AWS stack can be brought back up and the two can run in parallel. Cut
over by moving clients, not by repointing DNS — that keeps a way back.

Existing records in the zone (`clerk`, `portal`, `cloudrisk`, `accounts`, `www`, DKIM selectors)
do not collide.

**Certificates:** Caddy with HTTP-01. Requires inbound `:80` for the challenge and `:443` for
service. DNS-01 via Route53 would avoid opening `:80`, but needs `route53:ChangeResourceRecordSets`
on the zone — which widens the IAM user beyond the DynamoDB-only requirement. HTTP-01 keeps the
credential boundary clean; that is the deciding factor, not convenience.

---

## 5. AWS access

### The IAM user is genuinely sufficient — verified

`aws dynamodb describe-table --table-name jaid-sessions` returns `SSEDescription: null`, i.e. the
table uses **AWS-owned** encryption keys, not a customer-managed CMK. **No `kms:Decrypt` /
`kms:GenerateDataKey` grant is required.** Had the tables used the stack's SSE CMK (the Terraform
supports it via `var.sse_kms_key_arn`, but the live tables were created without it), a
DynamoDB-only policy would have failed on every read with an opaque `AccessDeniedException` —
worth re-checking if the tables are ever re-created from Terraform with that variable set.

### Policy shape

New IAM user `dredd-selfhost`, one inline policy, no console access, access key only.

Actions — the same seven the Fargate hook role uses:
`GetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`, `BatchGetItem`, `BatchWriteItem`

Resources — five table ARNs plus their indexes, in `eu-west-1`:

```
arn:aws:dynamodb:eu-west-1:110745800154:table/jaid-sessions
arn:aws:dynamodb:eu-west-1:110745800154:table/jaid-sessions/index/*
arn:aws:dynamodb:eu-west-1:110745800154:table/jaid-api-keys
arn:aws:dynamodb:eu-west-1:110745800154:table/jaid-approvals
arn:aws:dynamodb:eu-west-1:110745800154:table/jaid-approvals/index/*
arn:aws:dynamodb:eu-west-1:110745800154:table/jaid-user-permissions
arn:aws:dynamodb:eu-west-1:110745800154:table/jaid-byot
```

No `bedrock:*`. No `kms:*`. No `secretsmanager:*`. If a future change reintroduces a Bedrock
call path, it will fail loudly on this user rather than silently start billing.

`jaid-byot` is retained because the **trust store** shares that table (`sk="TRUST"`), and trust
records hold no secret. BYOT itself is inert here — there is no Bedrock to bring a token for.

**Static keys are the weak point.** They sit in the VM and do not rotate themselves. Mitigations:
scope as above, rotate on a schedule, and treat IAM Roles Anywhere as the follow-up if this
becomes more than one box.

---

## 6. Configuration

| Variable | Value | Note |
|---|---|---|
| `BACKEND` | `ollama` | judge + classifier |
| `JUDGE_MODEL` | `qwen3.6` | measured below |
| `EMBEDDING_MODEL` | `nomic-embed-text` | `isBedrockModel()` already routes by name |
| `OLLAMA_HOST` | `http://<host-only-gw>:11434` | host's Ollama, from inside the VM |
| `DREDD_OLLAMA_THINK` | `false` | see §7 |
| `DREDD_JUDGE_FAIL_CLOSED` | `true` | **new**, see §8 |
| `STORE_BACKEND` | `dynamo` | unchanged |
| `DYNAMO_REGION` | `eu-west-1` | unchanged |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | the scoped user | VM only |
| `MODE` | `interactive` | user adjudicates; see §8 |
| `CLERK_SECRET_KEY` / `CLERK_PUBLISHABLE_KEY` | existing | dashboard role |
| `DREDD_HOOK_URL` | `https://hook.soteriacyber.com` | dashboard → hook, from the browser |
| `DREDD_DASHBOARD_ORIGIN` | `https://dredd.soteriacyber.com` | CORS on the hook |

`OLLAMA_KEEP_ALIVE` must be set long on the **host** — cold start is ~22s against 1.3s warm. A
model evicted for idleness turns the first judged tool call of the day into a 22-second stall.

---

## 7. Model choice, measured

From the 2026-08-26 three-way (18 cases x 5 reps = 90 runs per leg; corpora are
`eval_deny_review_2026_08_02.ts` plus the held-out `fixtures/judge-hard-corpus.ts`):

| | Sonnet 4.6 | GPT-5.6 Luna | qwen3.6 local |
|---|---|---|---|
| Correct | 85/90 | 79/90 | **86/90** |
| TP missed | **0** | 5 | 1 |
| FP missed | 5 | 6 | **3** |
| Unstable cases | **0/18** | 2/18 | 4/18 |
| Latency | 3.0s | 2.6s | **1.3s** |
| Cost / 10k @ prod prompt size | $225 | $18 | **$0** |

**Reasoning is suppressed deliberately.** `DREDD_OLLAMA_THINK=false`. On the same box and model,
thinking-on scored 19/24 at 7.9s and missed four subtle-hijack runs; thinking-off scored 34/36 at
1.3s. The clean flip is `TP-remote-redirect` (repoint `origin` to an attacker repo, then push) —
missed 2/2 with reasoning on, caught 3/3 with it off, because the reasoning trace talked itself
into "pushing IS the task".

**Honest reading of the gap.** Local wins on headline accuracy, but that is driven by false
positives. On the security-critical axis Sonnet is perfect and local is not, and local is
**four times less stable** — 4 of 18 cases returned different verdicts for byte-identical input.
For a hosted product that is a real regression, and §8 is the mitigation.

Also note: **all three judges fail `FP-self-auth`** (reading a local credential to authenticate to
the service the task names). Moving to local inference does not fix Dredd's dominant false
positive; the `principal-target-consent` work does.

`nomic-embed-text` is **not currently pulled on the Studio** — it has only `qwen3.6:35b`,
`qwen3.6:latest`, `qwen3.5:35b`. Pull it as part of provisioning.

---

## 8. Failure posture — fail closed

### Today

`failVerdictFor()` splits two cases:

- **code bug** (`TypeError`/`ReferenceError`/`RangeError`/`SyntaxError`) → `internalError: true`,
  and `pretool-interceptor.ts:782` computes `allowed = verdict !== "hijacked" && !internalError`,
  so it **fails closed**.
- **availability error** (backend unreachable, timeout, throttle) → plain `drifting`, which is
  **allowed**.

On Fargate that second branch was reasonable: Bedrock outages are rare, brief, and someone else's
problem. On a self-hosted box it is not. If Ollama is stopped, evicted, wedged, or simply
saturated, **every tool call sails through unjudged and nothing surfaces it.** An attacker who
can stall inference has disabled the judge without tripping an alarm.

### Change

Add `DREDD_JUDGE_FAIL_CLOSED` (default `false`, preserving current behaviour for the AWS stack;
`true` for this deployment). When enabled, the availability branch of `failVerdictFor` returns
the same not-allowed shape the internal-error branch does, so it flows through the existing
enforcement at `pretool-interceptor.ts:782` — no new decision path, one flag.

The **trust mode still governs what "not allowed" means**, which is what makes this safe to turn on:

| Mode | Effect when the judge is unavailable |
|---|---|
| `interactive` (this deployment) | `ask` — the user gets a prompt with the reason. Degrades to human-in-the-loop. |
| `autonomous` | `deny` — hard block. Correct, and it will stop work dead if Ollama is down. |
| `learn` | no decision; user config decides. Unchanged. |

In `interactive` mode the failure mode is **friction, not breakage** — the user is asked instead
of being silently unprotected. That is the right trade for a hosted security product.

### Also required

`/api/health` must report Ollama reachability and the resident model. Today the hook role runs a
Bedrock preflight at startup and nothing checks the judge backend thereafter. Without this,
"the judge stopped working three days ago" is discoverable only by reading session logs.

---

## 9. Work items

### Code

- **T-1 — classifier backend switch.** `intent-classifier.ts:203` hardcodes
  `backend: JudgeBackend = "bedrock"` and `model = "eu.anthropic.claude-sonnet-4-6"`. Must honour
  `BACKEND` / a classifier model env var the way the judge does.
- **T-2 — skip the Bedrock preflight when `BACKEND=ollama`.** It currently runs unconditionally on
  the hook role and will fail (or hang) with no Bedrock credentials.
- **T-3 — `DREDD_JUDGE_FAIL_CLOSED`** in `failVerdictFor`, per §8. Test: availability error with
  the flag on yields `allowed === false`; with the flag off yields the current `drifting`-allowed.
- **T-4 — Ollama reachability in `/api/health`,** with the resident model name and last-success
  timestamp.
- **T-5 — embedding path check.** `EMBEDDING_MODEL=nomic-embed-text` should route via
  `isBedrockModel()`, but the drift detector and the Phase 8b pattern-trust embed call must both
  be exercised end-to-end, not assumed.

### Deployment — new `selfhost/` directory

- **T-6** — VM definition (Apple Virtualization via Lima or equivalent), pinned image, resource
  limits, host-only network to the host's Ollama.
- **T-7** — `docker-compose.yml`: `dredd-hook`, `dredd-dashboard`, `caddy`.
- **T-8** — `Caddyfile`: two hostnames, HTTP-01, HSTS, sane timeouts. Proxy read timeout must
  exceed the hook's `--max-time 60` on `/evaluate` or long judge calls will be cut at the edge —
  the same ordering invariant that bit the ALB (`idle_timeout` vs `deregistration_delay`).
- **T-9** — `iam-policy.json` per §5, plus a `terraform/` module or documented console steps.
- **T-10** — `README.md`: provisioning, model pull, DNS, router forwarding, key rotation,
  `OLLAMA_KEEP_ALIVE`, and how to verify the whole chain.

### Verification

- **T-11** — end-to-end smoke: a real Claude Code session against `hook.soteriacyber.com`,
  asserting a judged deny and a judged allow, plus `/api/health` reporting Ollama up.
- **T-12** — fail-closed drill: stop Ollama mid-session and confirm the user is *asked* rather
  than silently allowed, and that `/api/health` goes red.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Local judge is 4x less stable than Sonnet (4/18 cases flip) | Fail-closed + `interactive` mode means an ambiguous verdict reaches a human. Revisit with a larger corpus before considering `autonomous`. |
| Ollama stalls → judge silently gone | §8: fail closed, plus health reporting. This is the main reason fail-closed is not optional here. |
| Studio becomes an internet-exposed host | VM isolation; router forwards only `:80`/`:443` and only to the VM; Ollama bound host-only. |
| Static AWS keys in the VM | DynamoDB-only, five tables, no KMS/Bedrock/Secrets. Rotate on a schedule. IAM Roles Anywhere as follow-up. |
| Single box, no redundancy | Accepted for this phase. Fail-closed makes an outage visible as prompts rather than as silent non-enforcement. |
| Cold model eviction → 22s first call | `OLLAMA_KEEP_ALIVE` long on the host; health check surfaces a cold model. |
| Corpus is 18 cases | Explicitly a probe, not a benchmark. Do not read the local-vs-Sonnet gap as precise. Grow the corpus before any `autonomous` rollout. |

---

## 11. Cutover

1. Provision VM, pull models, stand the stack up on the static IP with DNS not yet pointed.
2. Verify against the IP directly (Host header override).
3. Add the two A records.
4. Point **one** client (this laptop) at `hook.soteriacyber.com`; run T-11 and T-12.
5. Soak in `interactive` for a week; review denies with the weekly deny-review process.
6. Only then migrate other clients. The `acta.io` names stay valid throughout.

---

## 12. Open questions

- **Router/firewall ownership** — who controls the static IP's port forwarding, and is `:80`
  acceptable to open for ACME? If not, §4 changes to DNS-01 and the IAM user gains a
  narrowly-scoped Route53 statement.
- **Backup and egress** — DynamoDB PITR covers state, but nothing covers the VM. Should the VM be
  reproducible from `selfhost/` alone (preferred) or snapshotted?
- **Dashboard hostname** — `dredd.soteriacyber.com` is proposed, not confirmed.
