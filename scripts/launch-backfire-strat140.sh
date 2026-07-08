#!/usr/bin/env bash
# launch-backfire-strat140.sh — stratified-140 AgentLAB replication of the
# defence-as-injection-vector "backfire" (p15a/defence).
#
# Implements docs/test-request-backfire-stratified100-2026-07-06.md.
# Higher-N (28 reps/class → ≥20 SCORED/class at the observed ~84% yield)
# replication of the featured Sonnet-4.6 "+20 pp intent-tracker backfire" that
# the strat-50 pre-check (results/backfire-precheck-2026-07-06/FINDINGS.md)
# showed is a truncation SCORING ARTIFACT (corrected Δ=+0.0 pp, attempt-rate
# flat). Both agents run so the "agent-dependent sign" claim is testable:
#   Sonnet 4.6  — corrected Δ≈0 expected (the backfire fails the confirm rule)
#   Opus 4.8    — corrected suppression ≈ −11 pp expected (genuine)
#
# Requires the test-framework image at >= 0.1.749 on every target — the build
# that carries the per-rollout split-file fix (agentlab__…--rep<n>.json), WITHOUT
# which strat-140's duplicate rollouts overwrite on disk and the rescore under-
# counts N. Old containers SKIP via the ver_ge guard — redeploy them first.
#
# The agentlab entrypoint uses BACKEND=auto: Sonnet→SDK, Opus-4.8→Converse
# (Bedrock rejects thinking.type=enabled for opus on the SDK path). Do NOT pass
# AGENT_BACKEND. Corpus = built-in scenarios (10/class × 5 envs); no /opt/agentlab.
#
# Arms: none (baseline) + intent-tracker (component under test). promptarmor is
# added as a near-baseline context arm (cheap; §2 of the request).
#
# One (agent × arm) cell per container → 6 containers, all parallel.
#
# Usage: ./launch-backfire-strat140.sh [--dry]
set -uo pipefail

KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MINVER="0.1.749"
SCEN="${SCEN:-stratified-140}"        # perType=28
SEED="${SEED:-27}"                    # same seed as strat-50 (§2 hold-config-fixed)
MAXTURNS="${MAXTURNS:-8}"             # strat-50 used 8
ATTACK_TYPES="intent_hijacking,tool_chaining,task_injection,objective_drifting,memory_poisoning"
DRY="${1:-}"

# cell: bedt:model:defence
# Sonnet + Opus, each × {none, intent-tracker, promptarmor}. eu-central-1 for
# both (eu. judge/embed prefix). One arm per box keeps the run serial-in-box.
CELLS=(
  # Sonnet 4.6 — the featured (corrected Δ=+0.0) confirmatory target
  "3:claude-sonnet-4-6:none"
  "4:claude-sonnet-4-6:intent-tracker"
  "5:claude-sonnet-4-6:promptarmor"
  # Opus 4.8 — the mirror (genuine suppression)
  "6:claude-opus-4-8:none"
  "8:claude-opus-4-8:intent-tracker"
  "7:claude-opus-4-8:promptarmor"
)

ver_ge() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }

launched=0; skipped=0
for cell in "${CELLS[@]}"; do
  IFS=: read n model defence <<< "$cell"
  read v st < <(curl -sk -m5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ -z "${v:-}" ]]; then echo "SKIP bedt$n ($model/$defence): unreachable"; ((skipped++)); continue; fi
  if ! ver_ge "$MINVER" "$v"; then echo "SKIP bedt$n ($model/$defence): v$v < $MINVER — redeploy $MINVER first"; ((skipped++)); continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model/$defence): busy"; ((skipped++)); continue; fi

  rid_model="${model//[.:\/]/-}"
  RUNID="p15a-backfire-strat140-${rid_model}-${defence}-b${n}-sonnetjudge-v${MINVER}-eu-central-1"

  # promptarmor needs the DREDD_URL+key (its /screen path); none/intent-tracker
  # only use DREDD_URL for the soft /health probe.
  ENV="\"RUN_ID\":\"$RUNID\",\"AGENT_MODELS\":\"$model\",\"DEFENCES\":\"$defence\",
    \"ATTACK_TYPES\":\"$ATTACK_TYPES\",\"SCENARIO_MODE\":\"$SCEN\",
    \"RANDOM_SEED\":\"$SEED\",\"MAX_TURNS\":\"$MAXTURNS\",
    \"AWS_REGION\":\"eu-central-1\",\"CLAUDE_CODE_USE_BEDROCK\":\"1\",
    \"DREDD_URL\":\"$DREDD_URL\",\"DREDD_API_KEY\":\"$KEY\""

  if [[ "$DRY" == "--dry" ]]; then
    echo "WOULD launch bedt$n  $model/$defence  scen=$SCEN seed=$SEED maxturns=$MAXTURNS  -> $RUNID"
    ((launched++)); continue
  fi

  curl -sk -m30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" \
    -H "Content-Type: application/json" -d "{\"test\":\"agentlab\",\"runId\":\"$RUNID\",\"env\":{$ENV}}"
  echo " <- bedt$n $model/$defence scen=$SCEN"
  ((launched++))
done

echo
echo "launched=$launched skipped=$skipped (of ${#CELLS[@]} cells)"
echo "Results: S3 s3://cko-results/agentlab/<RUN_ID>/  (prefix p15a-backfire-strat140-*)"
echo "VERIFY realised per-class SCORED-N >=20 in each cell before trusting the delta (§2/§5)."
echo "Rescore: python3 scripts/backfire-precheck.py  (freeze the corrected endpoint per §3)."
