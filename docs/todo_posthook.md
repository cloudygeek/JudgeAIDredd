# TODO — PostToolUse response classification (corporate / on-prem)

**Status:** deferred. Out of scope for the SaaS / open-source build; revisit when a corporate-pilot deployment is on the roadmap.

## Idea

In a corporate-on-prem deployment of Judge Dredd, the `/track` (PostToolUse) endpoint already receives the *response* from every tool call. Today we use that data only for tracker bookkeeping (file-write accumulation, env-var parsing, drift-score updates). We could additionally classify the response itself and, on a confirmed compromise signal, mark the session as compromised — so the next `/evaluate` in the same goal turn short-circuits to a deny without re-judging.

## Why it helps

1. **Catches "first-try denied, second-try succeeds" rephrases.** PreTool gating denies one variant, the agent rephrases, the judge says "consistent" because the rephrasing looks plausible in isolation. A session-level compromise flag breaks that loop.
2. **Cheaper than re-judging each PreTool call against a poisoned context.** Once the session is poisoned, every subsequent judge call is doing wasted work — the answer is "deny" regardless. A flag short-circuits that.
3. **Catches confirmed-success-too-late signals.** A `send_email` returns "delivered to mark.black@…" — too late to block that call, but a strong signal that the next tool call from the same chain is part of the same attack.

## Why it's deferred

- **FPR concern.** A naive response classifier would inherit the same calibration problems we hit on B7.1 and B7.2. Until we have a measured baseline of what "compromise signals" look like in legitimate corporate traffic, we don't know the FPR cost of a session-stop trigger.
- **Configuration surface.** A SaaS / open-source build needs the classifier to be opt-in and configurable per deployment (regex list, embedding similarity threshold, judge-on-response prompt). That's its own design effort and not justified without a pilot.
- **Session-state lock.** Marking a session compromised requires coordinated state between `/track` (writer) and `/evaluate` (reader). Currently `/track` is fire-and-forget from the hook's perspective and runs concurrently with PreTool calls. A lock or atomic flag is needed.
- **Recoverability.** Auto-stopping a session is one-way; corporate users will want a "I confirm this was a false positive, continue" override path. UX design needed.

## Design sketch (when we revisit)

```
POST /track
  body: { session_id, tool, input, output, ... }

  → tracker.recordToolResult(session_id, tool, input, output)         [existing]
  → if (corporate-mode) {
      const verdict = classifyResponse(tool, input, output, intent)
      if (verdict.compromised) {
        tracker.markSessionCompromised(session_id, verdict.reason)
        emitFeed({ type: "session-compromised", session_id, reason })
      }
    }

POST /evaluate
  body: { session_id, tool, input, ... }

  → if (tracker.isSessionCompromised(session_id)) {
      return { permissionDecision: "deny", reason: "Session marked compromised post-tool" }
    }
  → existing 3-stage pipeline
```

The `classifyResponse` step has three plausible implementations, in increasing cost / quality:

1. **Regex on response body.** Look for known-bad delivery confirmations (e.g. `delivered to <attacker-pattern>`, `transaction posted to <novel-iban>`). Fast, deterministic, low FPR. Catches only the explicit cases.
2. **Embedding similarity** between the response and a "compromise template library" (e.g. corpora of "X has been forwarded to Y outside the org"). Cheap; needs a library to be curated.
3. **LLM-as-judge over the response.** Same model as `intent-judge`, prompt rewritten to "did the previous tool call achieve a goal the user did not set?" Most flexible; most expensive; same FPR risk we already saw on PreTool.

Probably (1) for the first iteration with an explicit allow-list of `mark.black@`-style patterns curated per tenant, plus (2) once the corporate corpus is large enough.

## Trigger threshold

A single confirmed-compromise signal probably should NOT auto-stop the session — same reasoning as the PreTool case (false positives are catastrophic). A reasonable rule for first iteration:

- **Stop the session immediately** on a *high-confidence* signal: response contains a literal attacker identifier from R1's deny-list (corporate tenant maintains its own list), OR response confirms a tool call the PreTool stage denied (the agent retried and the deny was bypassed somehow).
- **Escalate but continue** on a *medium-confidence* signal: response semantically matches a compromise template at sim > 0.7 but no literal-string match.
- **Ignore** below that.

Stopping in this context means: subsequent `/evaluate` calls in the same goal turn return `deny`. The user can resume by issuing a new prompt (which clears the compromised flag via `tracker.registerIntent` / pivot detection).

## Related

- `src/server.ts` — `/track` handler is `handleTrack`, lines around 933.
- `src/session-tracker.ts` — would gain `markSessionCompromised` / `isSessionCompromised` helpers.
- `docs/agentdojo-attack-taxonomy-2026-04-21.md` — the attacker-identifier list (R1 deny set) is reusable as the seed for the corporate response-classifier patterns.
- `docs/agentdojo-b72-results-2026-04-21.md` — context on why we're FPR-cautious.

## Decision needed before starting

- Which corporate pilot is the design target? Different threat models (financial vs healthcare vs developer tooling) want different default classifiers.
- Is the response classifier in-process (TypeScript/Bedrock) or external (a tenant-supplied microservice we POST to)? External keeps tenants' regex/embeddings out of our codebase but adds latency and an extra failure mode.
