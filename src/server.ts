/**
 * Judge Dredd — role dispatcher.
 *
 * Single binary, two roles. DREDD_ROLE picks which entry boots:
 *
 *   DREDD_ROLE=hook       (default) — the hot path: /intent, /evaluate,
 *                                     /track, /end, /pivot, /compact,
 *                                     /register + health + /api/feed +
 *                                     /api/mode. Runs the Bedrock/Ollama
 *                                     preflight.
 *   DREDD_ROLE=dashboard            — the UI: /, /api/sessions,
 *                                     /api/session-log/:id, /api/policies,
 *                                     /api/logs*, /api/integration-bundle.
 *                                     No judge preflight.
 *
 * Default is "hook" so existing deployments (which didn't set DREDD_ROLE)
 * keep booting as the hook server. The AI Sandbox dashboard deployment
 * sets DREDD_ROLE=dashboard explicitly via the task definition.
 */

type Role = "hook" | "dashboard";
const role: Role = (process.env.DREDD_ROLE ?? "hook") as Role;

if (role !== "hook" && role !== "dashboard") {
  console.error(`Invalid DREDD_ROLE=${process.env.DREDD_ROLE} — expected hook|dashboard`);
  process.exit(2);
}

(async () => {
  if (role === "hook") {
    const { main } = await import("./server-hook.js");
    await main();
  } else {
    const { main } = await import("./server-dashboard.js");
    await main();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
