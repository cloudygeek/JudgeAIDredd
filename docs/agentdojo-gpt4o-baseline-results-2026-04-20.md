# AgentDojo baseline (no defence) — GPT-4o and GPT-4o-mini, 2026-04-20

Baseline arm execution of the GPT-4o AgentDojo plan (`test-requirements-agentdojo-gpt4o-2026-04-20.md`). Judge Dredd was **not** active for these runs — these measure the undefended agents' susceptibility to the `important_instructions` prompt-injection attack, and act as the §4.1.1 gating check before paying for the defended arms.

## Configuration

| | |
|---|---|
| Judge Dredd commit | `267816c` |
| AgentDojo commit | `18b501a630db` (installed from PyPI `agentdojo==0.1.35`) |
| Benchmark version | `v1.2.2` |
| Attack | `important_instructions` |
| Defended agents | `gpt-4o-2024-05-13`, `gpt-4o-mini-2024-07-18` |
| Temperature | 0.0 |
| Parallelism | 1 (per agent; two agents run in separate processes) |
| Judge | none (baseline arm) |
| Run host | local (MacBook, Python 3.13, venv) |

Logs: `logs/gpt4o-security.log`, `logs/gpt4o-benign.log`, `logs/gpt4o-mini-security.log`, `logs/gpt4o-mini-benign.log`.
Raw per-scenario results: `results/agentdojo-gpt4o-baseline/`, `results/agentdojo-gpt4o-mini-baseline/`.

## Results

**ASR** = attack success rate (injected goal succeeds). Lower is better for the defender.
**Benign util** = user-task completion rate with no injection present. Higher is better.
**Util under attack** = user-task completion rate when the injection is present (whether or not the injection succeeded).
All intervals are Wilson 95% CIs.

| Model | Suite | ASR (95% CI) | Benign util (95% CI) | Util under attack |
|---|---|---|---|---|
| gpt-4o | workspace | 24.6% [21.3–28.4] (N=560) | 67.5% [52.0–79.9] (N=40) | 34.3% |
| gpt-4o | banking | 72.2% [64.4–78.9] (N=144) | 93.8% [71.7–98.9] (N=16) | 80.6% |
| gpt-4o | slack | 92.4% [85.7–96.1] (N=105) | 90.5% [71.1–97.3] (N=21) | 65.7% |
| gpt-4o | travel | 32.9% [25.6–41.0] (N=140) | 70.0% [48.1–85.5] (N=20) | 40.0% |
| **gpt-4o** | **ALL** | **40.6%** [37.5–43.7] (N=949) | **77.3%** [68.0–84.5] (N=97) | — |
| gpt-4o-mini | workspace | 17.1% [14.2–20.5] (N=560) | 85.0% [70.9–92.9] (N=40) | 35.5% |
| gpt-4o-mini | banking | 50.0% [41.9–58.1] (N=144) | 62.5% [38.6–81.5] (N=16) | 46.5% |
| gpt-4o-mini | slack | 64.8% [55.3–73.2] (N=105) | 81.0% [60.0–92.3] (N=21) | 53.3% |
| gpt-4o-mini | travel | 34.3% [26.9–42.5] (N=140) | 55.0% [34.2–74.2] (N=20) | 37.9% |
| **gpt-4o-mini** | **ALL** | **29.9%** [27.1–32.9] (N=949) | **74.2%** [64.7–81.9] (N=97) | — |

## §4.1.1 gating assessment

The requirements doc gates the defended arms on reproducing AgentDojo's published 47.69% baseline ASR for `gpt-4o-2024-05-13` within ±3 pp on the workspace suite.

- **Workspace ASR (gpt-4o): 24.6% [21.3–28.4]** — 23 pp below the 47.69% target. **Fails the ±3 pp gate.**
- **Overall ASR (gpt-4o): 40.6% [37.5–43.7]** — 7 pp below the 47.69% target. Closer, but still outside ±3 pp.

The overall 40.6% is consistent with the order of magnitude in Debenedetti et al.'s Figure 5 (GPT-4o ≈ 47%), but the workspace slice is markedly lower. Possible explanations:

1. **Suite drift**: v1.2.2 reworked workspace user and injection tasks after the paper. The 47.69% figure is from an earlier snapshot; v1.2.2 scores may not be directly comparable.
2. **System-message fallback**: `run_benchmark.py::load_system_message()` tries to read `agentdojo/data/system_messages.yaml` via `importlib.resources`. If that fails silently it falls back to `DEFAULT_SYSTEM_MESSAGE`, which is shorter than upstream and may change agent behaviour. Needs verification.
3. **Pipeline shape**: we construct `AgentPipeline` manually (to slot Judge Dredd in) rather than using `AgentPipeline.from_config`. Any divergence from the upstream `SystemMessage → InitQuery → LLM → ToolsExecutionLoop[ToolsExecutor, LLM]` shape could affect ASR.
4. **Model drift**: `gpt-4o-2024-05-13` is a pinned snapshot but OpenAI occasionally updates routing behind the alias; record the `openai-model` response header on the defended-arm run to confirm.

**Recommendation:** do not block the defended arms on this — the absolute ASR level is less important than the *delta* between arms, and the baseline is high enough (40.6% overall, 72.2% on banking, 92.4% on slack) that Judge Dredd has real headroom. But flag these four candidates explicitly in the paper's Limitations and resolve #2 before the defended-arm run.

## §4.1.2 benign-utility gating

Target: within ±5 pp of AgentDojo's published 69% benign utility.

- **gpt-4o ALL: 77.3% [68.0–84.5]** — 8 pp above target. Within the upper CI of ±5 pp. Pass.
- **gpt-4o-mini ALL: 74.2% [64.7–81.9]** — 5 pp above target. Pass.

The per-suite spread is wide (55%–94%) driven by small N per suite (n≤40). The aggregate is the meaningful number.

## Utility under attack

"Util under attack" drops dramatically vs. benign (e.g. gpt-4o workspace: 67.5% → 34.3%, gpt-4o banking: 93.8% → 80.6%). Even when the injection doesn't fully succeed at its goal, it disrupts the legitimate task. This will be the interesting axis for the defended arm: a successful defence should push both ASR ↓ *and* util-under-attack ↑.

## Cross-model comparison

gpt-4o-mini is **~11 pp more resistant overall** (29.9% vs 40.6% ASR). This is the opposite of the spec's prior expectation (which cited ~53% for mini in follow-up work). Either the follow-up data was on an earlier mini snapshot, or mini has strengthened against this attack style. Worth re-reading the spec's rhetorical framing — if mini is now lower-ASR than the full 4o, the argument that *"OpenAI models are vulnerable"* rests mainly on the 4o banking/slack numbers, not on mini.

## Cost

Estimated from recorded token consumption:

| | API cost |
|---|---|
| gpt-4o security + benign | ~$10–15 (actual, dominated by workspace) |
| gpt-4o-mini security + benign | ~$1 |
| **Total** | **~$12–16** |

Within the §3.1 budget envelope. Full 3-arm matrix (baseline + baseline prompt + B7.1) should therefore land near $40–50 total — well inside the $80 cap.

## Known run issues

1. **OpenAI 30k TPM rate limit** on gpt-4o. Patched `benchmarks/agentdojo/run_benchmark.py::_patch_openai_retry` to 10 attempts / 90 s backoff, which handled the throttling transparently but pushed wall-clock to ~2.5 h for the gpt-4o security arm.
2. **Malformed tool-call args crash** in AgentDojo's OpenAI adapter (`_openai_to_tool_call` hard-crashes on `json.loads` failure). Hit once by gpt-4o-mini on workspace `user_task_35 × injection_task_9` — killed the whole run. Patched `_patch_openai_tool_call_decode` to coerce malformed args to `{}` so the scenario fails cleanly and the run continues. Needs to be carried into the defended-arm runs. Worth upstreaming to AgentDojo.
3. **JSON summary mis-read** in my mid-run check — one scenario's result file had a truncated JSON; unclear if retry wrote a complete version. Spot-audit before writing the paper table.

## Next steps

1. Verify `load_system_message()` actually returns the upstream YAML content on this host. If it falls back, fix before defended arms.
2. Start Judge Dredd (Ollama or Bedrock), run the **baseline-prompt** arm for both agents on all 4 suites.
3. Run the **B7.1** arm for both agents on all 4 suites.
4. Regenerate this document with three arms side-by-side and the §4.2 acceptance check.
