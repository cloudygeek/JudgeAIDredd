# Experiment request — validate the PromptArmor reimplementation vs the original artifact (p15a/defence)

**Date:** 2026-07-24
**Requested by:** JCP peer review of the defence paper (`Cloud-Security/Adrian/p15b/PEER_REVIEW_p15b-defence_2026-07-24_fable_v3.md`, Major comment 3).
**Paper:** `Adrian/p15b/mdpi-jcp/p15b-jcp.tex` (JCP submission build) + `p15b-defence.tex`.
**Priority:** MEDIUM–HIGH — gates the "Competitive Evaluation" claim in the title/abstract/contribution 3. This is the one review item that needs a **run**, not a text edit.
**Type:** EXPERIMENT (needs the original PromptArmor artifact + the d2 harness). If the original artifact is not obtainable, this converts to a text-only mitigation (see §4).

---

## The problem (reviewer M3)

The paper's PromptArmor arm is **our reimplementation** — a Bedrock-Sonnet 4.6 detector plus a token-walk "strip" stage. Every PromptArmor *failure* the paper reports is attributed to the **strip stage** (quote-alignment sanitisation failures): per-suite AgentDojo residuals **8–35%**, **59–100% strip-failure on AgentLAB**, 6.7× wall-clock. The strip is exactly the component most sensitive to reimplementation choices.

The paper correctly concedes it does **not** refute the original's `<1%` *detector* FNR — but it never validates the reimplementation **end-to-end** against the original artifact's published operating points. A 59–100% strip-failure rate is at least as consistent with a reimplementation artifact as with a real PromptArmor property. The competitive claim ("PromptArmor leaves per-suite residuals up to 35%") is therefore load-bearing and unvalidated.

## What we need

**1. Obtain the original PromptArmor artifact.** From Shi et al. (`shi2026promptarmor`) — locate the released code/prompts (repo, appendix, or on request). Record availability; if none exists, jump to §4.

**2. Reproduce one shared operating point end-to-end.** Run the **original** pipeline (their detector + their strip, their prompts) on **at least one cell we already report** — the cleanest is **AgentDojo `important_instructions`** on a **shared agent** (e.g., GPT-4o-mini or Qwen3-32B), which the original paper reports on. Report the original artifact's end-to-end residual ASR on that cell.

**3. Compare to our reimplementation.** Put side by side, on the *same* cell:
   - original artifact end-to-end residual ASR,
   - our reimplementation's residual ASR (from the existing runs),
   - the detector-only detection rate for each.
   State whether the reimplementation's strip-failure behaviour reproduces in the original, or is a reimplementation artifact.

**4. If the original artifact is unavailable / not runnable in-harness:** say so explicitly, and this becomes a **text-only** mitigation in the paper (no run): label every PromptArmor figure "reimplementation" in captions + headline text, soften "PromptArmor leaves per-suite residuals up to 35%" → "our PromptArmor reimplementation leaves…", and release the reimplementation code alongside Dredd. (The paper edit is ready to apply on your word.)

## What to return

A short `results/p15a-promptarmor-revalidation-2026-07-24/RESULTS.md`:
- original-artifact availability (yes/no + link),
- the one shared-cell comparison table (original vs reimplementation end-to-end residual + detector rate),
- a one-line verdict: does the reimplementation's strip-failure profile hold up, or must the competitive figures be relabelled "reimplementation"?

No new corpora needed — one shared AgentDojo cell is enough to settle fidelity. If the run is infeasible, return the availability finding so we take the text-only path.
