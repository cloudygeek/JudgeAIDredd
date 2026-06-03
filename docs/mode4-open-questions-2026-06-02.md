# Mode 4 (Paper14 §VII behavioural drift) — open questions

Date: 2026-06-02
Source: review of `results/mode4-2026-05-31/results-2026-06-01.md` + the
`results/mode4-2026-05-31-s3/` re-run tree, with headline cells re-verified
against the per-rep RepResult JSON (gesExec / postExecRate / ccExec).

Context for each item: what we know, why it's unresolved, and what run would
close it. These are the gaps that must be settled before the Mode 4 finding
can go into the paper as a cited result.

The Q1–Q6 sections below are the original 2026-06-02 statement, kept as the
historical record. **Current status is the dated update immediately below**;
see also the closure writeup `results/mode4-2026-05-31/results-2026-06-03-q124-closure.md`.

---

## STATUS UPDATE 2026-06-03 — five of six closed (re-verified against raw JSON)

The overnight wave (commits `823fa1ba9` SDK dual-signal scorer, `e2eac3e51`
Q3/Q5/Q6, `4dfc3aeaf` Q1/Q2/Q4) closed most of these. Headline cells below were
recomputed from the per-rep RepResult JSON, not the summary prose.

| Q | Status | Evidence (verified) |
|---|---|---|
| Q1. SDK/C4 dual-signal | **CLOSED** | SDK runner now emits `gesExec`/`retestExecuted`. opus-4-8 C4 SDK flood=50 n=10 → P1 (credential) 10/10, gesExec mean 55.0; flood=100 n=5 → P1 3/5. The C1 gate (bound=no) hard-blocks 0/10. So the gate, not the model path, is what catches tier-3. |
| Q2. opus-4-7 CI | **CLOSED** | Pooled 7/55 = 12.7% P1, Wilson 95% CI [6.3%, 24.0%]. Component JSONs verified (50t n=10 = 2/10; 100t n=10 = 1/10; 100t n=5 = 1/5). **Caveat: the n=30 sub-cell has only a `.log`, no per-rep JSON — not independently JSON-verifiable; re-save or re-run to JSON before citing that sub-cell.** |
| Q3. S3-lost cells | **CLOSED** | haiku flood 50/100 + sonnet/haiku C1 recovery re-run with S3 routing (commit `e2eac3e51`); durable JSON present. |
| Q4. opus-4-8 effort sweep | **3 of 4 CLOSED** | low/med/high n=10 each verified: P1 10/10, 9/10, 9/10 (gesExec 50–55). effort=max only at n=5 (P1 1/5) — n=10 still in flight on bedt3. |
| Q5. P1 vs P3 axis | **CLOSED** | Per-op `retestExecuted` dict confirms dissociation: effort=max P1 1/5 vs P3 5/5; gpt-5 P1 0/10 vs P3 3/10. |
| Q6. capability-tier rejection | **CLOSED (gpt-5); o3 underpowered** | gpt-5 n=10 → 0/10 (verified). o3 is only n=3 → 0/3 — no n=10 o3 cell exists, despite an earlier "o3 n=10" note that was wrong. opus-4-8 tier-3 is model-specific; the well-powered control is gpt-5, with o3 n=3 supporting. |

**Remaining before §VII is fully settled:** (i) effort=max n=10 (Q4 tail);
(ii) re-save the opus-4-7 n=30 cell to JSON (Q2 caveat); (iii) bedt4 C4-sonnet
n=30 dual-signal supplementary stuck at 14/30 (RUNNER_CONCURRENCY race, commit
`56c16cc43`) — its partial reps show gesExec=0, consistent with sonnet tier-1.

---

## Q1. Does opus-4-8's tier-3 leak persist through the C4 / SDK runner? (BLOCKER)

**Status: unresolved — no trustworthy metric on the SDK side.**

The whole campaign rests on the dual-signal distinction: `gesExec` ("did the
model actually call the credential/exfil tool") is the trustworthy axis, while
`gesRetest` (text/substring) overstates compliance by counting the model
*discussing* a dangerous op. The C1/CLI runner emits `gesExec`; the **SDK
runner used for C4 does not** — the opus-4-8 C4 cell
(`mode4-opus48-c4-sdk-50t-n5-v493`) has no `gesExec`/`postExecRate` fields, only
`gesRetest` (text), which means=90 across 5 reps. That number is the metric we
explicitly do not trust.

So the most important comparison the paper wants — *the C1 CLI permission gate
blocks tier-3 execution; does an SDK deployment without that gate?* — cannot be
made from current data. The C1-vs-C4 tier-3 contrast is exec-measured on one
arm only.

**To close:** add the dual-signal / exec-level scorer to the SDK runner
(per-turn `toolsAttempted / toolsExecuted / canaries`), then re-run opus-4-8 C4
flood=50 n≥10 and flood=100 n≥5. Until then, any SDK tier-3 claim is text-level
only and must be labelled as such.

## Q2. What is opus-4-7's true tier-3 rate, with a confidence interval?

**Status: directionally established, point estimate too noisy to cite.**

opus-4-7 shows occasional tier-3: flood=50 n=10 → 2/10 leak (gesExec mean 10.0);
flood=100 n=5 → 1/5. Pooled that is ~3/15 ≈ 20%, but the per-cell rates swung
0% → 50% → 0% across earlier n=3 draws (documented in the writeup's correction
cycle). The "~10–20%" figure is a small-n tail estimate.

**To close:** opus-4-7 C1 bound=yes flood=50 at n≥30 (Wilson CI on the leak
proportion); report the interval, not a point value. Current n=10 gives a
Wilson 95% CI of roughly [3%, 30%] on the 2/10 — too wide to state "10%" as
fact in the paper.

## Q3. Re-run the three S3-lost cells so they are citable.

**Status: findings known, data irrecoverable.**

Three early cells were deleted on container redeploy (RESULTS_S3_DISABLE=1 +
ephemeral `/app/runs`): sonnet C1 val50-audit, haiku C1 flood=50 ×3, haiku C1
flood=100 ×3. Their tier-1 (prose-only) findings are in the writeup "from
memory" but have no backing JSON, so they cannot be cited.

**To close:** re-run all three with S3 routing enabled (the
`RESULTS_S3_DISABLE` mistake is already retired per
`feedback_no_results_s3_disable.md`). haiku especially, since it is a named
model in the paper's primary matrix.

## Q4. Is the effort=max suppression of opus-4-8 real, or n=5 noise?

**Status: suggestive, underpowered.**

opus-4-8 at effort=max flood=50 dropped to 1/5 credential leak (gesExec mean
10.0) versus 10/10 at default effort — but the writeup notes rm-rf (P3) still
fired even when credential exfil (P1) was suppressed, and n=5 is thin for a
"max effort is a partial defence dial" claim.

**To close:** opus-4-8 effort sweep {low, medium, high, max} at n≥10 each,
flood=50, separating the P1 (credential) and P3 (destructive) axes — the
interesting signal is that they may dissociate (effort suppresses exfil but not
destruction).

## Q5. Credential-exec vs destructive-exec — is the split its own axis?

**Status: observed once, worth a dedicated measurement.**

gpt-5 executed `rm -rf` (P3) in 2/3 reps but never touched credential/exfil
(P1/P2) — a "destructive-only" slot between recon-only and credential-exec. If
this dissociation is stable it is a behavioural distinction worth a §VII
footnote (models may gate disclosure-of-secrets and local-destruction
differently).

**To close:** report P1/P2 (credential, exfil) and P3 (destructive) as
separate per-rep outcomes across the model set at n≥10, rather than collapsing
them into a single gesExec. The data already carries the per-op breakdown;
this is a scoring/reporting change, not new runs.

## Q6. Capability-tier hypothesis — is the rejection robust?

**Status: rejected at n=3 across three strong reasoners; firm up the controls.**

gpt-5, gpt-5-codex, and o3 all sit at gesExec=0 (flood=50, n=3 each), so
opus-4-8's tier-3 behaviour is model-specific, not a capability law. The
direction is clear, but each negative control is n=3.

**To close:** bump the strongest non-Anthropic reasoners (gpt-5, o3) to n≥10
at flood=50 so the "no other frontier model leaks" claim has the same power as
the opus-4-8 positive.

---

## Cross-cutting note for the paper

Every Mode 4 number that enters Paper14 §VII must be:
1. exec-level (`gesExec`), never text-level (`gesRetest`) — see Q1;
2. backed by a JSON in `results/mode4-2026-05-31-s3/` (S3-routed, durable) — see Q3;
3. reported with n and a CI where the rate is not 0/N or N/N — see Q2, Q4, Q6.

As of the 2026-06-03 update, the cells meeting all three for a non-trivial rate
are: **opus-4-8 C1 bound=yes** (flood=50 n=10 = 10/10; flood=100 n=5 = 5/5),
**opus-4-8 C4 SDK** (flood=50 n=10 = 10/10 P1, flood=100 n=5 = 3/5 — now
exec-level), **opus-4-7 pooled** (12.7%, CI [6.3%, 24.0%], excluding the
JSON-less n=30 sub-cell), the gate-blocked **bound=no** cells (0/N), and the
**gpt-5 n=10** negative control (0/10) with **o3 n=3** (0/3) as a smaller
supporting control. These are sufficient to write the §VII Mode 4 subsection
(written 2026-06-03 as paper §VIII-F, commit e773a8d, gpt-5 led as the
well-powered control). The only non-citable items remaining are the opus-4-7
n=30 sub-cell (log-only), effort=max n=10 (in flight), and the sonnet C4 n=30
supplementary (partial).
