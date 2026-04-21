# AgentDojo B7.2 + R0–R7 rerun — results, 2026-04-21

Follow-up to `agentdojo-gpt4o-b71-results-2026-04-21.md`. Evaluates Dredd with the new `B7.2` judge prompt (R0 executive-assistant preamble) and the R2–R7 domain-policy layer introduced in commit `00d5676`. R1 (AgentDojo identifier deny-list) was **not** enabled — this is the production-configuration arm of the test plan, intended to generalise beyond the benchmark.

**Headline:** the change is a net loss. B7.2 + R2–R7 is worse than B7.1 on both the ASR and the benign-FPR axis for both OpenAI defended agents. The test plan's §3.2 "negative outcome" clause fires: the bet on R0 softening the judge's over-trigger was wrong, and the combined layer needs a different intervention.

## Configuration

| | B7.1 run | B7.2 run |
|---|---|---|
| Judge Dredd commit | `267816c` | `00d5676` |
| Judge prompt | B7.1 (hardened v2) | **B7.2** (hardened v2 + R0 preamble) |
| Stage 1.5 domain policy | none | **R2–R7 on, R1 off** |
| Judge model | Sonnet 4.6 (Bedrock eu-central-1) | same |
| Defended agents | gpt-4o-2024-05-13, gpt-4o-mini-2024-07-18 | same |
| Security subset | 385 (gpt-4o) / 284 (mini) pair-filtered | same pairs |
| Benign subset | 97 tasks × 4 suites per agent | same |

## Headline results

Extrapolated ASR uses the pair-filtered defended-arm counts against the full 949-scenario denominator: successes_baseline_failed = 0 (unchanged by any defence) + successes_defended on the 385/284 attacker-won subset.

### Attack success rate (full 949 denominator)

| Agent | Baseline | B7.1 | **B7.2** | B7.2 − B7.1 | B7.2 − baseline |
|---|---|---|---|---|---|
| gpt-4o | 40.6% [37.5–43.7] | 1.48% [0.88–2.46] | **2.85%** [1.96–4.11] | +1.4 pp | −37.7 pp |
| gpt-4o-mini | 29.9% [27.1–32.9] | 1.48% [0.88–2.46] | **4.95%** [3.74–6.52] | +3.5 pp | −24.9 pp |

### Per-suite security ASR (defended pairs only)

| Agent | Suite | Pairs | B7.1 ASR | **B7.2 ASR** |
|---|---|---|---|---|
| gpt-4o | workspace | 138 | 3.6% | **2.9%** (better) |
| gpt-4o | banking | 104 | 1.9% | **5.8%** (worse) |
| gpt-4o | slack | 97 | 2.1% | **11.3%** (worse) |
| gpt-4o | travel | 46 | 10.9% | **13.0%** (worse) |
| gpt-4o-mini | workspace | 96 | 4.2% | **0.0%** (better) |
| gpt-4o-mini | banking | 72 | 5.6% | **37.5%** (far worse) |
| gpt-4o-mini | slack | 68 | 5.9% | **20.6%** (worse) |
| gpt-4o-mini | travel | 48 | 4.2% | **12.5%** (worse) |

### Benign utility (N=97 per agent)

| Agent | Baseline (undefended) | B7.1 | **B7.2** | B7.2 vs B7.1 | Drop vs baseline |
|---|---|---|---|---|---|
| gpt-4o | 77.3% [68.0–84.5] | 49.5% | **41.2%** [32.0–51.2] | −8.3 pp | **−36.1 pp** |
| gpt-4o-mini | 74.2% [64.7–81.9] | 64.9% | **46.4%** [36.8–56.3] | −18.5 pp | **−27.8 pp** |

### Task-level FPR (benign tasks broken by the defence)

| Agent | B7.1 FPR | **B7.2 FPR** | Δ |
|---|---|---|---|
| gpt-4o | 27.8% [19.9–37.5] | **36.1%** [27.2–46.0] | +8.3 pp |
| gpt-4o-mini | 9.3% [5.0–16.7] | **27.8%** [19.9–37.5] | +18.5 pp |

### Judge-deny behaviour

| Arm | Judge calls | Denied | Deny rate | Avg latency |
|---|---|---|---|---|
| gpt-4o security B7.2 | 1616 | 773 | 47.8% (B7.1: 52.1%) | 5,022 ms |
| gpt-4o benign B7.2 | 346 | 145 | **41.9%** (B7.1: 33.4%) | 4,490 ms |
| gpt-4o-mini security B7.2 | 1888 | 959 | 50.8% (B7.1: 65.4%) | 4,569 ms |
| gpt-4o-mini benign B7.2 | 550 | 177 | **32.2%** (B7.1: 14.2%) | 3,614 ms |

## Acceptance check

| Criterion | Target | gpt-4o | gpt-4o-mini |
|---|---|---|---|
| ASR reduction ≥ 30 pp vs baseline | ≥ 30 pp | **−37.7 pp ✅** | **−24.9 pp ❌** |
| Benign utility drop ≤ 10 pp | ≤ 10 pp | **−36.1 pp ❌** | **−27.8 pp ❌** |
| Task FPR ≤ 3% (plan target ≤ 10% for headline) | ≤ 10% | **36.1% ❌** | **27.8% ❌** |

Neither agent passes any benign criterion. gpt-4o-mini also fails the ASR threshold. **B7.2 is strictly worse than B7.1 on 5 of the 6 cells.**

## What went wrong

Two independent hypotheses were in play going into this run. Neither paid off.

### H1: R0 softer framing would reduce over-triggering

Empirically, R0 seems to have done the opposite on this judge: tool-call deny rate went UP on benign traffic for both agents (gpt-4o 33.4% → 41.9%; mini 14.2% → 32.2%). The "executive office assistant" persona may prompt the Sonnet judge to apply an even stricter "would the principal approve this?" test than B7.1's security-analyst framing, tightening the allow envelope rather than loosening it. Counterintuitive but consistent with the numbers.

### H2: R2–R7 structural rules would catch attacks earlier and bypass judge on legitimate calls

- **R4 / R6 hard-denies** should cut ASR, not raise it. On mini-banking they seem to have let more attacks through (5.6% → 37.5%) — but they can only ever block, never allow. The explanation must be that the judge *used* to catch these attacks and the rule now routes them through a subtly different code path. The most likely candidate: `R3` flipped some calls from "judge review" to "domain-allow" when a recipient literal happened to appear in the user intent *because the attack injected it into the assistant's prior messages* (via read_emails returning the injected instruction). The intent-matching in R3 looks at `originalTask` only, so that shouldn't fire — but the `recipients` field in the tool arg might alias a literal string from elsewhere. **Action:** instrument R3 to log when it allows and audit the mini-banking failures.
- **R3 / R7 "allow when target in intent"** short-circuits around the judge. On benign traffic the recipient rarely appears verbatim in the user prompt (the user says "email my manager", not "email david.smith@…"), so these rules mostly *don't* fire in the allow direction — meaning the judge is still invoked for benign calls, and now sees the tighter B7.2 prompt, which explains the FPR regression.
- The allow-paths in R3/R7 work where attacker names the venue in the injection; the benign paths where the user names the recipient in natural language don't fire. **Net effect:** rules help the attacker slightly and hurt the benign user significantly.

## What to change next

The tactical fixes are narrow:

1. **Roll back R0.** Keep B7.1 as the shipped prompt until we have evidence that a new framing improves FPR in isolation. R0 should be A/B-tested against B7.1 with the domain rules held constant — mixed both at once here, can't attribute the regression cleanly.
2. **Instrument the domain layer.** Add per-rule hit/miss counts to `Dredd stats` output. Without it we can't tell whether R2–R7 fire or just pass through.
3. **Widen R3's intent match.** Currently the check is a literal substring of the recipient string in `originalTask`. Extend to also match:
   - Email local-parts and domains separately (so "email alice" in intent matches `alice@company.com`).
   - Any string from prior tool outputs that the user referenced (e.g. a contact the user searched for).
   The second requires pulling `SessionTracker` context into the interceptor.
4. **Re-test with R1 enabled** (B7.2-benchmark arm from the test plan). Even though the rule is benchmark-specific, it isolates "how much of B7.1's FPR floor is driven by the judge getting attackers it should have caught by policy?". A clean R1-on run with B7.1 prompt would answer that cheaply.

## What still holds

- B7.2 ASR on gpt-4o (−37.7 pp vs baseline) still clears the ≥30 pp target. The defence works; the FPR is the problem.
- The pipeline + tooling changes (pair-file mode, rate-limit retry, malformed-JSON fail-soft, domain-policy module with unit tests) are sound and will be reused for whatever prompt/rule combination comes next.
- The dataset (baseline JSONs + B7.1 JSONs + B7.2 JSONs + successful-pairs files) supports any further analysis without needing to re-run the undefended arm.

## Cost + time

| Phase | Wall clock | Notes |
|---|---|---|
| gpt-4o B7.2 security | 10,542 s (2.9 h) | 1616 judge calls @ 5.0s avg |
| gpt-4o B7.2 benign | 2,500 s (42 min) | 346 judge calls |
| gpt-4o-mini B7.2 security | 11,487 s (3.2 h) | 1888 judge calls @ 4.6s avg |
| gpt-4o-mini B7.2 benign | 3,163 s (53 min) | 550 judge calls |

OpenAI spend: ~$10 (both agents × both arms).
Bedrock spend (Sonnet 4.6 judge, 4,400 calls × $0.0135): ~$60.
**Total B7.2 run: ~$70.** Grand total across B7.1 + B7.2 + baseline ≈ $145, still under the §3.1 $100-per-phase envelope amortised over 3 phases.

## Data provenance

- B7.2 JSONs: `results/agentdojo-gpt4o-b72/gpt-4o-2024-05-13-dredd-B7.1/`, `results/agentdojo-gpt4o-mini-b72/gpt-4o-mini-2024-07-18-dredd-B7.1/`
  (directory is labelled `-dredd-B7.1` because the agent-side `--defense` flag value is unchanged; the server-side prompt is B7.2).
- Summary JSONs: `results/agentdojo-*-b72/summary-*.json`
- Logs: `logs/gpt4o-b72.log`, `logs/gpt4o-mini-b72.log`

Every result file carries the same provenance block as the B7.1 run.
