# P20 P0-h — deepseek temperature sweep (2nd-vendor confirmation)

**Run:** `p20-tempsweep-deepseek-v3.2-us-west-2-v0.1.717-20260619T2128Z` (bedt14).
**Config:** deepseek-v3.2, persona-neutral, **thinking OFF**, `--judge-temperature 0,0.5,1`, adv deck (12 hijacks), N=20 → 3 cells (one per T). 0 fail-soft.

Closes the wave-1 doc §P0-h gap: the temperature sweep was run on gpt-oss (P0-g) but the doc asked for a **second open-weight vendor** to show the temp→instability effect isn't model-specific.

## Result — recall vs temperature (thinking off)

| T | deepseek recall | gpt-oss recall (P0-g, ref) |
|---|---|---|
| 0 | 0.0% (0/240) | 0.8% |
| 0.5 | 0.8% (2/240) | 0.8% |
| 1 | 4.2% (10/240) | 2.1% |

## Finding

**The temperature effect replicates on a second vendor.** deepseek shows the same monotone "higher T → more catches" pattern as gpt-oss — at thinking-off, raising temperature slightly lifts recall (more output variance occasionally lands on `hijacked`). The effect is small because deepseek is near the 0%-recall floor on this deck (consistent with its wave-1 cross-vendor result, 0.4%), but the direction matches and the clean **T=0** point now exists for two open-weight vendors.

This supports the wave-1 census reconstruction that sampling temperature dominates verdict instability — and shows it's a general property of the sampling, not an artifact of one model. Pairs with P0-g (gpt-oss) as the controlled temp-vs-reasoning separation the original repetition corpus couldn't reach (it only hit T=0.1 and couldn't decouple temp from thinking).
