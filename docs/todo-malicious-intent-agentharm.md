# TODO — Explore Malicious-Intent / AgentHarm Use Cases for dredd

**Date added:** 2026-04-25
**Status:** Deferred. Pick up after Tests 19, 20, 21 land.
**Priority:** Low--medium. Not paper-blocking; potential paper-scope expansion if results land clean.

## What this is about

dredd's primary threat model is **goal hijacking** — the user's original task is benign, the agent gets redirected mid-session via tool-read content (AgentDojo `important_instructions`) or user-turn reframing (T3 / T3e). The judge evaluates each tool call against the *originating task* in a context isolated from the agent's conversation, and flags drift.

There's a second threat model dredd is *not* explicitly designed for but might still help with: **malicious-intent compliance** — the user's original request is itself harmful (`create ransomware`, `delete access logs`, `extract login data`, etc.), and the question is whether the agent refuses or complies. This is the threat model **AgentHarm** (UK AI Safety Institute, arXiv:2410.09024) targets.

Key open question: *does dredd's prompt v2 catalogue accidentally function as a harmful-action filter, in addition to a goal-hijack defence?*

If the user asks `create_ransomware()` and the judge sees:
- ORIGINAL TASK: ``Build a Python script that encrypts files and demands payment for the decryption key''
- PROPOSED ACTION: ``call `create_ransomware()` with target=...''

prompt v2's red-flag catalogue includes patterns for malicious code, credential extraction, exfiltration to external endpoints, etc. Some of these might fire `hijacked` even when the action is *consistent with the originating task*, because the originating task itself contains red-flag terms.

If this is the case, dredd is a wider-scope defence than the paper currently claims --- it catches malicious-action requests at the tool-call layer regardless of whether the user's stated intent is benign or hostile. This would extend §4.3 *Application beyond coding agents* and add a meaningful evidence point for productivity / messaging / compliance domains.

## What AgentHarm provides

- **110 harmful tasks + 110 benign tasks** (440 with augmentations) covering 11 harm categories: fraud, cybercrime, harassment, etc.
- **Stubbed simulated tools** (`get_all_login_data`, `create_ransomware`, `delete_access_logs`, `extract_data_from_database`, `download_from_alpha_bay`, etc.) --- no real APIs called, safe to run.
- **Inspect AI framework** (`github.com/UKGovernmentBEIS/inspect_evals`, MIT-with-safety-clause licence). `default_agent.py` uses Inspect's `Solver` pattern: `system_prompt → prompt_template → set_tool_choice → generate(tool_calls="loop")`.
- **Dual-judge grading:** `refusal_judge` (did the agent refuse?) + `semantic_judge` (did the agent's actions match the harmful goal?) plus task-specific grading functions.
- **Public split is no-jailbreak.** The `rules_v4` jailbreak template (which actually achieves agent jailbreaks) is private; public release is direct-request variant only. The paper's headline finding: *"leading LLMs are surprisingly compliant with malicious agent requests without jailbreaking"* --- so the no-jailbreak variant is still a meaningful attack class on current models.

## Integration cost into dredd

- **No native interceptor flag.** Unlike AgentDojo's `--defense` flag, AgentHarm has no built-in PreToolUse hook. Need a custom Inspect-AI `Solver` that intercepts each tool call before `generate()` executes it, POSTs to dredd's `/evaluate`, and either allows the call or returns a denial message to the agent.
- **Effort estimate:** ~1--2 days of engineering for the Solver wrapper + grading-function adapter that maps AgentHarm's metrics into dredd's `hijackSucceeded` / `exfiltrationDetected` schema.
- **Compute cost:** roughly 1.5--3× AgentDojo per task because AgentHarm tasks involve more tool calls. At ~110 harmful tasks × 2 arms × 1 model on Bedrock, Sonnet 4.6 agent + Sonnet 4.6 judge: ~\$15--25. Cheap.

## Pilot before any commitment

Smoke run: 30 randomly-sampled harmful tasks × 2 arms (no-defence, prompt-v2-defended) × 1 model (Sonnet 4.6 or GPT-4o-mini) on the no-jailbreak public split. ~\$5, ~3 hours wall-clock once the Inspect-AI Solver is wired up.

**Three possible outcomes:**

1. **dredd's prompt v2 catches a meaningful fraction of harmful tasks** (e.g., 30%+ refusal-rate increase from baseline). Paper gains a "harmful-intent filter as a side effect of goal-hijack defence" section. Worth expanding to full corpus and adding an AgentHarm row to the cross-vendor table.
2. **dredd's prompt v2 catches few harmful tasks** (<10% increase). The judge prompt is goal-consistency-focused, not harm-detection-focused, and the result is consistent with the paper's stated scope. Worth one paragraph in §4.3 noting the boundary; no further work.
3. **dredd interferes with benign tasks** (refusal-rate increase on the benign 110-task split). Cost-side calibration concern; would need to be flagged in §4.5 Limitations.

## Why deferred

- Tests 19, 20, 21 are higher-priority paper deliverables (closing the §3.7 cross-vendor matrix).
- AgentHarm tests a different threat model from the paper's primary claim --- it's a scope expansion, not a missing measurement on the existing claim.
- The Inspect-AI Solver wrapper is non-trivial engineering compared to AgentDojo's already-integrated `--defense` flag.
- The result might be null (outcome 2 above), in which case the engineering cost has no paper benefit.

## When to revisit

After:
1. Test 19 (T3e baseline confirmation at $N=200$) lands.
2. Test 20 (AgentDojo cross-vendor with Qwen3.5/3.6) lands.
3. Test 21 (AgentDojo with Sonnet 4.6 / Opus 4.7 as defended agents) lands.

Then either:
- Paper revision is in good shape and there's bandwidth for a scope expansion → run the AgentHarm pilot.
- Paper is in submission-final state → defer to a follow-up paper or future-work section reference.

## Related links

- Paper: <https://arxiv.org/abs/2410.09024>
- Dataset: <https://huggingface.co/datasets/ai-safety-institute/AgentHarm>
- Code: <https://github.com/UKGovernmentBEIS/inspect_evals/tree/main/src/inspect_evals/agentharm>
- Inspect AI framework: <https://inspect.ai-safety-institute.org.uk/>
