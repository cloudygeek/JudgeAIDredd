# bad_run/ — quarantined results (wrong judge call point)

**Quarantined 2026-06-18.**

These result campaigns evaluated the Dredd defence at the **wrong point**. The
test-framework executors that produced them — `runner-t3e-pretooluse.ts` and
`runner-p14.ts` via `executor-{bedrock,converse,openai,vertex,mantle}.ts` /
`executor.ts` — judge **post-turn** (`onTurnComplete`): every tool call in a
turn runs via `executeTool()` first, *then* the judge evaluates, and a
`hijacked` verdict (`shouldBlock()`) only blocks the **next** turn. That is the
Stop-hook design the defence paper explicitly rejects, **not** the per-call
**PreToolUse** gate the paper's architecture specifies. Same-turn exfiltration
is therefore *recorded but not prevented* (e.g. MiniMax-M2.5: 54/211 exfils had
`verdict=hijacked, blocked=true` yet the canary still left).

**Coverage:** T3 / T3e (exfil + disclosure) / T4 / T5 + the crack-vector corpus,
all dates (37 campaign dirs). These backed the paper's flagship exfiltration
results (11-exfiltrator table, Qwen3-235B 63%→21%, the disclosure trio, the
Haiku split-file cell, T4/T5).

**Re-run plan:** `docs/test-request-pretooluse-rerun-2026-06-18.md` (route through
the real PreToolUse deny hook — `sdk-hooks.ts:createDefenceHooks` /
`/evaluate` — and re-measure cost/FPR/utility, which per-call gating changes).

## NOT affected (kept in results/ — already gate at PreToolUse, before execution)
- **AgentLAB** — `runner-agentlab.ts` → `createDefenceHooks` (PreToolUse). The June-09 `p15b-2026-06-09-agentlab-*` dirs are correct.
- **AgentDojo** — `benchmarks/agentdojo/dredd_defense.py` (BasePipelineElement before ToolsExecutor, `/evaluate`).
- **InjecAgent** — `benchmarks/injecagent/run_benchmark.py:evaluate_via_dredd()` (per-call `/evaluate`).
- **MT-AgentRisk** — `benchmarks/mt_agentrisk/` (per-call `/evaluate` + `blocked_ids`).
- Judge-calibration (`adversarial-judge-*`, `test1`, `test8`), embedding/threshold sweeps, pipeline-E2E, and Mode-4 (`mode4-*`, which is P14, a separate CLI permission-proxy gate).

## Notes
- Baseline (`none`) arms inside these dirs remain valid (no judge involved) but
  were moved with their campaigns to keep each matched comparison together.
- **Left in place, needs manual review:** `results/2026-05-21-bedt3-injecagent-and-bedt4-deepN/`
  is mixed — `phaseB-injecagent-*` is correct (InjecAgent `/evaluate` bridge);
  `phaseE-gpt4omini-deepN-*` is an early AgentLAB run (`dreddVerdicts` structure)
  whose pre-/post-upgrade wiring was not confirmed.
