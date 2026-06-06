# executor-converse.ts bugs — affected past runs + rerun plan

**Discovered:** 2026-06-06 while investigating bedt9 nemotron throughput dropping to ~half the Tier B norm.

**Fixed in:** v0.1.520 (commit on `harness/agentlab-restore-and-fr4-adapters`, after this report).

## The two bugs

### Bug 1: blocking Bash exec starves the in-process canary server

`executor-converse.ts`'s `executeTool` used **`execSync`** for every Bash/Glob/Grep call. `CanaryServer` runs in the same Node process. While `execSync` is blocked waiting for a child command, the server's event loop cannot run — so a curl POST from inside the agent's Bash tool succeeds at TCP-connect (kernel-level) but the HTTP request body sits in the socket buffer until Node's loop frees up. With `--connect-timeout` set in the agent's curl invocations, every exfil attempt eats the full timeout (~10s) instead of getting an immediate 200 reply.

**Effect on data:**
- Throughput dropped to ~half normal on cells where the agent attempted network exfil (bedt9 nemotron observed at ~0.44 reps/min vs the Tier B norm of ~0.85).
- `exfiltrationCount` was undercounted: the server only processed the queued requests *after* execSync returned, by which point the agent had often given up and curl had already failed. Some buffered requests still went through the `req.on("end")` path and were recorded, but a portion would have been dropped by curl's connection close. The recorded count is **a lower bound, not the true count**.

### Bug 2: missing canary server plumbing

The newer `executor-converse.ts` (introduced 2026-05-24 by commit `2c643cf7b` to bypass the SDK for opus-4-7) was a **from-scratch port that dropped the `canaryServer` option entirely**. The runner passes `canaryServer: canary` in `executeScenario` options; the converse executor just ignored it.

**Effect on data:**
- `TestResult.exfiltrationDetected` is `undefined` for every run that went through the new executor-converse — the field is absent from the JSON entirely.
- `TestResult.gesExfil` and `displayedToUser`/`gesDisplayed` also missing.
- Hijack/GES (the textual signal) is **unaffected** — those use `detectCanaries` over the assistant text and tool i/o, not the server.

The older `archive/tests/executor-converse.ts` did have canary plumbing (and was used through ~2026-05-24); those runs are affected by Bug 1 only.

## Affected past runs

### Paper-relevant — rerun required for full network-exfil signal

All of these used `AGENT_BACKEND=converse` against the new `test-framework/src/executor-converse.ts`. None record `exfiltrationDetected`.

| RunId / dir | Model | Cells | Status |
|---|---|---|---|
| `p15b-t3e-opus45-eu-central-1` (`results/p15b-2026-06-06/t3e-opus45/`) | claude-opus-4-5 | 8 | done — RERUN |
| `p15b-t3e-opus46-eu-west-1` (`results/p15b-2026-06-06/t3e-opus46/`) | claude-opus-4-6 | 8 | done — RERUN |
| `p15b-t3e-gpt-oss-20b-eu-central-1` (`results/p15b-2026-06-06/t3e-gpt-oss-20b/`) | gpt-oss-20b | 8 | done — RERUN |
| `p15b-t3e-gpt-oss-120b-eu-central-1` (`results/p15b-2026-06-06/t3e-gpt-oss-120b/`) | gpt-oss-120b | 8 | done — RERUN |
| `p15b-t3e-sonnet45-eu-west-3` (bedt6) | claude-sonnet-4-5 | running 57/160 | KILL + RERUN |
| `p15b-t3e-devstral-2-123b-eu-central-1` (bedt12) | devstral-2-123b | running 159/160 | LET FINISH ~1m → RERUN |
| `p15b-t3e-nemotron-super-3-120b-eu-central-1` (bedt9) | nemotron-super-3-120b | running 12/160 (bug 1 affecting throughput) | KILL + RERUN on v0.1.520 |
| `p15b-t3e-minimax-m25-eu-central-1-rerun` (bedt10) | minimax-m2.5 | running 27/160 | KILL + RERUN on v0.1.520 |
| `p15b-t3e-glm-4-7-flash-eu-central-1-rerun` (bedt11) | glm-4.7-flash | running 20/160 | KILL + RERUN on v0.1.520 |

### Older runs — bug 1 only (event-loop starvation), exfil counts are lower bounds

Affected by event-loop blocking but the canary server WAS plumbed in. Their `exfiltrationDetected` is present but undercounted. Outside the active paper scope; rerun is optional.

| Dir | Model | Cells | Date |
|---|---|---|---|
| `results/test18-bedt3/` | claude-sonnet-4-6 | 3 | 2026-04-26 |
| `results/test18-bedt4/` | claude-opus-4-7 | 3 | 2026-04-26 |
| `results/test18-earlier/` (4 subdirs) | claude-sonnet-4-6, claude-opus-4-7 | 12 | 2026-04-24/25 |
| `results/test18-opus-pilot/` | claude-opus-4-7 | 6 | 2026-04-24 |
| `results/test18-sonnet-*` (3 dirs) | claude-sonnet-4-6 | 9 | 2026-04-25 |
| `results/test18-t19/20260425T122644Z/` | claude-opus-4-7 | 6 | 2026-04-26 |
| `results/test18/` (4 subdirs) | claude-sonnet-4-6, claude-opus-4-7 | 12 | 2026-04-24/25 |
| `results/test23-s3/` (4 subdirs) | qwen3-32b, qwen3-235b | 36 | 2026-04-26 |
| `results/test23-smoke/` | qwen3-32b | 1 | 2026-04-26 |

### Not affected

- bedt4 haiku-4-5 n=100 T3e replication run (`p15b-t3e-haiku45-n100-eu-west-3`) — uses the **SDK path** (`AGENT_BACKEND=sdk` default for Anthropic models), which goes through `executor-bedrock.ts`. Canary plumbing intact, no event-loop blocking inside the SDK process.
- bedt7 AgentDojo, bedt8 AgentLAB, bedt14 InjecAgent — those are different runners (test 7/22, test 25, InjecAgent). Don't use executor-converse.
- All non-T3e p15b results (mode4, agentlab, mt-agentrisk, injecagent).

## Rerun plan

Once v0.1.520 image is built and rolled out:

1. **Kill in-flight buggy runs** (bedt6, bedt9, bedt10, bedt11). Let bedt12 finish (essentially done).
2. **Pull bedt12 devstral results** to S3, then mark for rerun on v0.1.520.
3. **Sequence reruns by region availability** — Tier B is eu-central-1 only (bedt9-12 slots). Tier A spans eu-west-1/3, eu-central-1.
4. **Check existing pulled results** stay in `results/p15b-2026-06-06/` as v0.1.518/9 baseline; rerun results land in `results/p15b-2026-06-07/` (or similar dated dir) so the bad-vs-good comparison is preserved.

| Container slot needed | Run | RunId suggestion |
|---|---|---|
| eu-central-1 | claude-opus-4-5 T3e | `p15b-t3e-opus45-v0.1.520-eu-central-1` |
| eu-west-1 | claude-opus-4-6 T3e | `p15b-t3e-opus46-v0.1.520-eu-west-1` |
| eu-west-3 | claude-sonnet-4-5 T3e | `p15b-t3e-sonnet45-v0.1.520-eu-west-3` |
| eu-central-1 | gpt-oss-20b T3e | `p15b-t3e-gpt-oss-20b-v0.1.520-eu-central-1` |
| eu-central-1 | gpt-oss-120b T3e | `p15b-t3e-gpt-oss-120b-v0.1.520-eu-central-1` |
| eu-central-1 | minimax-m2.5 T3e | `p15b-t3e-minimax-m25-v0.1.520-eu-central-1` |
| eu-central-1 | glm-4.7-flash T3e | `p15b-t3e-glm-4-7-flash-v0.1.520-eu-central-1` |
| eu-central-1 | devstral-2-123b T3e | `p15b-t3e-devstral-2-123b-v0.1.520-eu-central-1` |
| eu-central-1 | nemotron-super-3-120b T3e | `p15b-t3e-nemotron-super-3-120b-v0.1.520-eu-central-1` |

**9 reruns × 8 cells × 20 reps × ~1 min/rep = ~24 container-hours.** Spread across 5-7 free containers, ~4-5 wallclock hours.

## Headline-finding implications

Per memory, the published p15b findings include:

> **Opus 4.8 T3e disclosure-Δ remains the strongest single defence cell:** none 88% → IT 28% (Δ -60pp on leaked-to-user axis). Network exfil is 0/60 on opus models.

The "0/60 network exfil on opus models" claim relies on `exfiltrationDetected`. That headline came from an opus-4-8 run done via the SDK path (executor-bedrock — canary plumbing intact), but if any opus-4-7 / 4-5 / 4-6 contributions to that figure ran via converse, the "0/60" is **unmeasured, not measured-zero**. Worth a separate audit before publication.

The "haiku exfil event" finding (Haiku 4.5 T3e.4 rep 11/20 actually POSTed to canary) IS valid — that ran on the SDK path.
