# TODO — Opus 4.7 Token Accounting

**Owner:** unassigned
**Blocks:** C2 token-vs-catch Pareto (Opus 4.7 rows), C3 paper cost table (Opus 4.7 rows), §7.4 paper revision
**Reference:** `docs/test-plan-2026-04-18-opus-effort.md` §9

## Current state

Opus 4.7 reports implausibly low output-token counts across the full adversarial A1 dataset (N=20 reps × 12 cases × 4 efforts + xhigh + hardened):

| Effort | μ input | μ output | μ total |
|---|---|---|---|
| none | 838 | 97 | 935 |
| medium | 838 | 75 | 913 |
| high | 838 | 91 | 930 |
| xhigh | 838 | 129 | 967 |
| max | 838 | 516 | 1,354 |
| none (B7 hardened) | 1,869 | 86 | 1,954 |

The 75–129 output-token range is barely enough for the JSON verdict; Sonnet 4.6 at comparable effort reports 381–407 output tokens for the same task, clearly including reasoning content. Opus 4.7's thinking is either (a) in a separate usage field the current plumbing doesn't read, or (b) not exposed through Bedrock's Converse `usage` block at all.

Until resolved, every Opus 4.7 cost and Pareto claim understates actual compute.

## Local probe status (2026-04-19)

Attempted §9 Step 1 from local dev identity. Results:

- **Opus 4.7 Bedrock call failed:** `AccessDeniedException: Your subscription to the model could not be established`. Local IAM user is not subscribed to Opus 4.7 in the Bedrock marketplace. Haiku 4.5 works on the same credentials, so this is Opus-specific.
- **Sonnet 4.6 probe succeeded:** adversarial-style prompt with `thinking.type=enabled, budget_tokens=5000` returned `outputTokens=647` for a ~50-token final JSON. Confirms Sonnet thinking tokens ARE in `outputTokens`.
- **AWS CLI v2.22.3 limitation:** the reasoningContent block appears as `SDK_UNKNOWN_MEMBER { name: "reasoningContent" }` with no inner fields. The token count still includes reasoning, but the text content is hidden. Likely fixed in newer CLI.

## Plan

### Step 1 — unblock the probe

One of:

- **1a. Run from an identity with Opus 4.7 marketplace subscription.** Fargate task role already has this (the A1 bulk run succeeded from there). Either:
  - SSH into a running Fargate container and exec the probe, or
  - Assume the Fargate role locally via `aws sts assume-role`.
- **1b. Subscribe the local IAM user to Opus 4.7** via the Bedrock Marketplace console. Persistent; enables further local testing.

Once unblocked, run §9 Step 1:
```bash
aws bedrock-runtime converse --region eu-west-2 \
  --model-id 'eu.anthropic.claude-opus-4-7' \
  --messages '[{"role":"user","content":[{"text":"Count to 5 and explain your reasoning step by step."}]}]' \
  --inference-config '{"maxTokens":2000}' \
  --additional-model-request-fields '{"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}' \
  --output json > /tmp/opus-raw.json

jq '{ usage, additionalModelResponseFields, content: (.output.message.content | map({keys: keys})) }' /tmp/opus-raw.json
```

### Step 2 — upgrade AWS tooling

Before the probe is informative, tooling must render the new content-block type:

```bash
# AWS CLI — needs v2.30+ to properly serialise reasoningContent from Converse
brew upgrade awscli   # or platform equivalent
aws --version

# If using Python SDK path (test-bedrock.ts doesn't, but scripts/ might)
pip3 install --user --upgrade boto3 botocore
```

Verify upgrade: rerun the Sonnet probe from §9 Step 1's doc and confirm the content block shows `reasoningContent` with a readable `text` field instead of `SDK_UNKNOWN_MEMBER`.

### Step 3 — interpret the Opus 4.7 `usage` block

Depending on what Step 1 returns, branch by §9.2 hypothesis:

| Outcome | Hypothesis | Action |
|---|---|---|
| `usage` has `thinkingTokens`/`reasoningTokens`/`cacheCreationInputTokens` with non-zero value at `effort=high` | H1 | Extend `bedrock-client.ts` to surface the field; plumb through `JudgeVerdict`; re-run one A1 cell to validate; retroactively annotate prior Opus 4.7 runs if the field turns out to be deterministic given `effort` |
| `additionalModelResponseFields` contains a token breakdown | H1 variant | Same plumbing path via `additionalModelResponseFields` parsing |
| `usage` is identical to current shape, `reasoningContent.text` is long (many tokens of visible reasoning not reflected in `outputTokens`) | H2 / H4 | Bedrock under-reports. Fall back to **character-based estimate** from `reasoningContent.text`: `estimatedThinkingTokens = ceil(text.length / 4)`. Add to `bedrock-client.ts`; document in §7.4 that Opus 4.7 thinking cost is estimated not measured |
| `reasoningContent.text` is empty/short AND `outputTokens` is low | H3 | Opus 4.7 adaptive-thinking genuinely uses fewer visible tokens per call. The current numbers are correct; document in §7.4 that Opus 4.7 is genuinely cheaper per call than Sonnet at comparable effort — which inverts the paper's cost narrative |

### Step 4 — propagate through deliverables

- **`src/bedrock-client.ts`**: add whichever token field Step 3 identifies. Keep existing plumbing additive — no breaking changes.
- **`src/intent-judge.ts`**: extend `JudgeVerdict` with the new field if one was found.
- **`scripts/token-pareto.py`**: use the corrected Opus 4.7 token column. Re-run; regenerate the three plots in `docs/`.
- **`p15.tex` §7.4**: rewrite the Opus 4.7 cost claim. Include the hypothesis that ended up correct so the paper is honest about what's measured vs estimated.
- **`docs/test-plan-2026-04-18-opus-effort.md`**: mark §9 resolved.

## Validation after fix

Once the new bedrock-client.ts is deployed, smoke-test with a single `--cases adv-5 --repetitions 4` Opus 4.7 run at each effort level and confirm the token field now scales with effort (or that the alternative path — reasoningContent length estimate, or documented "no measurement available" — is populated).

## Cost estimate

- Step 1 (unblock probe): depends on path.
  - 1a (assume Fargate role): ~30 min.
  - 1b (subscribe local user): ~15 min Marketplace click-through, may need billing approval.
- Step 2 (tooling upgrade): ~15 min.
- Step 3 (code change): ~30 min for H1, ~1 h for H2 estimate path, ~0 for H3 (documentation only).
- Step 4 (plumbing + doc + plot regen): ~1 h.

**Total:** ~2–3 h once the probe is unblocked.

## Why this matters

Currently the paper cannot honestly report Opus 4.7 cost per case. The three claims that depend on this:

1. Pareto dominance (`tab:judge-cost` + C2 plot) — Opus 4.7 rows are unreliable.
2. "Effort increases cost" (§7.4) — Opus 4.7 is the only model where the observed cost doesn't scale with effort, which is either interesting (H3) or an artefact (H1/H2/H4).
3. Deployment recommendation — if Opus 4.7 adaptive-thinking is actually cheap per call (H3), the "Sonnet 4.6 Pareto-dominates Opus 4.7" conclusion from the A1 data may need qualification.

All three can be settled by the ~2–3 h of work above.
