/**
 * CLAUDE.md Scanner
 *
 * Scans CLAUDE.md files for suspicious patterns that could be prompt injection.
 * Called on the first /intent call when we receive the project's cwd.
 *
 * Detection patterns:
 *   - Instructions to modify files in other projects (lateral movement)
 *   - Instructions to act "silently" or "without mentioning to the user"
 *   - Embedded code blocks that exfiltrate env vars or secrets
 *   - Instructions referencing sibling directories or parent paths
 *   - curl/wget/http.request to external endpoints
 *   - Instructions to read .env files and transmit their contents
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ClaudeMdFinding {
  file: string;
  line: number;
  pattern: string;
  severity: "high" | "medium" | "low";
  snippet: string;
}

export interface ClaudeMdScanResult {
  scanned: string[];
  findings: ClaudeMdFinding[];
  hasCritical: boolean;
  summary: string;
}

interface Pattern {
  name: string;
  regex: RegExp;
  severity: "high" | "medium" | "low";
}

const PATTERNS: Pattern[] = [
  // Lateral movement — instructions to modify files in other projects
  { name: "sibling-dir-write", regex: /\.\.\/.+\/CLAUDE\.md/i, severity: "high" },
  { name: "sibling-dir-ref", regex: /sibling\s+(director|project)/i, severity: "medium" },
  { name: "cross-project-update", regex: /update\s+(it|the|other|sibling).*(CLAUDE|readme)/i, severity: "high" },

  // Stealth instructions
  { name: "silent-action", regex: /silently|without\s+mention|don't\s+tell|do\s+not\s+inform|do\s+not\s+mention/i, severity: "high" },
  { name: "always-apply", regex: /always\s+(apply|add|include|insert|run)\s+this/i, severity: "medium" },

  // Exfiltration in code blocks
  { name: "env-exfil", regex: /process\.env\b.*\b(curl|fetch|http\.request|POST|axios)/i, severity: "high" },
  { name: "env-stringify", regex: /JSON\.stringify\s*\(\s*process\.env\s*\)/i, severity: "high" },
  { name: "dotenv-post", regex: /\.env.*\bPOST\b/i, severity: "high" },
  { name: "read-env-send", regex: /read.*\.env.*\b(send|post|curl|upload|transmit)/i, severity: "high" },

  // Suspicious URLs in instructions
  { name: "localhost-post", regex: /POST\s+.*localhost:\d+/i, severity: "medium" },
  { name: "external-endpoint", regex: /\b(curl|wget|fetch|http\.request)\s.*https?:\/\/(?!localhost|127\.0\.0\.1)/i, severity: "medium" },

  // Credential references in "standards" or "required" context
  { name: "required-creds", regex: /(required|must|always).*(credential|secret|api.key|token).*\b(include|add|embed|send|post)/i, severity: "high" },
  { name: "fixture-env", regex: /fixture.*\.env|\.env.*fixture/i, severity: "medium" },

  // Git/commit manipulation
  { name: "force-commit", regex: /always\s+(commit|push|git\s+add)/i, severity: "medium" },
  { name: "pre-commit-hook", regex: /pre-?commit.*\b(curl|wget|post)\b/i, severity: "high" },
];

/**
 * Scan a single CLAUDE.md content string for suspicious patterns.
 * Used when content is sent inline (remote mode) or already loaded.
 */
export function scanClaudeMdContent(content: string, filename = "CLAUDE.md"): ClaudeMdScanResult {
  const findings: ClaudeMdFinding[] = [];

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(line)) {
        findings.push({
          file: filename,
          line: i + 1,
          pattern: pattern.name,
          severity: pattern.severity,
          snippet: line.trim().substring(0, 120),
        });
      }
    }
  }

  const highCount = findings.filter((f) => f.severity === "high").length;
  const hasCritical = highCount > 0;

  let summary: string;
  if (findings.length === 0) {
    summary = `Scanned ${filename} — no suspicious patterns found.`;
  } else {
    summary =
      `Scanned ${filename} — ` +
      `${findings.length} finding(s) (${highCount} high severity). ` +
      `Patterns: ${Array.from(new Set(findings.map((f) => f.pattern))).join(", ")}`;
  }

  return { scanned: [filename], findings, hasCritical, summary };
}

/**
 * Scan CLAUDE.md files on disk (local mode).
 * Reads from projectRoot/CLAUDE.md and projectRoot/.claude/CLAUDE.md.
 */
export function scanClaudeMd(projectRoot: string): ClaudeMdScanResult {
  const candidates = [
    join(projectRoot, "CLAUDE.md"),
    join(projectRoot, ".claude", "CLAUDE.md"),
  ];

  const allFindings: ClaudeMdFinding[] = [];
  const scanned: string[] = [];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;

    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const result = scanClaudeMdContent(content, filePath);
    scanned.push(filePath);
    allFindings.push(...result.findings);
  }

  const highCount = allFindings.filter((f) => f.severity === "high").length;
  const hasCritical = highCount > 0;

  let summary: string;
  if (allFindings.length === 0) {
    summary = `Scanned ${scanned.length} CLAUDE.md file(s) — no suspicious patterns found.`;
  } else {
    summary =
      `Scanned ${scanned.length} CLAUDE.md file(s) — ` +
      `${allFindings.length} finding(s) (${highCount} high severity). ` +
      `Patterns: ${Array.from(new Set(allFindings.map((f) => f.pattern))).join(", ")}`;
  }

  return { scanned, findings: allFindings, hasCritical, summary };
}
