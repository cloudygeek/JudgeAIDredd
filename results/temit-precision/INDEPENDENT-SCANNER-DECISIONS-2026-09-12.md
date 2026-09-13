# Independent-scanner check: rule-family decisions and provenance, 2026-09-12

Two off-the-shelf static analysers were run over the same authored-code corpus as a third
rater, after the round-2 objection that the T-EMIT correction rests on our own detector,
our own classifier and our own labels.

## Apparatus
- Semgrep CE 1.177.0; community rules pinned at `semgrep/semgrep-rules` commit `40b8c63`
  (2026-07-29), configs `javascript/` and `typescript/`, plus registry packs `p/eslint`
  and `p/nodejs` fetched 2026-09-12. Exact invocation:
  `semgrep scan --metrics=off --quiet --no-git-ignore --config semgrep-rules/javascript
   --config semgrep-rules/typescript --config p/eslint --config p/nodejs --json -o <out> <dir>`
- CodeQL CLI 2.27.0, suite `javascript-security-extended.qls`, library pack
  `codeql-javascript-all` 2.10.1, one database over the reconstructed final files,
  `--format=sarif-latest`.
- Corpus reconstruction: `reconstruct_blobs.py` (staged in the archive) rebuilds both
  units, the authored fragments the detector scores and the replayed final files.

## The rule-family choice, stated honestly
Counted rules were specified **by rule name against the three sink classes the T-EMIT
detector tags** (code execution of untrusted input, SSRF, exfiltration), before the corpus
results were computed. The rules' CWE annotations corroborate that grouping but did not
determine it: detect-eval-with-expression / eval-detected / code-string-concat /
detect-non-literal-require are CWE-95, unsafe-dynamic-method is CWE-94, detect-child-process
is **CWE-78** (so "the CWE-94/95 rules" is not an accurate description of the set).
`detect-object-injection` is excluded on observed behaviour, not on its CWE (its rule file
is in a registry pack, not the pinned checkout): it fires on any computed-key property
access, 361 findings, on safe evaluators as much as unsafe ones.

**The single largest researcher degree of freedom is whether the dynamic-dispatch rule is
counted.** Semgrep's `unsafe-dynamic-method` and CodeQL's `js/unvalidated-dynamic-method-call`
are analogues; the first analysis counted one and not the other, which is not defensible
unstated. Both conventions are now reported for both tools, with the WIDE family (dynamic
dispatch counted) as primary because it is least favourable to our own labels.

| variant | eval-tagged kappa (Semgrep / CodeQL) | detector-vs-scanner kappa |
|---|---|---|
| wide (primary) | 0.668 / 0.731 | 0.099 / 0.094 |
| narrow | 0.965 / 0.976 | 0.102 / 0.104 |
| + detect-object-injection (Semgrep) | -0.011 | n/a |

**What this means.** Agreement with the labels is convention-dependent, from substantial to
almost perfect. Disagreement with the RAW detector is not: kappa 0.09-0.10 in every variant,
140-164 blobs flagged by the detector alone against at most 4 the other way. The
over-counting claim therefore does not rest on the rule-family choice. Scanner-versus-scanner
agreement is kappa 0.951.

## Limits
Both tools are blind to the hardcoded-exfiltration idiom (verified by an eight-idiom
sensitivity control run before the corpus scan), so the `hardcoded-exfil-url` cells rest on
the labels alone. CodeQL's *clean* verdicts are weak evidence: B-256 (`vm.runInNewContext`
behind a literal-regex allow-list) is clean while B-276 (`new Function` behind a comparable
guard) is flagged, so its barrier recognition is inconsistent across near-identical code.
Neither tool is ground truth.

## Contamination check
The earlier scan was verified to contain **no non-authored JavaScript**: the authored-only
rebuild yields the identical 395 `.js` files, so the agreement figures are unaffected. The
25 read-only code files dropped in that rebuild are all non-JavaScript.
