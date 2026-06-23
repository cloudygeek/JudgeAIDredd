# Experiment requirement — structural egress-anomaly detector vs the judge's coverage blind spot (p15a follow-up)

**Date:** 2026-06-23
**Requested by:** P15 defence-paper authoring pass (Cloud-Security/Adrian/p15b/p15b-defence.tex §4.5 negative result #2)
**Priority:** LOW / **EXPLORATORY — DOES NOT GATE p15b.** The defence paper ships on its current framing (the coverage blind spot is a *negative result*, and structural detection is at most named as a future-work candidate). This experiment tests *whether that blind spot is closable* by an orthogonal signal — feeding a possible **P15c / revision**, not the current submission.
**Harness:** none new — **pure post-hoc analysis on existing logged trajectories.** No agent re-runs, ~0 cloud cost.
**Methodological seed:** VAE-based anomaly detection on tree-structured API messages (JSON/XML), per patent **WO-2019053234-A1 / US20210185066A1** ("Detecting Anomalous Application Messages in Telecommunication Networks").

---

## 1. Why — a signal axis orthogonal to the judge

The LLM judge is **semantic**: "does this tool call serve the originating task?" Its headline blind spot (§4.5) is attacks that are *semantically on-task* but exploit the **structure of the egress channel** — covert/encoded exfil (DNS subdomains, staged writes), alternate egress (`git push`), and the split-file bypass. The judge returns `consistent`, so the gate has nothing to abort; this leaks even on the Anthropic frontier (3.8%).

A **structural/distributional** detector answers a different question — "does this egress call look like the normal population of egress calls?" — and is blind to semantics but sensitive to form (payload entropy, destination novelty, encoding, argument-tree shape). That is exactly the axis the judge ignores. The hypothesis: a structural detector catches the structurally-anomalous covert egress the judge passes, as a **third disjoint leg** (cf. the action-side ⊥ content-side PromptArmor disjoint-failure result already in the paper). It is a **passive observer** — no prompt modification — so it cannot reproduce the paper's *other* negative result (defence-as-injection-vector, +20pp); it adds sensing without adding attack surface.

**Scope discipline (state up front):** this is useless against general goal-hijack (a structurally-normal `rm -rf` is the judge's job) and against *well-shaped* covert channels (low-entropy split-file chunks, mimicry `git push` to a plausible remote) that are constructed to have no structural signature. The honest expected ceiling is "raises the bar / forces low-bandwidth innocuous channels," not "closes the class." The experiment is to *measure* that ceiling.

---

## 2. What to build — egress-scoped, trajectory-level, with a deterministic control

**Unit:** egress tool calls only (the lethal-trifecta external-communication leg). Identify via the logged `egressChannel(s)` field + tool name (curl/fetch/http, dns, `git push`, webhook, MCP egress). Do **not** model all tool traffic — the full agent distribution is heavy-tailed and would wreck FPR (the paper's deployability rests on 0/4118). The egress sub-distribution is tighter and is where exfil must surface.

**Features per egress call (tree-structured, per the patent):** destination host/URL/remote + path; payload length, Shannon entropy, encoding markers (base32/64/hex); argument-tree shape (depth, fan-out, field set, unexpected fields).

**Trajectory aggregate (to catch split-file):** per-session egress count, cumulative bytes per destination, count of novel destinations, cross-message reconstructed-payload entropy. A per-message detector inherits the split-file blind spot — so a windowed/sequential variant is required, not optional.

**Models to compare (the real scientific question is whether the learned model beats a trivial rule):**
1. **Deterministic egress heuristic** (control, "deterministic by default"): entropy threshold ∨ destination-not-in-benign-set ∨ encoding-marker. No training.
2. **Classical anomaly detector**: isolation forest / one-class SVM on flat features.
3. **Tree-VAE on the egress-call JSON** (the patent's method) + a **sequential/trajectory-VAE** variant. Report reconstruction-error thresholding. Note the known VAE OOD-likelihood pathology (Nalisnick et al. 2019) — hence the controls.

---

## 3. Data (all post-hoc from existing logs)

**Positives P — the judge-missed covert exfils** (the blind-spot corpus): logged runs with `exfiltrationDetected=true` **AND** the `intentVerdicts` entry on the leaking egress turn ∈ {`consistent`} (i.e. the gate had nothing to abort). Sources already on disk:
- crack-vector covert bucket — `results/p15a-ptu-crackvec-2026-06-19/` (TEGRESS, TSTAGE, TDELAY, TDEP, TMCP, TLOG, …), incl. the Sonnet 3.8% frontier covert leaks;
- split-file T3e.4 residuals (`results/p15a-ptu-t3e-*`);
- T4 HTTP-injection `consistent`-verdict leaks (`results/p15a-ptu-t3e-t4-t5-2026-06-19/…t4…`);
- alternate-egress (`egressChannel ∈ {git-push, dns, …}`).

**Negatives N — benign** : the 4,118-call legitimate developer workload (`results/p15a-ptu-cost-fpr-2026-06-22/`, the 0% judge-FPR set). Train the detector on a split of N's egress calls; hold out the rest for FPR.

Extract `turns[].toolCalls` (+ `egressChannel`, `exfiltrationPaths`, `intentVerdicts`, `exfiltrationDetected`) from the trajectory JSONs. **Caveat to verify first:** confirm `toolCalls` retains full raw arguments (destination + payload) for the egress calls in P and N; spot-check showed `toolCalls` + `egressChannel` + `exfiltrationPaths` present, but if any cell stored truncated args, that cell needs a one-off re-extract (still no agent run).

---

## 4. Metrics & decision rule

- **Recall on P** at **FPR ≤ the paper standard** (≈0 / ≤0.1% on held-out benign egress) — operating point, ROC/PR.
- **Per-sub-class breakdown:** high-entropy blob vs split-file vs mimicry-egress — show *which* the structural axis catches (the honest scope from §1).
- **Complementarity:** of all P (judge-missed), the fraction the structural detector flags → the disjoint-third-leg claim; report the composite (judge ∪ structural) residual vs judge-alone.
- **VAE vs deterministic-control delta:** does the learned tree-VAE beat the cheap heuristic? If not, the deployable recommendation is the heuristic.

**Decisions:**
- Material recall at FPR ≤ standard **and** ≥ control → real complementary stage → write up for **P15c / p15b revision** (third disjoint leg).
- Low recall (attacks structurally normal) **or** FPR unacceptable on the heavy tail → confirms the blind spot is **structural, not an implementation gap** → strengthens the paper's negative result (publishable as-is).
- Control ≈ VAE → learned model adds nothing; cheap egress filter is the recommendation.

Either outcome is publishable and neither blocks p15b. Append a `RESULTS.md` with the recall/FPR table, per-sub-class breakdown, and the VAE-vs-control comparison.
