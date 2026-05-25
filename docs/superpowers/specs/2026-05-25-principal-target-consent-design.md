# Principal/Target consent — credential-flow resolver (design)

**Date:** 2026-05-25
**Status:** prototype (validation against the 80-deny corpus); productionizing is a separate plan.

## Problem

In interactive mode, approving a credential→host action once should stop re-asks for adjacent calls. Today consent is an exact fingerprint `sha256{verb,host,auth_hash}` (`approval-fingerprint.ts`). Empirically (session `455e88d2`, 80 denies replayed): **80 → 50 distinct fingerprints**, principal `auth_hash` **null on 38/49** credential denies, because the key is plumbed via `$(cat P)` / `VAR=$(cat P)` / `cat P | …` which the fingerprinter can't resolve, and the chain-splitter fragments multi-line commands so the curl identity is lost.

## Decisions (locked with user 2026-05-25)

- **Target = exact host.** Tightest blast radius. Sibling hosts (`bedt5`/`bedt6`) still re-ask by design. The win is collapsing *same-key, same-host, different-plumbing* re-asks.
- **Principal = source-based, medium breadth.** Identity is the credential *source* (file path / cookie jar / basic user / hashed literal), not a value-hash. Survives key rotation; makes "different secret → approved host" detectable.
- **Equivalence class = (sorted credential-source set, exact host).**

## Module: `src/credential-flow.ts`

Taint analysis — credential **sources** to network **sinks**.

```ts
type CredentialSource =
  | { kind: "file";   id: string }   // path read as a secret, e.g. ~/.claude/dredd/api-key
  | { kind: "cookie"; id: string }   // -b jar (file)
  | { kind: "basic";  id: string }   // -u user:pass  -> "basic:<user>"
  | { kind: "value";  id: string };  // literal secret -> sha256(value)[:16]; raw never stored

interface NetworkAccess { verb: "curl"; host: string | null; principals: CredentialSource[] }
interface CommandFlow   { network: NetworkAccess[] }

function analyzeCommand(command: string): CommandFlow;
function fingerprintNetwork(command: string): { shape; summary; hash } | null;
```

**Tokenizer** (own, not the existing `splitStatements`):
- Statement separators: `;`, newline, `&&`, `||`.
- `|` is a **pipeline connector within a statement** (carries taint), not a separator.
- `$( … )` and `` `…` `` are grouped tokens (internal spaces preserved) so unquoted `$(cat P)` survives.
- Quoted strings preserve internal spaces (matches existing behaviour).

**Resolution:**
- Assignments collected in order: `VAR=$(cat P)` → `varSource[VAR]=file:P`; `VAR=<literal>` → `varValue[VAR]` (for host expansion) and, if `isSensitiveEnvVar`, `varSource[VAR]=value:hash`.
- Per network segment (`curl`/`wget`→`verb:"curl"`): host from URL (literal-var-expanded; `${unknown}` left as-is); principals from `-H Authorization/x-api-key/…`, `-b`, `-u`, `-d/--data[-binary] @-`/`$(cat P)`, and any upstream `cat P` in the same pipeline.
- Header/credential value resolved to a source via `$(cat P)` / `$VAR`; if unresolved, hashed as `value:`.

**Fail-safe:** unsure whether a credential reaches a sink → include it (more specific fingerprint → re-ask). Never over-collapse. Unparseable → null (re-ask), as today.

## Scope / isolation

- New module only; `approval-fingerprint.ts` and its test stay untouched (no live-behaviour or stored-approval change yet).
- Productionizing (swap `fingerprintBash` to call `credential-flow`, version/migrate stored approvals, wire exact-host consent into the interceptor, capture human allow/deny) = follow-on plan(s).

## Tests

- `hooks/tests/test_credential_flow.ts` (npx tsx): plumbing variants collapse to one hash; different host / different secret-file diverge; pipe-fed taint; cookie/basic; multi-line doesn't lose the curl; no-credential curl; raw secret never in shape.
- `hooks/tests/replay_denies_455.ts`: load redacted corpus `hooks/tests/fixtures/denies-455.jsonl`, compare baseline `computeFingerprint` vs `fingerprintNetwork`, report principal-resolution rate + distinct-class collapse (80→N), assert thresholds.

## Success metrics

- Principal resolved (non-empty) on ≥95% of credential-bearing denies.
- The 3 canonical plumbing variants on the same (file, host) → identical hash.
- Distinct (principal, exact-host) classes < baseline 50; same-host plumbing variants merged.
- No regression in existing `test_approval_fingerprint.ts`.

## Results (prototype run, 2026-05-25)

`test_credential_flow.ts` 16/16, `replay_denies_455.ts` 4/4, `test_approval_fingerprint.ts` 12/12 (no regression).

Replay of the 80 denies partitions as: **54 non-network** (key reads / inspection / benign ops the judge denied — *no target*, out of scope), **6 network no-credential**, **20 network+credential**.

On the 20 network+credential commands:
- **Principal visibility 9 → 17 (45% → 85%)** — the headline win. The new resolver sees the credential where the baseline `auth_hash` was null (`$(cat)`, `VAR=$(cat)`, `cat | curl`, multi-line). 3 unresolved: 1 is a genuinely unauthenticated `/health` probe (correctly empty); 2 embed the key in a `-d @<(python3 …)` process substitution (resolver limit, fails safe to re-ask).
- **Distinct fingerprints 16 → 16 (no net reduction); max 2 baseline fps merged into one class.**

### Honest finding: exact-host scope barely reduces *this* corpus's re-ask count

The friction in `455e88d2` was dominated by the agent probing **many sibling hosts** (`bedt4/5/6/9/…/interactive`, ~16 distinct). Exact-host scope keeps those separate **by design**, so the (principal,target) model does **not** collapse them. The big "56 → 1" collapse only materialises under **domain-family** scope, which was declined. The other 54 re-asks are non-network (the judge's self-auth false-positive class) — a *different* workstream entirely.

So the prototype's value on this corpus is **security/visibility, not friction**: it closes the `$(cat)`/`-b cookie`/multi-line blind spots, makes "different secret → approved host" detectable, and recovers curls the splitter lost. Friction relief for this workload needs either domain-family scope or fixing the judge's non-network false positives.

### Security issues surfaced (separate from this feature)

- A **live key** `jaid_live_…` is persisted in plaintext in `jaid-sessions` because the agent inlined it into a `-d @<(python3)` payload instead of `$(cat)`. **Rotate it**; consider redacting credential-bearing `tool_input` at persist time.
- The committed corpus fixture is redaction-scrubbed (`jaid_(live|test)_…`, `*_API_KEY/SECRET/TOKEN` JSON values, auth headers, `-u` passwords).

## Implementation (2026-05-25)

Capture/store/match shipped as a **4-file change** (pending/track/stores are shape-agnostic, so no churn there):

- `server-core.ts` — `CREDENTIAL_CONSENT_ENABLED` (env `DREDD_CREDENTIAL_CONSENT_ENABLED`, **default on**) + startup log.
- `credential-flow.ts` — `fingerprintNetwork` now also returns `fingerprintJson`; `CREDENTIAL_FP_VERSION = 2`.
- `approval-fingerprint.ts` — `computeApprovalFingerprint(tool, input, {credentialConsent})`: credential-flow pair for Bash-network when on, else legacy `computeFingerprint`; returns `{hash, summary, fingerprintJson, version, isCredentialPair}`.
- `handlers/evaluate.ts` — all 3 approval fingerprint sites (lookup + 2 pending) use the wrapper; the intent-drift backstop is **skipped when `isCredentialPair`** (the exact pair is the consent boundary; terse follow-ups would otherwise re-ask — see drift calibration above).

Decisions realised: target = exact host; credential = source (`file:`/`cookie:`/`basic:`) or hashed `value:` for inline literals; capture on judge-warn + accept (unchanged pending→track promotion); match → suppress with no drift recheck; legacy hash ≠ pair hash so old approvals age out cleanly; no Dredd special-casing.

**Tests (all green):** `test_credential_flow` (16), `test_credential_consent` (11), `replay_denies_455` (4), regression `test_approval_fingerprint` (12), `test_phase8b_pattern_trust` (14), `test_phase3_matcher` (46). `test_phase4_pipeline` needs live Bedrock (`aws sso login`) — unaffected by this change.

**Not done (follow-ons):** dashboard surfacing of the new summary wording; capture the human allow/deny decision (still inferred from PostToolUse); resolver gaps (key in `python` process-subst / URL query) remain fail-safe.
