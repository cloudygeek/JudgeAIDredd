# Plan: consent completion — decision capture, new sinks, resolver gaps, presence checks

2026-08-27. Follow-on to the (principal, target) consent work that shipped in
`src/credential-flow.ts` / `approval-fingerprint.ts` (on by default via
`DREDD_CREDENTIAL_CONSENT_ENABLED`, verified live 2026-06-19). That work killed
the dominant re-ask splinter — ~56/80 denies in session `455e88d2` collapsing
into one (dredd-key → sandbox) pair. Four residues remain. This plan specs them
in dependency order: **measurement first**, because phases 2–4 change re-ask
behaviour and are only provably better if we can count decisions.

Non-goals, restating the locked 2026-05-25 decisions — none of these change:

- **No self-auth / infra allowlist.** The judge's reasoning is untouched; FP
  relief comes only from consent memory. (Model-side relief arrived separately:
  qwen3.6:35b-coding passes FP-self-auth 13/15.)
- **Target stays the exact host.** Endpoint migrations (acta.io →
  soteriacyber.com) re-ask once per pair, by design.
- **Consent never weakens hard denies.** `DENIED_BASH_PATTERNS`, dangerous
  combos, and user-deny rules always win.
- No cross-project or cross-owner consent; no autonomous-mode behaviour change.

---

## Phase 1 — decision capture (`DREDD_DECISION_CAPTURE_ENABLED`, default false)

**Problem.** Dredd never sees the user's actual choice. The only positive
signal is PostToolUse arrival (`handlers/track.ts:9` — "arrival here is our
only positive signal"); an explicit **deny is invisible** (the tool never runs,
no hook fires toward Dredd), and allow-**once** vs allow-**always** are
indistinguishable. Consequences: (a) the FP-relief effect of consent is
unmeasurable; (b) a pair the user explicitly refused looks identical to a pair
never asked about; (c) pattern-trust (Phase 8) learns from approvals but can
never learn from refusals.

**Design — three capture channels, one per decision kind:**

> **2026-08-27 verification finding (claude-code-guide):** `PermissionDenied`
> may fire on AUTOMATED denials only (auto-mode classifier, policy rules,
> PreToolUse-hook deny) — NOT when the user rejects an interactive prompt
> (no dedicated event exists for that; `PermissionRequest` is the prompt
> event). If the soak confirms this, channel 1 below captures
> **denial-enforcement** telemetry (Dredd's deny provably took effect
> client-side — still worth keeping, under an accurate label), and true
> user-rejection capture becomes phase 1b: infer it from a Dredd "ask"
> whose pending approval expires with neither PostToolUse nor
> PermissionDenied arriving — the mirror of Phase 9's tacit-approval
> inference. The shipped machinery is flag-gated telemetry either way;
> the Studio soak's paired-row data decides which reading is true.

1. **Explicit deny → the `PermissionDenied` hook event.** Claude Code fires
   `PermissionDenied` when the user rejects a permission prompt. Wire it in
   `dredd-hook.sh` exactly like `PostToolUseFailure`: fire-and-forget POST to
   `/track` with `user_decision: "deny"` and the event's `tool_use_id`. Server
   side, mirror the failure branch: pair to the PreToolUse decision row by
   `tool_use_id`, record `outcome: "user-denied"` on the `ToolCallRecord`
   (append-only `DENY#` Dynamo item merged at `loadSession`, like `FAIL#`),
   **consume the pending approval without promoting** (a refusal is
   anti-consent), and skip all accumulation. *Verification step before build:
   capture one real `PermissionDenied` payload to confirm it carries
   `tool_name`, `tool_input`, and `tool_use_id`; if `tool_use_id` is absent,
   fall back to the standalone-row path the failure branch already has.*

2. **Allow-always → user-permissions snapshot diff.** "Yes, don't ask again"
   writes a rule into `settings.local.json` `permissions.allow`, which the hook
   already uploads on hash change at the next UserPromptSubmit. At snapshot
   processing time, diff new allow rules against the previous snapshot; when a
   new rule matches the tool/pattern of an approval promoted in the last 10
   minutes for the same (ownerSub, projectRoot), upgrade that
   `ApprovalRecord.decision` to `"allow-always"`. Managed-allow rules Dredd
   itself splices are already subtracted from the snapshot, so they cannot
   masquerade as user consent.

3. **Allow-once → the existing promotion path**, now labelled. Explicit
   promotions record `decision: "allow-once"`; Phase 9 tacit promotions record
   `decision: "allow-tacit"` (unchanged semantics, now distinguishable).

**Storage.** New optional fields on `ApprovalRecord`: `decision`
(`allow-once | allow-always | allow-tacit`), `decidedVia`
(`posttooluse | snapshot-diff`). Denials are NOT ApprovalRecords — they live
only as `ToolCallRecord.outcome`, because the approvals table feeds trust
signals and a refusal must never enter that pool. Phase 1 is **telemetry
only**: no behaviour change anywhere; the flag gates the `/track` deny branch
and the snapshot-diff upgrade.

**Metrics unlocked** (computable from session logs): re-ask count per
(principal, target) pair; denies of previously-approved pairs (consent
regressions); ask→deny rate by judge stage (true FP-rate proxy for
interactive mode).

**Dashboard.** Tool Calls table gains a `user-denied` badge (red, like
`failed`); session detail shows the decision column on approvals.

**Tests.** `test_new_hook_events.sh` grows PermissionDenied cases (payload →
/track shape, fire-and-forget). New `test_decision_capture.ts`: deny pairs to
decision row + no promotion; snapshot-diff upgrade inside/outside the 10-min
window; tacit vs explicit labelling; flag-off = byte-identical behaviour.

**Later (out of scope now):** a refused pair could raise the judge's prior via
a `<prior_refusals>` block, symmetric to `<prior_approvals>`. Decide after
observing deny telemetry.

---

## Phase 2 — new sinks: aws CLI + inline HTTP (`DREDD_CONSENT_SINKS_V2_ENABLED`, default false)

**Problem.** `credential-flow.ts` recognises curl/wget (and ssh/scp/rsync got
host-pinned fingerprints separately). An `aws` CLI call or a `python -c` /
`node -e` inline HTTP client is a network sink the resolver cannot see, so
those calls fall back to exact-fingerprint keying and splinter per argument.
AWS calls are a large share of this project's traffic (the 2026-05-31 review's
#1 FP was `get-caller-identity`).

**aws CLI design.** Add `awsAccess()` to `credential-flow.ts`:

- Parse `aws [global-flags] <service> <operation> …` out of each chain part
  (reusing the existing splitter).
- **Principal** = the ambient AWS identity, resolved syntactically:
  `aws-profile:<name>` when `--profile`/`AWS_PROFILE` is present, else
  `aws-env:default`. No file read happens and none is claimed — this is a
  *credential identity*, not a source-read, and the kind is distinct
  (`{ kind: "aws" }`) so it can never merge with file-source principals.
- **Target** = `<service>:<region>` (region from `--region`, `AWS_REGION`
  assignment, else `"default"`). For S3 specifically, append the bucket
  (`s3:eu-west-1:my-bucket`) — bucket is the blast-radius unit there. Function
  /table/queue names for other services deliberately NOT included: per-resource
  splintering is the disease this feature treats.
- Consent semantics identical to curl: judge-ask + user-accept captures the
  pair; future match suppresses the ask. Hard policy still wins —
  `secretsmanager get-secret-value` style patterns stay wherever policy puts
  them today.

**Inline HTTP design.** For `python -c '…'`, `python3 -c`, `node -e`, `ruby
-e`: extract HTTPS URL literals from the inline program text with the existing
`hostOf()` (which already rejects `$`-contaminated hosts). Sink = that host;
principals = whatever file/cookie/value sources the surrounding chain already
resolved. No literal host → no pair → status quo (exact fingerprint). We do
not parse the program — literal extraction only, fail-safe toward re-asking.

**Tests.** Extend `test_credential_consent.ts` with aws shapes (profile /
env-region / s3-bucket variants; distinct principals never merging) and inline
HTTP shapes (literal host, `$`-host rejection, no-host fallback). Fingerprint
stability cases in `test_approval_fingerprint.ts` — `CREDENTIAL_FP_VERSION`
bumps, prior approvals from the curl-only era stay valid (their fingerprints
carry the old version and re-ask once; do not migrate).

---

## Phase 3 — resolver gaps: URL-query credentials, indirect reads (same flag as Phase 2)

Two known blind spots, both currently fail-safe (re-prompt), both pure
recognition widening in `credential-flow.ts`:

1. **Credential in the URL query.** `curl "https://h/api?key=$(cat P)"` — the
   host pins fine (the `$` sits in the query, tolerated at
   `credential-flow.ts:244`), but the credential is not captured as a
   principal, so the pair is incomplete and consent keys inconsistently.
   Fix: scan URL query/path for `$(cat P)` substitutions and `$VAR` expansions
   whose variable was credential-assigned earlier in the chain (the expansion
   map exists — `test_credential_url_expansion.ts`); attach them as normal
   file/value principals. The host rule is unchanged: a `$` in the HOST still
   rejects pinning.

2. **Indirect file reads.** Recognise as `file:` sources: `$(<P)` (bash
   builtin read), `<(cat P)` process substitution, and
   `$(python… open("P")…read()…)` one-liner reads (single conservative regex;
   anything fancier stays unrecognised and therefore re-asks). Identity is the
   path P, same as `cat`.

**Tests.** New cases in `test_credential_flow.ts` (each form → correct
principal) and `test_credential_url_expansion.ts` (query-embedded `$VAR` to
fixed point; `$`-host still rejected).

---

## Phase 4 — presence-check idiom (policy carve-out, no flag)

**Problem.** "Does the credential exist?" probes — `test -f ~/.aws/credentials
&& echo yes`, `ls -la ~/.ssh/`, `stat -f%z keyfile`, `wc -c < key` — read no
secret bytes yet get escalated/judged as credential probes. The keychain
variant was already carved out (`tool-policy.ts:842`, `security … && echo
exists`); this generalises it. Open since the 2026-06-19 review.

**Design.** Deterministic Stage 1 allow in `tool-policy.ts`: a chain part is a
*presence probe* when its verb is in {`test`, `[`, `[[`, `stat`, `ls`, `file`,
`wc`, `du`, `find -name` (no `-exec`)} AND the chain contains **no
content-read verb** (`cat`, `head`, `tail`, `less`, `od`, `xxd`, `strings`,
`grep`/`rg` *against the sensitive path*) AND **no network sink** anywhere in
the chain (reuse the credential-flow sink detection). All three conditions on
the WHOLE chain, not the part — `test -f k && cat k | curl …` must not ride
the carve-out. Reason string: `"presence probe — existence/metadata only, no
content read, no egress"`.

**Accepted risk, stated:** `ls ~/.ssh/` reveals filenames. Filenames are not
secrets, and blocking directory listings costs more in judge FPs than the
metadata is worth. Revisit only with evidence.

**No flag** — deterministic policy carve-outs (rm-sandbox, keychain probe,
devtool-kill) ship directly with their tests; this follows that precedent.

**Tests.** Extend `test_policy_credential_probe.ts`: each presence verb allowed
on sensitive paths; presence + content-read denied path unchanged; presence +
network in chain unchanged; `find -exec` excluded.

---

## Rollout order and measurement

| Phase | Flag | Order rationale |
|---|---|---|
| 1 decision capture | `DREDD_DECISION_CAPTURE_ENABLED` | First — everything after is measured by it |
| 2 sinks v2 | `DREDD_CONSENT_SINKS_V2_ENABLED` | Biggest expected re-ask reduction (aws traffic volume) |
| 3 resolver gaps | (same flag as 2) | Same module, same risk shape, one soak |
| 4 presence probes | none | Deterministic, precedented, test-gated |

Soak sequence per repo convention: deploy dormant → flip flag on the selfhost
stack first (one user, fast feedback, `results` visible in the dashboard) →
one week of decision telemetry → flip on prod AWS stack. Success criteria
after phases 2–4, measured by phase 1: re-ask count per (principal, target)
pair ≤ 2 (first ask + at most one version-bump re-ask); zero consent
suppressions on pairs with a recorded deny; no new TP misses in the judge
eval corpora (`REPS=5 CORPUS=both` before each flag flip).
