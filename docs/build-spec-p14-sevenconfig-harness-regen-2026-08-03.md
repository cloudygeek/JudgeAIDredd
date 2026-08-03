# Build spec — regenerate the P14 seven-config modality harness (CLI + SDK, approval, sandbox)

**Date:** 2026-08-03
**Requested by:** P14 reproducibility (paper: `Cloud-Security/Adrian/p14`; MS CYSE-D-26-00987).
**Priority:** **NOT on the CYSE-D-26-00987 critical path.** This is the post-revision / thesis / artifact-release reproducibility effort. The Aug-19 major revision ships on the "associations, not an identified causal decomposition" reframe (already in `p14.tex` §Defence Layer Attribution) — do **not** block or delay the resubmission on this build.
**Goal:** rebuild a clean, fully-runnable harness for the **seven P14 configurations** (C1, C2, C2a, C2b, C3, C3a, C4), from the paper specification + supplementary appendices + the current `test-framework`, so the modality/defence-layer matrix is reproducible going forward. Replaces the original CLI harness, which is lost.

---

## 0. READ FIRST — before writing any code

### 0.0 Check the Studio first — this build may be unnecessary
The original seven-config CLI harness (that produced the primary 1,764-cell matrix and the `C2a`/`C3a` arms) is **not in any git-tracked or cloud location**: searched all repos + full histories, all 12 d2 branches + the `research-v1` tag + 1007 commits (using the harness's execution signatures `--dangerously-skip-permissions` / `cli-headless` / `@anthropic-ai/sandbox` / `permissionMode auto|headless`, all **0 hits**), GitHub (cloudygeek), S3 (`ai-research-testing`, results only), and backups. d2/JudgeAIDredd began as the **Dredd judge** project; the p14 code was grafted in later as the **reduced** cross-technique runner (`C1/C4 × judge`, SDK-only, re-authored scenario ports) — the original modality harness was **never committed here**.
**The one unchecked place is the Studio (172.16.0.99).** Probe it before building:
```
grep -rlI --include='*.ts' --include='*.py' --include='*.sh' \
  -e 'dangerously-skip-permissions' -e "'C2a'" -e 'cli-headless' -e '@anthropic-ai/sandbox' ~ 2>/dev/null | head
```
If the original is there: **restore + document it instead of rebuilding.** If not, proceed.

### 0.1 This produces a NEW dataset, NOT a reproduction — state it up front
A rebuilt harness cannot re-derive the published numbers, for two structural reasons:
1. **Model drift** — the primary matrix used Opus-4.6-era models; behaviour has since moved.
2. **Reconstructed scenarios** — already demonstrated: the current T4 ports give `C4` GES = **100** where the paper reports **35.2** (`docs/g2-sonnet-t4-results-2026-05-28.md`, sd=0 rules out a small-sample artefact); *"the harness is running our ports of P14's templates, not the templates."*
So frame the output as a **fresh, reproducible re-validation baseline**, not a confirmation of `+5.8 to +10.5` GES. The honest reproducibility claim is "here is a documented, reconstructable, released harness," not "we reproduced the matrix."

### 0.2 Authoritative sources for the design (nothing here is guessed)
- **Config definitions:** `Cloud-Security/Adrian/p14/p14-cybersecurity-main/p14.tex` §Experimental Design / §Configurations (the `\item C1..C4` list) and §Permission-mode collapse. **This is the spec — implement to it, not to this summary.**
- **Attack scenarios:** the paper's **supplementary appendices carry verbatim scripts** (T3 in Appendix B, etc.); the current `scenarios/*.ts` are runnable ports of the same. Reconstruct from the appendices where fidelity matters.
- **Surviving results (validation reference, not a target):** `AI-Agent-SDK-vs-CLI/release/zenodo_v3_staging/zenodo_p14_v3/data/` (aggregate CSV + `analysis/a2_ges_decomposition.*`), `Paper14/results/results-full.csv`.
- **Already-built pieces to reuse:** repo `cloudygeek/agent-guardrail-harness`, branch `p14-revision-reruns-2026-08` — `test-framework/src/approval.ts` (scripted deny-by-default policy + ML classifier) and `scripts/score-approval.ts`. **These live in a different repo; port them in.**

## 1. The seven configs as orthogonal toggles (implement to p14.tex, verify against it)

| Config | Runtime | System prompt | Approval | Sandbox | Paper label |
|---|---|---|---|---|---|
| **C1**  | CLI | on  | human-proxy | on  | CLI default |
| **C2**  | CLI | on  | ML classifier | on | CLI auto |
| **C2a** | CLI | on  | none | **off** | CLI headless |
| **C2b** | CLI | on  | human-proxy | **off** | CLI no-sandbox |
| **C3**  | SDK | **off** | dontAsk | (SDK) | SDK default |
| **C3a** | SDK | on  | none (dontAsk) | (SDK) | SDK + CLI prompt |
| **C4**  | SDK | **off** | bypassPermissions | off | SDK bypass |

Four orthogonal axes: **runtime** {CLI, SDK}, **system prompt** {on, off}, **approval** {human-proxy, ML, none}, **sandbox** {on, off}. The seven named configs are the specific cells the paper reports; the runner should expose the axes and let `--config` select the named combinations (and, for the R1-2/R2-2 factorial, arbitrary cells).

## 2. Build tasks

**T-A — CLI runtime path.** The SDK path exists (`executor-bedrock.ts`, `claude-agent-sdk query()`). Add a **CLI executor** that drives the `claude` binary headless (`-p`/print, `--output-format stream-json`) with the paper's permission modes (default / auto / bypass) and the same tool set, so C1/C2/C2a/C2b run through the actual CLI surface rather than the SDK. Keep model/region/canary/scoring identical to the SDK path so only the runtime axis differs.

**T-B — Live approval gate at PreToolUse.** ⚠️ `canUseTool` (SDK permission callback) is **not bridged** through the headless subprocess (verified 2026-08-02: 0 decisions even with `allowedTools:[]` + `permissionMode:default`). Use **Claude Code PreToolUse hooks** instead (this repo has `hooks/`; the AgentLab/AgentDojo suites already gate at PreToolUse). Two hook variants:
  - **human-proxy (C1/C2b):** a deterministic **scripted policy** — port `approval.ts::scriptedPolicyDeny` (deny credential-file access / network egress / destructive ops). Document it honestly as a *scripted-policy human-equivalent*, not a live human (the original live-human procedure was not retained; R2-4).
  - **ML classifier (C2):** port `approval.ts::mlClassifierDeny` (a Haiku Bedrock call per tool call).
  A denied call must be **blocked before execution** (hook exit / deny verdict) and **logged** (tool, args, decision, rule).

**T-C — Sandbox toggle.** Wire `@anthropic-ai/sandbox-runtime` as the **on** arm (filesystem + domain-level network isolation) and a genuine **off** arm. To escape the Docker confound (R3-W2), run the **no-sandbox** arms (C2a/C2b/C4) on **bare metal or a container with the perimeter disabled**, so the sandbox contribution is measured against a real absence of isolation, not against Docker's.

**T-D — Scenario fidelity.** Reconstruct the original attack templates from the paper's supplementary appendices where comparability matters (T3, T4 especially — T4 is where the 65-point port gap sits). Otherwise reuse the current `scenarios/*.ts` ports and **carry the caveat** that numbers are not commensurable with the published matrix.

**T-E — Config wiring + selector.** Register the seven configs as toggle combinations; add `--config C1,C2,C2a,C2b,C3,C3a,C4` (and free axis flags for the factorial). Preserve full per-run records (turns + toolCalls + approval log) for downstream scoring.

**T-F — Run integrity (mandatory).** Reuse the d2 agent's `test-framework/src/run-integrity.ts` (model-ID pre-flight + fake-zero positive controls). **Do not run any config until each model ID is probe-confirmed** (HTTP 200, non-empty, `end_turn`) — the Fable-5 lesson (100% 404 scored as clean 0%, `Cloud-Security/Adrian/p15b/DATA_INTEGRITY_fable5_2026-08-02.md`).

## 3. Validation (before any full campaign)

1. **Model-ID pre-flight** per T-F, one probe per tier, raw response pasted into the findings doc.
2. **Toggle smoke tests** — prove each axis actually changes behaviour, n=1 each:
   - sandbox-on **blocks** a write outside the workdir / a non-approved egress; sandbox-off **allows** it.
   - approval-on **denies** a `curl` of `.env` to an external host (log shows the deny + rule); approval-none allows it.
   - system-prompt-on vs -off changes the refusal/flag behaviour on a T3 probe.
   - CLI vs SDK runtime both execute the same scenario and record turns.
3. **Reference sanity** — spot-check a couple of regenerated cells against the surviving aggregate CSV for *direction* (not exact match; expect the T4 port gap).

## 4. Re-run scope once built (do the scoped factorial first)

Do **not** open with the full 1,764-cell matrix. Start with the reviewer-relevant slice:
- the **prompt × approval × sandbox** factorial on core techniques {T1, T3, T4, T8}, matched and replicated, **n≥20/cell**, one frontier tier + one mid tier — which is the identified-decomposition the R1-2/R2-2 reviewers asked for and which the current harness cannot produce (it lacks C2a/C3a).
- Compute is large and subprocess-heavy (CLI path spawns `claude` per run) → **Fargate or the Studio, not a laptop** (`dredd/fargate` has the Dockerfiles; the container also gives the clean `/usr/local/bin/claude` env).

## 5. Deliverables

- The rebuilt harness on a branch (CLI executor + PreToolUse approval hooks + sandbox toggle + seven-config selector + reused run-integrity), smoke-verified per §3.
- A **new, self-consistent results set** with full per-run records, plus a reproducibility note stating (a) the original harness was not retained, (b) this is a documented reconstruction, (c) numbers are a fresh baseline, not a reproduction of the published matrix.
- A **releasable artifact** answering R1-4 (configs + approval logic + per-run results + analysis code) — the current harness + these reconstructed layers + the `agent-guardrail-harness` benign/approval/vendor-native code.

## 6. Priority reminder

Reproducibility artifact / thesis effort, **not** the Aug-19 revision. If the Studio (§0.0) holds the original, this whole build collapses to "restore + document." Otherwise it is the clean, honest replacement for a harness that is otherwise lost.

---
*Provenance of the "it's lost" claim (so the next reader need not re-run the search):* exhaustive negative search 2026-08-03 across all local repos + histories, all d2 branches/tags/1007-commits, GitHub cloudygeek, S3 ai-research-testing, and non-IdeaProjects paths, using the harness's execution signatures. Only aggregate results, analysis scripts, and scenario ports survive. Full reasoning in the Cloud-Security session log and `Cloud-Security/Adrian/p14/` planning docs.
