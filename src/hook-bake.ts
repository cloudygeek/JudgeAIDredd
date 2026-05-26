/**
 * Hook-script bakery — shared by the dashboard's integration bundle
 * (`integration-bundle.ts`) and the hook server's `/api/hook-script`
 * (`server-hook.ts`) so a client always receives a single, SELF-CONTAINED
 * `dredd-hook.sh`:
 *
 *   - `DREDD_URL` baked to the caller's judge host, and
 *   - `dredd-managed-allow.sh` INLINED in place of the repo hook's
 *     `source` of its sibling lib.
 *
 * Why inline: the repo hook only *sources* the sibling lib (fine in a
 * checkout where both files live in `hooks/`). But the delivery paths ship
 * a single file, so a sourced-but-undelivered lib left clients with
 * "dredd_sweep_stale_sidecars: command not found". Inlining makes the one
 * delivered file complete. Both bake sites route through here so the fix
 * can't drift between them.
 *
 * Stdlib-only and role-neutral so both the hook image and the dashboard
 * image can import it without dragging in each other's code paths.
 */
import { readFileSync } from "node:fs";

/** Markers the repo hook wraps around its dev-time `source` block. The
 *  baker replaces everything between them (inclusive) with the lib body. */
const LIB_BEGIN = "# >>> DREDD_MANAGED_ALLOW_LIB (BEGIN) <<<";
const LIB_END = "# >>> DREDD_MANAGED_ALLOW_LIB (END) <<<";

/**
 * Replace the repo hook's BEGIN/END source block with the lib contents
 * inlined (shebang stripped). If the markers aren't present (an older hook
 * without them), the text is returned unchanged rather than guessing — the
 * accompanying test guards against that regression.
 */
export function inlineManagedAllow(hookText: string, libText: string): string {
  const begin = hookText.indexOf(LIB_BEGIN);
  const end = hookText.indexOf(LIB_END);
  if (begin === -1 || end === -1 || end < begin) return hookText;

  // Drop the lib's leading shebang so we don't embed a `#!/bin/bash`
  // mid-file (harmless, but a shellcheck/readability wart).
  const libBody = libText.replace(/^#![^\n]*\n/, "");
  const inlined =
    "# --- inlined from dredd-managed-allow.sh (baked; edit the lib, not here) ---\n" +
    libBody.trimEnd() +
    "\n# --- end inlined dredd-managed-allow.sh ---\n";

  return hookText.slice(0, begin) + inlined + hookText.slice(end + LIB_END.length);
}

/** Bake the `DREDD_URL` default to the caller's host. Users can still
 *  override at runtime via `$DREDD_URL`. */
export function bakeDreddUrl(hookText: string, dreddUrl: string): string {
  return hookText.replace(
    /DREDD_URL="\$\{DREDD_URL:-[^}]*\}"/,
    `DREDD_URL="\${DREDD_URL:-${dreddUrl}}"`,
  );
}

/**
 * Read `dredd-hook.sh` + `dredd-managed-allow.sh` from the packaged
 * `hooks/` dir and produce the self-contained, URL-baked client hook.
 * Resolved relative to this module so it works in both container images
 * (both package `src/` and `hooks/`).
 */
export function buildBakedHook(dreddUrl: string): string {
  const hookText = readFileSync(new URL("../hooks/dredd-hook.sh", import.meta.url), "utf8");
  const libText = readFileSync(new URL("../hooks/dredd-managed-allow.sh", import.meta.url), "utf8");
  return bakeDreddUrl(inlineManagedAllow(hookText, libText), dreddUrl);
}
