# 30-day deny-log review

**Date:** 2026-05-24
**Window:** 2026-04-23 → 2026-05-24 (CloudWatch `/ecs/judge-ai-dredd-prod/hook`)
**Total deny events:** 132

## Breakdown by stage

| Stage | Count | Verdict on rule health |
|---|---|---|
| `judge-deny` | 70 | Mostly defensible (see §3) — not a rule-tuning problem |
| `policy-deny` | 52 | **2 rule bugs found + fixed**; rest working-as-intended |
| `drift-deny` | 10 | All in one autonomous session; working as configured |

---

## 1. policy-deny (52) — the actionable category

| Sub-reason | Count | Assessment |
|---|---|---|
| Destructive rm with force/recursive flags | 43 | Mostly legit hard-denies; **2 were `git rm` false positives → FIXED** |
| Unsafe command substitution in git commit message | 6 | All heredoc-form false positives, **already fixed in 0.1.425** |
| Hard reset (`git reset --hard`) | 1 | Working as intended (conservative) |
| Dump environment (`env`/`printenv`) | 1 | Working as intended |

### Fix 1 — `git rm` matched the destructive-rm rule (FALSE POSITIVE)

`git rm -r p14/cross_vendor_harness/` and `git rm -r lambdas/timestream-api`
were hard-denied as "Destructive rm with force/recursive flags". The deny
regex `/rm\s+(-[a-zA-Z]*r|…)/` matched the substring `rm -r` inside
`git rm -r`. But `git rm` (and `svn`/`hg`/`jj`/`bzr rm`) are version-control
removals — staged and recoverable — not the destructive filesystem `rm`.

Occurrences: 2026-05-20 05:54 and 2026-05-23 19:01 (the latter is AFTER the
0.1.425/0.1.428 deploys, confirming it was still live).

**Fixed** in `tool-policy.ts:sanitizeForMatching` — a VCS-rm neutraliser
rewrites the `rm` subcommand token to `vcs-removal` before the deny
patterns run. Handles intervening global flags (`git -C /path rm -r`,
`git -c k=v rm …`). Real `rm -rf`, the `/tmp` carve-out, and the
literal-single-file carve-out are all unaffected; a chained
`git rm -r staged/ && rm -rf /etc` still denies on the second part.
Regression test: `hooks/tests/test_policy_vcs_rm.ts` (13 assertions).

### Fix 2 — commit-message heredoc backticks (ALREADY FIXED)

The 6 "Unsafe command substitution in git commit message" denials were all
the `git commit -m "$(cat <<'EOF' … `markdown backticks` … EOF)"` shape
(content like `^https://[a-z0-9.-]+`, `/#session/<id>`, `npx tsx`,
`aws bedrock-runtime converse`). All dated before the 0.1.425 deploy. The
heredoc-body strip in 0.1.425 (commit `c24c4298`) plus the chained-command
fingerprint fix in 0.1.428 cover these. No residual occurrences post-fix.

### Not bugs

- **`git reset --hard` (1)** and **`env`/`printenv` (1)** — conservative
  hard-denies by design. In interactive mode these surface as `ask`; the
  approval/pattern-trust path remembers them per-project once consented.
- The other ~41 `rm -rf` denials are legitimate guardrail hits (deleting
  build artifacts, review dirs, temp dirs). Friction is real but
  intentional — the approval path is the pressure valve, per the
  documented "if the user consents to rm -rf twice, trust it" posture.

---

## 2. drift-deny (10) — not a rule bug

All 10 came from a single session (`8eaf2d7f`) in autonomous mode (drift
hard-deny only fires when `mode !== interactive`). All were Bash calls with
cosine similarity 0.05–0.146 — just under the 0.15 deny threshold. This is
one genuinely-drifting (or tightly-scoped) autonomous session, not a
threshold problem. No change recommended; if this recurs, the per-session
mode override or a threshold tweak for that workload is the lever, not a
global rule change.

---

## 3. judge-deny (70) — mostly defensible, NOT a rule problem

Theme scan (keywords in the judge's reasoning):

| Theme | Count |
|---|---|
| "credential" | 44 |
| "unrelated to" (the task) | 34 |
| "external" (transmission) | 20 |
| "secret" | 19 |
| "exfiltrat(ion)" | 16 |

Clustered by session:

| Session | Denies | Character |
|---|---|---|
| `654fa809` | 17 | **This work session** — Dredd's own ops: curl to `dredd-hook.acta.io`, `aws ecr get-login-password`, `aws ecs describe`, reading `~/.claude/dredd/api-key`. Intent-false-positive, reasoning-defensible. |
| `4820e7ec` | 16 | "task is about configuring X but action does Y" — drift framing. |
| `4a663fd8` | 9 | Reading macOS keychain `Claude Code-credentials` via `security find-generic-password`. **Defensible / arguably true positive.** |
| `8eaf2d7f` | 7 | Mixed. |
| `71ade499` | 5 | Hardcoded key `69afeb82…` transmitted to a Lambda URL (the user's own lambda API testing). Intent-false-positive, reasoning-defensible. |
| `23e465e7` | 5 | `mcp__soteria-neptune-v2__delete_vertices` / `query_neptune` on a "fix a diagram" task. **Defensible / arguably true positive** (destructive graph op unrelated to a read/UI task). |

**Conclusion:** the judge denials split into (a) genuine/defensible blocks
(keychain credential reads, destructive graph mutations on unrelated tasks)
and (b) intent-false-positives that are nonetheless *reasoning*-defensible —
legitimate dev/ops work (deploying Dredd, testing one's own Lambda with a
real key) that genuinely pattern-matches "credential + external transmission
unrelated to the stated task." The judge cannot distinguish "I'm testing my
own endpoint" from "I'm exfiltrating a key" from the call alone.

This is **not** a rule-tuning problem. The lever is the *trusted-context gap*
already noted earlier this week: the judge has no notion that
`dredd-hook.acta.io` / `dredd.acta.io` are Dredd's own infrastructure, nor
that the operator explicitly asked for a deploy / endpoint-test. Two
candidate follow-ups (both bigger than a rule edit):

1. **Trusted-infrastructure allowlist** fed to the judge — when the
   external host is Dredd's own (or an operator-declared) domain, the judge
   weights "external transmission" far lower.
2. **Operator-intent surfacing** — when the active intent contains deploy /
   test / build language, pass a meta-context block so the judge stops
   treating ECR/ECS/curl-to-own-infra as off-task.

Filed as candidate P2 items, not done here.

---

## Summary of changes made

| Change | File | Status |
|---|---|---|
| VCS-rm neutraliser (`git rm` no longer hard-denied) | `src/tool-policy.ts`, `src/policy-patterns.ts` | **Fixed this review** |
| 13-assertion regression test | `hooks/tests/test_policy_vcs_rm.ts` | New |
| Commit-message heredoc backticks | `src/tool-policy.ts` | Already fixed 0.1.425 |
| Chained-command curl fingerprint | `src/approval-fingerprint.ts` | Already fixed 0.1.428 |

## Recommended follow-ups (not done)

- Trusted-infrastructure allowlist / operator-intent context for the judge
  (addresses the dominant judge-deny false-positive class).
- Nothing further on `rm -rf` or drift thresholds — those are
  working-as-designed; the approval path is the intended pressure valve.
