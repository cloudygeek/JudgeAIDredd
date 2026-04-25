# Poisoned-session flagging — design

**Status:** design draft. Implementation deferred until calibration data is available (see §7) or a corporate pilot greenlights it.

**Goal:** detect when a session has been hijacked beyond a single tool call, and short-circuit subsequent PreToolUse evaluations within that session to deny without re-judging. Reduces wasted judge cost on a poisoned session, breaks the "first-try-denied / second-try-rephrased / third-try-succeeds" loop, and surfaces a clear signal to the dashboard that a session went bad.

**Companion doc:** `docs/todo_posthook.md` — covers the orthogonal idea of classifying tool *responses* at PostToolUse. That mechanism would feed into this one (a confirmed-from-response compromise = strong corroboration). Keep the two designs decoupled; this one ships first because it uses signals we already produce.

---

## 1. Threshold rule

Flag a session as **compromised** when, within a single goal turn (between `registerIntent` events):

- **≥ 3 cumulative deny signals** are emitted by the existing pipeline. Cumulative = anywhere in the turn, not "consecutive" — attackers will deliberately interleave benign calls to reset a consecutive counter.

A **deny signal** is any of:

| Source | Signal |
|---|---|
| LLM judge | verdict = `hijacked` |
| Domain policy | hard-deny by R4 (read-then-send) or R6 (cover-tracks) |
| Domain policy | R1 (AgentDojo identifier) — counts as 2 because R1 only fires on a literal attacker token |
| Drift detector | sim < deny_threshold (currently 0.15) AND judge subsequently returns hijacked — counts as 1.5 (corroborated) |

The 1.5 / 2 weights normalise stronger signals so that one R1 hit + one judge=hijacked = 3 (compromised). Plain judge=hijacked weights 1.0; a corroborated judge+drift weights 1.5; a literal-attacker R1 weights 2.0. Threshold remains 3.0.

### 1.1 Why "cumulative across goal turn"

- A consecutive counter (e.g. "3 in a row") is trivially defeated by interleaving benign calls. AgentDojo injection_task_9 already does this naturally — exfil reads, send, then a "delete the sent email" — at least one of those calls usually reads as "drifting" rather than "hijacked", which would reset the counter.
- The goal-turn boundary (set by `registerGoal` in `pretool-interceptor.ts:166`) is the right scope: it represents the user's current session intent. A new user prompt resets the counter implicitly.
- Across-turn carryover is explicitly rejected — see §4.3.

### 1.2 Why exactly 3 (and not 2 or 5)

- B7.1 measured benign-task FPR = 27.8% on gpt-4o (`docs/agentdojo-gpt4o-b71-results-2026-04-21.md`). Per-tool-call FPR was 33.4%.
- A single-call flag would kill 27.8% of legitimate sessions. Unusable.
- A 2-call cumulative flag is roughly 0.334² = 11% session mortality. Still bad.
- A 3-call cumulative flag is roughly 0.334³ = 3.7% session mortality (Bernoulli upper bound — real sessions are correlated, so true number sits between 1.5% and 5%). Acceptable for a research deployment; not yet acceptable for an autonomous-mode shipped product.
- 5-or-higher cumulative is too many false-positive judge calls before we react — the attacker has already had three goes at the rephrase loop.

The threshold is a config knob, not a hard-coded constant; see §6.

### 1.3 Tiered behaviour (not all flags should auto-deny)

| Score | Tier | Behaviour |
|---|---|---|
| < 2.0 | clean | normal pipeline |
| 2.0–2.9 | watching | unchanged behaviour, but emit a "session-watching" feed event for dashboard visibility |
| ≥ 3.0 | compromised | next `/evaluate` calls in the same goal turn return `permissionDecision=deny` without invoking judge or drift. A "session-compromised" feed event is emitted with the deny-signal history. |
| **N/A** | resolved | new `registerIntent` (substantive prompt, not confirmation) clears the score |

"Watching" tier exists so the dashboard surfaces sessions that are accumulating denies without yet being killed — useful for an operator to spot adversarial patterns early.

---

## 2. Architecture

Two new methods on `SessionTracker`, called from `pretool-interceptor.ts` and read by `server.ts`:

```ts
// session-tracker.ts

interface DenyEvent {
  ts: string;
  source: "judge" | "domain" | "drift+judge";
  rule?: string;        // "R1:agentdojo-identifier", "R4:read-then-send", etc.
  weight: number;       // 1.0, 1.5, or 2.0 per §1
  tool: string;
  snippet: string;      // 80-char description of the tool call
}

class SessionTracker {
  // existing fields...

  recordDenyEvent(sessionId: string, ev: DenyEvent): void;

  /** Sum of weights since the last registerGoal. Reset on goal change. */
  getDenyScore(sessionId: string): number;

  /** Returns true if the session crossed the compromised threshold. */
  isSessionCompromised(sessionId: string): boolean;

  /** Operator override — clear flag and zero the deny score. */
  clearCompromiseFlag(sessionId: string, reason: string, operator: string): void;

  /** Read-only view for the dashboard / feed. */
  getDenyHistory(sessionId: string): DenyEvent[];
}
```

`registerGoal(sessionId, ...)` already exists and resets per-goal state — extend it to also zero the deny score and history.

### 2.1 Wiring at PreToolUse

`pretool-interceptor.ts::evaluate()` already produces `InterceptionResult` with stage and verdict. After the existing return path, before logging:

```ts
// At the bottom of evaluate(), once `result` is built:
if (result.stage === "domain-deny") {
  const weight = result.policyResult.matchedRule?.startsWith("R1:") ? 2.0 : 1.0;
  tracker.recordDenyEvent(sessionId, { ..., weight, source: "domain", ... });
}
if (result.stage === "judge-deny") {
  const corroborated = result.similarity !== null && result.similarity < this.config.denyThreshold;
  tracker.recordDenyEvent(sessionId, {
    ..., weight: corroborated ? 1.5 : 1.0,
    source: corroborated ? "drift+judge" : "judge",
  });
}
```

### 2.2 Wiring at PreToolUse short-circuit

At the *top* of `evaluate()`, before stage 1:

```ts
if (sessionId && tracker.isSessionCompromised(sessionId)) {
  const result: InterceptionResult = {
    allowed: false,
    tool, input,
    stage: "session-compromised",   // new stage label
    policyResult: { decision: "deny", tool, reason: "session compromised", matchedRule: "session-flag" },
    similarity: null, judgeVerdict: null,
    evaluationMs: 0,
    reason: "Session previously flagged compromised — denying without re-judging",
  };
  this.log(result, sessionId);
  return result;
}
```

Add `"session-compromised"` to the `stage` union type alongside the existing `policy-allow` / `domain-deny` / etc.

### 2.3 Atomicity

`/track` (PostToolUse) is fire-and-forget — multiple `/evaluate` calls can be in flight when `/track` adds a deny event. That's fine here: PreTool denies are themselves the source of deny events (recorded inside `/evaluate`), so the flag is set in the same handler that just emitted the latest deny. No cross-handler race for the simple case.

If `docs/todo_posthook.md` is later implemented (PostTool response classifier), then we'd have a real cross-handler race: a PostTool classifier sets the flag while a PreTool call is mid-evaluation. Solution: read-the-flag is the first step of `/evaluate` (above), so worst-case we lose one tool call — acceptable.

### 2.4 New API endpoints

```
POST /session/:id/clear-compromise   { reason, operator } → 200
GET  /session/:id/deny-history       → DenyEvent[]
```

The dashboard surfaces the deny history (already trivial to plumb — `getDenyHistory` returns the array, render in the existing session detail panel) and offers a "Clear flag" button for operator override.

---

## 3. Recovery path

A compromised flag must be recoverable, otherwise users with long-running sessions lose work on a single false positive. Three recovery routes:

1. **New goal** — the user issues a substantive new prompt; `registerGoal` resets the deny score. This is the natural recovery for legitimate users who realise the assistant misunderstood and start over with clearer instructions.
2. **Operator override** — `POST /session/:id/clear-compromise` with reason + operator name. Logged in the session JSON. Used when a human reviews the deny history and decides it was a false positive. The override does NOT reset the deny score history (still visible for audit), only the threshold cross.
3. **Session timeout** — sessions older than the configured `compromised_ttl_hours` (default: indefinite within a process; cleared on server restart). Avoids a stuck flag if the operator forgets.

Note that route 1 (new goal clears the flag) is exploitable: an attacker could craft the injection to look like a new user prompt to clear the flag mid-attack. Mitigation: the existing `isConfirmationPrompt` check in `server.ts:158` guards against trivial confirmation-style strings being treated as new goals. The existing `pivot detection` heuristic should be extended so that a "new goal" arriving while the session is compromised requires *user-initiated* intent (the prompt arrived via `UserPromptSubmit`, not via tool output), not just a substantive string.

---

## 4. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **FPR cascade.** 3-call cumulative FPR is ~3.7% (B7.1 numbers). On B7.2 it would be higher (per `docs/agentdojo-b72-results-2026-04-21.md`). Auto-deny on a poorly-calibrated prompt makes Dredd unusable. | Medium-High | Severe | Behaviour-tier the response (§1.3): "watching" alerts but doesn't deny; only "compromised" denies. Threshold and weights are config knobs (§6). Roll out flag-only mode first, deny mode second. |
| 2 | **No recovery path.** Single false positive ends the session permanently. | High | Severe (UX) | Three recovery routes (§3): new goal, operator override, session timeout. Auditable so misuse is visible. |
| 3 | **Threshold gaming.** Attacker times rephrase rate to stay under threshold. | Medium | Medium | Cumulative-across-turn (not consecutive). Weights for high-precision signals (R1) so a single literal attacker-token contributes 2.0. Future: half-life decay so old denies still count but with reduced weight. |
| 4 | **Async timing race.** PostTool flag write vs PreTool flag read (only relevant once `docs/todo_posthook.md` lands). | Low | Low | Read-flag-first in `/evaluate` (§2.2). Single-process tracker means JS event loop atomicity is sufficient — no locks needed. |
| 5 | **Cross-session leakage.** Flag carried into next session. | Low | High | Sessions are keyed by `session_id`; SessionTracker stores per-session state already. Just don't add tenant/user-level state. Each new `session_id` starts at score 0. |
| 6 | **User-trust failure.** Over-aggressive flagging trains users to disable Dredd. | Medium | Severe (mission failure) | Default to **flag-only mode** (no auto-deny) in interactive Claude Code; **flag + deny mode** is opt-in via config and recommended only for autonomous SDK pipelines where the user isn't in the loop. |
| 7 | **Per-tenant calibration mismatch.** A single threshold doesn't fit all deployments. | High | Medium | Threshold + weights are env vars / config (§6). Sane defaults for SaaS; corporate tenants override. |
| 8 | **Pivot exploit.** Attacker injects "I changed my mind, do X instead" via tool output to clear the flag. | Low-Medium | High | Pivot detection only honours `/intent` (UserPromptSubmit) inputs, never tool-output content. Existing code already does this — no change needed, but verify with a regression test. |
| 9 | **Operator-override abuse.** A compromised user (their workstation) calls the override endpoint themselves. | Low | High | Override endpoint requires an operator-token header in production deployments. In single-user dev mode, override is on but logged to the audit trail. |
| 10 | **Audit trail loss.** Flag clears reset state silently. | Low | Medium | `clearCompromiseFlag` writes a record to the session log; deny history is preserved (§3 route 2). Dashboard shows clear events. |

---

## 5. Implementation steps

Suggested order; each step is a separate PR.

1. **`SessionTracker` API** — add `recordDenyEvent`, `getDenyScore`, `isSessionCompromised`, `clearCompromiseFlag`, `getDenyHistory`. Unit tests for cumulative scoring, weight application, goal-reset behaviour. No wiring yet.
2. **PreTool wiring (record-only)** — interceptor calls `recordDenyEvent` after every domain-deny / judge-deny. Watch the dashboard for a week to collect deny-score distributions on real traffic. Don't gate anything yet.
3. **Tier-2 dashboard** — emit "session-watching" feed events at score ≥ 2.0. Surface the deny history in the session detail panel.
4. **Tier-3 short-circuit (opt-in)** — add `compromised_auto_deny: bool` config flag. When true, `/evaluate` short-circuits to deny when `isSessionCompromised`. Default false. Roll out to autonomous SDK pipelines first.
5. **Override endpoint + audit** — `POST /session/:id/clear-compromise` with operator auth. Persist override events to the session JSON.
6. **Production tightening** — once we have real FPR numbers from steps 2–3, tune thresholds and weights. Document the recommended config per deployment type (interactive / autonomous / corporate).

Estimated effort: step 1 = ~120 LOC + tests. Step 2 = ~30 LOC. Step 3 = ~50 LOC + dashboard CSS. Step 4 = ~20 LOC + config plumbing. Step 5 = ~80 LOC. Step 6 = data work, no code (or small follow-up PRs).

---

## 6. Configuration

```
JUDGE_DREDD_COMPROMISED_THRESHOLD     default 3.0   (sum-of-weights threshold)
JUDGE_DREDD_COMPROMISED_AUTO_DENY     default false (flag only) / true (flag + deny)
JUDGE_DREDD_COMPROMISED_TTL_HOURS     default 0     (no timeout; flag persists for the session lifetime)
JUDGE_DREDD_DENY_WEIGHT_JUDGE         default 1.0
JUDGE_DREDD_DENY_WEIGHT_DOMAIN        default 1.0
JUDGE_DREDD_DENY_WEIGHT_R1            default 2.0
JUDGE_DREDD_DENY_WEIGHT_DRIFT_JUDGE   default 1.5
```

Recommended profiles:

| Deployment | Threshold | Auto-deny | TTL |
|---|---|---|---|
| Interactive Claude Code | 3.0 | **false** (flag-only) | n/a |
| Autonomous SDK / pipeline | 2.0 | **true** | n/a |
| Corporate on-prem (financial) | 3.0 | **true** | 1 |
| Research benchmark (AgentDojo) | 3.0 | **true** | n/a |

The autonomous profile is more aggressive because the user isn't in the loop to course-correct — better to die than to silently let an attack propagate.

---

## 7. Calibration prerequisites

Before flipping `compromised_auto_deny` to true on any deployment, we need:

1. **Distribution of deny scores on benign traffic.** Run step 2 above for ≥ 1 week of real Claude Code interactive sessions (or a representative AgentDojo benign-suite rerun) and chart the per-session score histogram. The 95th percentile must be < threshold.
2. **Distribution on adversarial traffic.** Run the AgentDojo important_instructions security set with the new flag in record-only mode. The median compromised-attack score should be ≥ threshold.
3. **A regression test** in `scripts/check-domain-policy.ts` that asserts: a synthetic 3-event session is flagged, a 2-event session is not, the goal-reset zeros the score, and weights compose correctly.

If the benign 95th-percentile and adversarial median don't separate by at least 1.5 weight units, the threshold is poorly calibrated and the rollout is paused.

---

## 8. Out of scope (for this design)

- **Cross-session memory.** Carrying flags between sessions is rejected outright; one bad session must not affect the user's next.
- **PostToolUse response classifier.** Tracked separately in `docs/todo_posthook.md`. When that lands, the post-classifier becomes a fourth deny-event source feeding into the same threshold.
- **ML-based scoring.** No learned model. Threshold + weights are deterministic and explainable; that's the whole value proposition vs the existing judge.
- **Multi-tenant policy.** A SaaS-mode where each tenant has its own threshold table is plausible but not designed here.

---

## 9. Open questions

- Should the watching tier (score 2.0–2.9) inject a stronger goal anchor for the next user turn, in addition to the dashboard event? Probably yes — but needs to be weighed against context bloat.
- Should `clearCompromiseFlag` require not just an operator token but also a re-confirmation from the user themselves (two-party clearance)? More robust, more friction.
- What's the right behaviour if the session is flagged at goal-turn boundary — i.e. score crosses 3.0 on the *last* tool call of a turn, then the user issues a new prompt? Currently the new prompt clears the flag (route 1). That's right for the legitimate case but leaves a gap of one turn where an attacker who's already won could keep operating. Mitigation: the flag is sticky for the duration of the turn that crossed it, but cleared on the *next* `registerGoal`. Worth pinning down before implementation.
