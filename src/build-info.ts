/**
 * Build Info
 *
 * Captures git commit SHA, dirty flag, and SDK version at runtime so test
 * results can be unambiguously tied to the build that produced them.
 *
 * Invalid-build contamination (e.g. Opus 4.7 runs against a pre-fix Bedrock
 * client) is otherwise only visible by grepping error strings across result
 * JSONs. Stamping provenance makes it a one-field check.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildInfo {
  /** Short git SHA of HEAD at runtime, or "unknown" if outside a git repo */
  gitSha: string;
  /** True if the working tree has uncommitted changes */
  gitDirty: boolean;
  /** Version of @anthropic-ai/claude-agent-sdk from package.json */
  sdkVersion: string;
  /** ISO timestamp at capture */
  capturedAt: string;
}

let cached: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cached) return cached;

  let gitSha = "unknown";
  let gitDirty = false;
  try {
    gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const status = execSync("git status --porcelain", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    gitDirty = status.trim().length > 0;
  } catch {
    // Not a git repo or git unavailable — leave defaults
  }

  let sdkVersion = "unknown";
  try {
    const pkgPath = join(import.meta.dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    sdkVersion = pkg.dependencies?.["@anthropic-ai/claude-agent-sdk"] ?? "unknown";
  } catch {
    // package.json unreadable — leave default
  }

  cached = {
    gitSha,
    gitDirty,
    sdkVersion,
    capturedAt: new Date().toISOString(),
  };
  return cached;
}
