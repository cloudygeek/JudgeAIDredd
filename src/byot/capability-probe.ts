// src/byot/capability-probe.ts
import { bedrockChat, bedrockEmbed } from "../bedrock-client.js";
import type { BedrockAuth } from "./types.js";

export interface ProbeFailure { model: string; api: string; error: string; }
export interface ProbeResult { ok: boolean; failures: ProbeFailure[]; }

interface ProbeStep { model: string; api: string; run: () => Promise<void>; }

/** Run each probe step, collecting failures. Exported for unit testing the
 *  aggregation independently of Bedrock. */
export async function aggregateProbe(steps: ProbeStep[]): Promise<ProbeResult> {
  const failures: ProbeFailure[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      // Name-only: AWS SDK errors always set .name (AccessDeniedException,
      // ValidationException, ...). The full message can embed partial
      // ARN/account info that would surface in the 400 response — and the
      // failure tuple already carries model+api for diagnosis.
      failures.push({ model: step.model, api: step.api, error: (err as { name?: string })?.name ?? "probe-error" });
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Confirm a token+region can serve every distinct model the per-session
 * pipeline uses. Enumerated from config so adding a model extends the
 * probe automatically. `noFallback` is set so a broken token surfaces
 * here instead of being masked by bedrock-client's fail-soft.
 */
export async function probeRegionCapabilities(
  token: string,
  region: string,
  models: { judgeModel: string; embeddingModel: string; extraModels?: { model: string; api: "Converse" }[] },
): Promise<ProbeResult> {
  const auth: BedrockAuth = { kind: "bearer", token, region, noFallback: true };
  const steps: ProbeStep[] = [
    {
      model: models.judgeModel, api: "Converse",
      run: async () => { await bedrockChat("You are a test.", "Reply with the single word: ok", models.judgeModel, undefined, undefined, "preflight", auth); },
    },
    {
      model: models.embeddingModel, api: "InvokeModel",
      run: async () => { await bedrockEmbed(["ok"], models.embeddingModel, region, auth); },
    },
    ...(models.extraModels ?? []).map((m) => ({
      model: m.model, api: m.api,
      run: async () => { await bedrockChat("You are a test.", "Reply with the single word: ok", m.model, undefined, undefined, "preflight", auth); },
    })),
  ];
  // Dedupe by (model, api) so an equal judge/classifier ID isn't probed twice.
  const seen = new Set<string>();
  const deduped = steps.filter((s) => { const k = `${s.model}#${s.api}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return aggregateProbe(deduped);
}
