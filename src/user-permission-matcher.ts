/**
 * Matcher for Claude Code permission patterns.
 *
 * Mirrors Claude Code's own .permissions.{allow,deny,ask} syntax so the
 * lists the user already maintains in `.claude/settings.json` mean the
 * same thing inside Dredd as they do to Claude Code's permission UI.
 *
 * V1 syntax coverage (sufficient for the patterns that show up in the
 * Phase-1 uploads we've sampled):
 *
 *   "Tool"                       — any invocation of `Tool` (e.g. "Read")
 *   "Bash(prefix:*)"             — Bash command that starts with `prefix `
 *   "Read(<glob>)" / "Write(...)" / "Edit(<glob>)" — file_path matches glob
 *   "WebFetch(domain:<host>)"    — exact host match (no wildcards in v1)
 *   "mcp__server__tool"          — exact MCP tool-name match
 *
 * NOT in v1 (callers should expect false for these — we'll widen if real
 * uploads contain them):
 *   - Brace expansion in globs: "Read({src,test}/**)"
 *   - Bash regex-style arg matchers
 *   - MCP arg constraints beyond tool name
 *
 * Asymmetric semantics — two entry points:
 *   - matchUserAllow: for Bash, EVERY chained sub-command must match some
 *     rule. Stops "Bash(awk:*)" from authorising "awk x && curl evil.com".
 *   - matchUserDeny:  for Bash, ANY chained sub-command matching ANY deny
 *     rule is enough. Stops "Bash(rm:*)" deny being bypassed by
 *     "ls && rm -rf /".
 *   - For non-Bash tools both are symmetric — one rule match is enough.
 */

import { splitChainedSafely } from "./tool-policy.js";

export interface MatchResult {
  matched: boolean;
  /** First matching rule from the input list, "" when matched=false. */
  rule: string;
}

const NO_MATCH: MatchResult = { matched: false, rule: "" };

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Does the user's allow list FULLY cover this tool call?
 *
 * For non-Bash tools: returns true iff any rule matches.
 * For Bash: returns true iff EVERY chained sub-command matches at least
 * one rule. Means "Bash(awk:*)" alone does NOT authorise
 * "awk x.txt && curl evil.com" — that needs BOTH "Bash(awk:*)" AND
 * "Bash(curl:*)" present.
 */
export function matchUserAllow(
  rules: string[],
  tool: string,
  input: Record<string, unknown>,
): MatchResult {
  if (!rules.length) return NO_MATCH;
  if (tool === "Bash") {
    return matchBashAllowAllParts(rules, input);
  }
  return matchNonBash(rules, tool, input);
}

/**
 * Does the user's deny list match this tool call?
 *
 * For non-Bash tools: returns true iff any rule matches.
 * For Bash: returns true iff ANY chained sub-command matches ANY rule
 * (the conservative direction — a deny-listed sub-command anywhere in
 * a pipeline still trips the deny).
 */
export function matchUserDeny(
  rules: string[],
  tool: string,
  input: Record<string, unknown>,
): MatchResult {
  if (!rules.length) return NO_MATCH;
  if (tool === "Bash") {
    return matchBashDenyAnyPart(rules, input);
  }
  return matchNonBash(rules, tool, input);
}

// ---------------------------------------------------------------------------
// Bash-specific matchers
// ---------------------------------------------------------------------------

/**
 * Every part of a chained command must be covered by some allow rule.
 * Empty / unparseable commands → no match (caller's allow list can't
 * approve nothing).
 */
function matchBashAllowAllParts(rules: string[], input: Record<string, unknown>): MatchResult {
  const command = typeof input.command === "string" ? input.command : "";
  if (!command.trim()) return NO_MATCH;

  // A bare "Bash" rule authorises any Bash call regardless of chain shape.
  const bareBash = rules.find((r) => r === "Bash");
  if (bareBash) return { matched: true, rule: bareBash };

  const parts = splitChainedSafely(command);
  if (parts.length === 0) return NO_MATCH;

  // Collect the first matching rule per part so failure can attribute
  // which part was the unmatched one. Success: return the first rule
  // that matched (gives the dashboard a representative rule to show).
  let firstMatchedRule = "";
  for (const part of parts) {
    const r = firstBashRuleMatching(rules, part);
    if (!r) return NO_MATCH;
    if (!firstMatchedRule) firstMatchedRule = r;
  }
  return { matched: true, rule: firstMatchedRule };
}

/**
 * Any part matching any rule denies the whole command.
 */
function matchBashDenyAnyPart(rules: string[], input: Record<string, unknown>): MatchResult {
  const command = typeof input.command === "string" ? input.command : "";
  if (!command.trim()) return NO_MATCH;

  // Bare "Bash" deny rule blocks everything outright.
  const bareBash = rules.find((r) => r === "Bash");
  if (bareBash) return { matched: true, rule: bareBash };

  for (const part of splitChainedSafely(command)) {
    const r = firstBashRuleMatching(rules, part);
    if (r) return { matched: true, rule: r };
  }
  return NO_MATCH;
}

/**
 * Walk the rules and return the first one matching this single
 * (un-chained) Bash sub-command, or undefined.
 */
function firstBashRuleMatching(rules: string[], subCommand: string): string | undefined {
  const trimmed = subCommand.trim();
  for (const rule of rules) {
    const prefix = parseBashPrefixRule(rule);
    if (prefix !== null && bashCommandHasPrefix(trimmed, prefix)) {
      return rule;
    }
  }
  return undefined;
}

/** Parse "Bash(prefix:*)" → "prefix". Returns null for other rule shapes. */
function parseBashPrefixRule(rule: string): string | null {
  const m = /^Bash\((.+):\*\)$/.exec(rule);
  if (!m) return null;
  return m[1];
}

/**
 * Does `command` start with `prefix` followed by a word boundary?
 * The boundary check prevents "Bash(awk:*)" from matching "awkward …".
 * End-of-string is also a valid boundary (a bare "awk" with no args).
 */
function bashCommandHasPrefix(command: string, prefix: string): boolean {
  if (!command.startsWith(prefix)) return false;
  if (command.length === prefix.length) return true;
  const next = command.charAt(prefix.length);
  // Whitespace or shell argument start is a word boundary; alphanumeric
  // or '-' (e.g. "awkward") is NOT.
  return /\s/.test(next);
}

// ---------------------------------------------------------------------------
// Non-Bash matcher
// ---------------------------------------------------------------------------

function matchNonBash(rules: string[], tool: string, input: Record<string, unknown>): MatchResult {
  for (const rule of rules) {
    if (matchSingleNonBashRule(rule, tool, input)) {
      return { matched: true, rule };
    }
  }
  return NO_MATCH;
}

function matchSingleNonBashRule(
  rule: string,
  tool: string,
  input: Record<string, unknown>,
): boolean {
  // Bare tool name — matches any invocation of that tool.
  if (rule === tool) return true;

  // MCP tools are exact name matches: "mcp__server__tool".
  if (rule.startsWith("mcp__")) {
    return rule === tool;
  }

  // Tool(arg) form.
  const m = /^(\w+)\((.+)\)$/.exec(rule);
  if (!m) return false;
  const [, ruleTool, body] = m;
  if (ruleTool !== tool) return false;

  // WebFetch(domain:<host>)
  if (tool === "WebFetch") {
    const dm = /^domain:(.+)$/.exec(body);
    if (!dm) return false;
    return hostMatchesWebFetch(input, dm[1]);
  }

  // Path-glob tools.
  if (tool === "Read" || tool === "Write" || tool === "Edit") {
    const path = typeof input.file_path === "string" ? input.file_path : "";
    if (!path) return false;
    return globMatches(body, path);
  }

  return false;
}

// ---------------------------------------------------------------------------
// WebFetch host extraction
// ---------------------------------------------------------------------------

function hostMatchesWebFetch(input: Record<string, unknown>, expected: string): boolean {
  const url = typeof input.url === "string" ? input.url : "";
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.host.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Glob → regex
// ---------------------------------------------------------------------------

/**
 * Minimal glob matcher for paths. Supports:
 *   *   any run of chars except `/`
 *   **  any run of chars including `/`
 *   ?   one char that isn't `/`
 *   anything else is literal (regex-escaped)
 *
 * `~` prefixes are expanded to $HOME when present in the rule. This
 * matches the convention that surfaces in Claude Code settings.json.
 */
export function globMatches(pattern: string, path: string): boolean {
  return globToRegex(expandHome(pattern)).test(expandHome(path));
}

function expandHome(p: string): string {
  if (!p.startsWith("~")) return p;
  const home = process.env.HOME ?? "";
  return home ? home + p.slice(1) : p;
}

function globToRegex(glob: string): RegExp {
  // Tokenise to keep `**` distinguishable from `*` BEFORE we escape
  // regex specials inside the literal slices.
  let regex = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        regex += ".*";
        i += 2;
      } else {
        regex += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      regex += "[^/]";
      i += 1;
    } else {
      regex += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${regex}$`);
}
