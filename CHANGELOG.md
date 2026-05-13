# Changelog

All notable changes to Judge AI Dredd. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are
auto-bumped on every commit by `.githooks/pre-commit`, so the version
number alone doesn't carve commits into releases — sections below
group changes by theme rather than by tag.

## [Unreleased]

### Fixed
- **Hook: 1MB UserPromptSubmit silently truncated by macOS ARG_MAX.**
  On long sessions, `curl -d "$(jq …)"` chopped the body past
  ARG_MAX, the server returned `HTTP 400 "Invalid JSON body"`, and
  the new prompt's intent never registered. Subsequent tool calls
  were judged against the *previous* turn's goal, producing false
  hijack denials. Hook now writes the body to a tempfile and uses
  `curl --data-binary @file`. (v0.1.362)
- **DynamoDB META 400KB ceiling on long sessions.** Each
  `IntentEntry` carried a ~10KB Cohere embedding; ~12 entries blew
  past Dynamo's per-item limit and `/intent` started returning HTTP
  500. Split into per-row `INTENT#<registeredAt>#<id>` items with a
  small `activeIntentIds` pointer list on META. Lazy migration on
  first read shrinks legacy sessions in place. (v0.1.360)
- **Tool Calls table: `Time` column populated.** `ToolCallRecord`
  now carries `timestamp`; the Dynamo loader was dropping it on read.
  (v0.1.362)
- **AgentDojo summary JSON overwritten across cells.** When a
  `none / B7.1 / promptarmor` matrix shared a logdir, the
  `summary-<model>-none-*.json` file was silently overwritten by the
  `promptarmor` cell because both wrote `defense="none"`. Filename
  now incorporates a `cell` label derived from defense + promptarmor
  presence. (v0.1.361)

### Changed
- **Hook ships a `transcript_summary` envelope, not the raw JSONL.**
  ~5–80 KB structured payload (userPrompts, toolCalls, file IO,
  goal anchor) replaces the full transcript. Image bytes only on
  the goal turn. Tool history capped at last 50 calls. Per-string
  fields capped at 4 KB. Server prefers the envelope; falls back to
  `transcript_content` / `transcript_path`. 35× reduction on a
  realistic 2.7 MB transcript. (v0.1.362)
- **DynamoDB schema: per-action sort keys.** Item layout is now
  `META | INTENT# | TURN# | TOOL# | FILE# | ENV# | METRIC# | PIVOT#`.
  No single item carries a list of variable-length records. (v0.1.360)

### Added
- **Tool Calls: click-for-details modal.** Clicking a row opens a
  modal with full input JSON, decision reason, similarity, full
  timestamp, and tool output if recorded. Esc closes modal-first
  before navigating back to the session list. (v0.1.362)
- **Phase-C head-to-head benchmark results 2026-05-12.** Committed
  per-cell summary JSON + log artefacts under
  `benchmarks/{agentdojo,injecagent}/runs/phaseC-20260512/`.
  Headlines:
  - AgentDojo workspace × important_instructions ASR (none / B7.1 / promptarmor):
    qwen3-32b   8.9% / 0.2% / 4.5%
    gpt-4o-mini 17.0% / 0.0% / 9.3%
  - InjecAgent dh+ds × base ASR-valid total (qwen3-235b):
    none 33.7% / B7.1 0.1% / promptarmor 3.1%
  (v0.1.361)

## Earlier

Selected highlights from the pre-changelog history. See `git log`
for the full record.

### Dashboard
- **Clickable stat cards + paginated Tool Calls.** Allowed/Denied
  cards filter the table; Tool Calls clears the filter.
- **Browser back/forward navigates between session views.**
  URL hash + `popstate` route restoration.
- **Trust-mode dropdown on hook landing page.** Per-container
  toggle between interactive / autonomous / learn.
- **Build version + uptime + intent flags on hook landing
  page** and surfaced via `/api/health`.

### Intent stack (history-active model)
- 6-step migration from a single-stack intent model to a
  history+active-set model with revisit/replacement/sub-task
  classification.
- **Async LLM classifier** with embedding-fallback + race handling.
  Classifier override of an embedding-flagged "new-task" to
  "continuation" is the common case; LLM-confirmed tagging avoids a
  full intentHistory rewrite on every /intent.
- **Feature flag + validation harness** (intent-history-active) for
  gated rollout.

### Hook robustness
- **Rehydrate `registeredSessions` Set from store on miss.**
  Container restart no longer loses the "this session is registered"
  flag; falls back to the live active set rather than a stale
  originalIntent.
- **Continuation rehydrate uses persisted originalIntent**, not the
  new prompt, so resumed sessions don't pivot the goal.
- **Trim-stack no longer re-anchors a stale original entry.**
- **UserPromptSubmit substring math** (broke on empty / short
  responses with "substring expression < 0").
- **Default `DREDD_AUTH_MODE=required`** on production hooks.

### Benchmark harness
- **AgentDojo runner**: `gpt-4o-mini`, `qwen3-32b`, `qwen3-235b`
  cells; mapping rolling aliases to dated model ids so AgentDojo's
  `MODEL_NAMES` substring lookup matches.
- **InjecAgent runner**: Qwen3-235B (A22B 2507) added.
- **PromptArmor head-to-head**: external content-side defence cell
  alongside `defense=none|B7|B7.1`. Dredd hook key reused so the
  same auth gate applies.

### Storage
- **DynamoDB-backed `SessionStore`** wrapped in a write-through LRU
  cache, with sticky-cookie ALB pinning so the cache stays hot.
  Cold-start path reconstructs full state via a paginated Query.

[Unreleased]: https://github.com/cloudygeek/JudgeAIDredd/compare/main...HEAD
