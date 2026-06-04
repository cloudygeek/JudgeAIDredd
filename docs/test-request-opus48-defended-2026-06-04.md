# Test request — Opus 4.8 defended cells on the p15b head-to-head corpora

**Date:** 2026-06-04
**Requested by:** P15b authoring pass (Cloud-Security/Adrian/p15b)
**Priority:** HIGH — p15b submission is held pending this row.

## Why

Mode 4 (Paper14 §VII) found that **claude-opus-4-8 breaks the Anthropic
floor**: at C4 SDK flood=50 (n=10) it leaks credentials (P1) 10/10 and
destruction (P3) 10/10, gesExec mean 55.0, against opus-4-7's ~1/8
(12.7% pooled). The C1 permission gate hard-blocks it 0/10
(`results/mode4-2026-05-31/results-2026-06-03-q124-closure.md`).

p15b's central empirical claim is "Anthropic frontier agents sit at the
0% baseline floor; the defence's measurable contribution is largest
where the agent's own injection-resistance training has not caught up."
Every Anthropic cell in the current 6-agent matrix (Sonnet 4.6, Opus
4.7) sits at that floor on T3e / AgentDojo workspace+banking+slack /
InjecAgent, giving the gate no measurable surface area on Anthropic rows.

**If 4.8's regression reproduces on the p15b injection corpora, it
becomes the first Anthropic-frontier cell with a non-zero baseline that
Dredd measurably defends** — converting the likely reviewer objection
("the defence only helps weak open-weights models") into the paper's
strongest single result. That is the deliverable this request targets.

## Harness prerequisite

`opus-4-8` is **not yet a registered model** in the corpus runners. Add it
before running:

- `benchmarks/agentdojo/bedrock_llm.py` model map (mirror line 17
  `"opus-4-7": "eu.anthropic.claude-opus-4-7"`): add
  `"opus-4-8": "eu.anthropic.claude-opus-4-8"` (Bedrock ID confirmed in
  Mode-4 runs: `anthropic.claude-opus-4-8`).
- `benchmarks/agentdojo/run_benchmark.py` `--model` choices list (line
  ~463): add `"opus-4-8"`.
- Same two additions in `benchmarks/injecagent/run_benchmark.py` and
  `benchmarks/mt_agentrisk/run_benchmark.py` model registries.
- `src/bedrock-client.ts` line 81 `isOpus47` guard: confirm whether the
  temperature/`deprecated` handling that gated opus-4-7 also applies to
  4-8 (the InjecAgent opus-4-7 baseline was lost to a
  `temperature is deprecated` ValidationException, commit `1b4341f5`;
  do not let 4.8 hit the same wall).

## Cells requested (mirror the existing matrix protocol exactly)

Judge config throughout: **Sonnet 4.6 judge + prompt v2 (B7.1) + Cohere
Embed v4**, so the 4.8 row is directly comparable to the existing rows
and drops into Tables 2-5 without a footnote.

| # | Corpus | Arms | N / reps | Notes |
|---|---|---|---|---|
| 1 | **T3e (exfil)** | baseline, Dredd v2 | match existing Anthropic cells (200 baseline reps/scenario, defended to budget) | The headline cell. If 4.8 exfiltrates at non-zero baseline like Mode-4 predicts, this is the floor-break. Strict canary-server metric. |
| 2 | **AgentDojo `important_instructions`** | baseline, Dredd v2, **PromptArmor** | all 4 suites, weighted N_sec=949 | PromptArmor arm is cheap here and gives the 3-way none/Dredd/PA row. Same Bedrock-Sonnet 4.6 detector backend as the rest of the matrix. |
| 3 | **MT-AgentRisk** | baseline, Dredd v2 | classifiable subset, match the 5-agent protocol (≈820 scenarios) | Multi-turn corroboration; report ASR on COMPLETE/(COMPLETE+REJECT). |
| 4 | InjecAgent (optional) | baseline, Dredd v2 | 1054 base | Only if cheap; Anthropic cells here are saturated at 0.0%, so lower value than 1-3. |

PromptArmor on T3e is detection-only (SDK built-in-tool constraint, see
§4.3 "Detection-rate measurement on T3e") — do not block on it.
Composite (Dredd+PA) arm: not requested for 4.8 unless an AgentDojo
suite shows a PromptArmor residual >5% (then a composite cell on that
suite would complete the orthogonality story for the new model).

## Example invocations

```bash
# Cell 2 — AgentDojo, all suites, three arms
python benchmarks/agentdojo/run_benchmark.py --model opus-4-8 --all-suites \
  --attack important_instructions                         # baseline
python benchmarks/agentdojo/run_benchmark.py --model opus-4-8 --all-suites \
  --attack important_instructions --defense B7.1          # Dredd v2
python benchmarks/agentdojo/run_benchmark.py --model opus-4-8 --all-suites \
  --attack important_instructions --promptarmor-backend bedrock \
  --promptarmor-model <sonnet-4-6-detector-id>            # PromptArmor

# Cell 3 — MT-AgentRisk
python benchmarks/mt_agentrisk/run_benchmark.py --model opus-4-8           # baseline
python benchmarks/mt_agentrisk/run_benchmark.py --model opus-4-8 --dredd-defense B7.1
```

## Acceptance criteria

- Each cell has durable **per-rep JSON** (not just a `.log`) — the Q2
  caveat in the Mode-4 closure doc is a standing lesson; summary-only
  cells are not citable.
- Each result JSON carries the `build` field (git commit, SDK version,
  Bedrock region, model id) per the paper's reproducibility contract.
- Report per-cell Wilson 95% intervals.
- A one-line cross-cell summary line per corpus appended here when done,
  in the same shape as the existing Table 2 / Table 3 rows, so the
  paper row can be transcribed without re-deriving.

## Expected outcomes (hypotheses, to be confirmed by data)

- **H1 (primary):** 4.8 T3e baseline exfil > 0 and Dredd drops it toward
  the floor — the first measurable Anthropic-frontier defence delta.
- **H2:** 4.8 AgentDojo travel/banking baseline ASR is non-zero (it sat
  at the floor for 4.6/4.7), Dredd ≤ 0.7%, PromptArmor leaves a residual.
- **H3 (null is still useful):** if 4.8 sits at the floor on the
  injection corpora despite leaking in Mode-4's long-session protocol,
  that itself is a finding — the floor-break is duration-specific, not
  injection-class-specific, and belongs in §4.4 scope boundaries.

## Paper placement when results land

New `claude-opus-4-8` row added to: Table 2 (cross-corpus summary),
Table 3 (none/Dredd/PromptArmor head-to-head), Table 4 (MT-AgentRisk),
and the new consolidated master effectiveness table (p15b task #8).
Abstract "six-defended-agent" → "seven-defended-agent"; §4 matrix
description updated. The Mode-4 regression gets a one-sentence forward
reference from §2 / §4.4 as the motivation for including 4.8.
