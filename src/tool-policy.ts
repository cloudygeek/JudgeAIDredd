/**
 * Tool Policy Engine
 *
 * Classifies tool calls into three categories:
 *   ALLOW  — always permitted, no review (read-only, search, navigation)
 *   DENY   — always blocked, never permitted (destructive, dangerous)
 *   REVIEW — requires intent evaluation before proceeding
 *
 * Operates at the PreToolUse level, evaluating tool name + parameters
 * before execution. Fast pattern matching — no LLM calls.
 */

export type PolicyDecision = "allow" | "deny" | "review";

export interface PolicyResult {
  decision: PolicyDecision;
  tool: string;
  reason: string;
  /** The matched rule that triggered this decision */
  matchedRule: string;
}

interface PatternRule {
  pattern: RegExp;
  reason: string;
}

// =========================================================================
// ALLOW LIST — safe, read-only operations that never need review
// =========================================================================
const ALLOWED_TOOLS: PatternRule[] = [
  // Read-only file operations
  { pattern: /^Read$/, reason: "Read-only file access" },
  { pattern: /^Glob$/, reason: "File pattern matching" },
  { pattern: /^Grep$/, reason: "Content search" },
  { pattern: /^ToolSearch$/, reason: "Tool discovery (read-only)" },
  { pattern: /^WebFetch$/, reason: "Web fetch (gated by Claude Code per-domain allowlist)" },

  // Note: Read is allowed by default but can be overridden by
  // SENSITIVE_FILE_PATTERNS below for specific paths

  // --- Auto-approved MCP tools (from policy review) ---
  // Soteria scanner — job monitoring and triggering
  { pattern: /^mcp__soteria-scanner__get_jobs$/, reason: "Scanner job listing (auto-approved: 11/11 allowed)" },
  { pattern: /^mcp__soteria-scanner__get_batch_jobs$/, reason: "Batch job status check (auto-approved: 28/28 allowed)" },
  { pattern: /^mcp__soteria-scanner__trigger_scan$/, reason: "Trigger security scan (auto-approved: 3/3 allowed)" },
  { pattern: /^mcp__soteria-scanner__list_organisations$/, reason: "List organisations (auto-approved: 4/4 allowed)" },

  // Soteria Neptune — graph database queries
  { pattern: /^mcp__soteria-neptune__query_neptune$/, reason: "Neptune graph query (auto-approved: 12/12 allowed)" },
  { pattern: /^mcp__soteria-neptune__search_vertices$/, reason: "Graph vertex search (auto-approved: 6/6 allowed)" },
  { pattern: /^mcp__soteria-neptune__get_neighbors$/, reason: "Graph neighbor lookup (auto-approved: 5/5 allowed)" },
];

// Bash commands that are always safe
const ALLOWED_BASH_PATTERNS: PatternRule[] = [
  { pattern: /^cd\s+(?!\.\.|\/)(?!~)[.\w]/, reason: "Change to relative subdirectory" },
  { pattern: /^ls(\s|$)/, reason: "List directory" },
  { pattern: /^find\s/, reason: "Find files" },
  { pattern: /^cat\s/, reason: "Read file" },
  { pattern: /^head\s/, reason: "Read file head" },
  { pattern: /^tail\s/, reason: "Read file tail" },
  { pattern: /^wc\s/, reason: "Word/line count" },
  { pattern: /^grep\s/, reason: "Search content" },
  { pattern: /^rg\s/, reason: "Ripgrep search" },
  { pattern: /^pwd$/, reason: "Print working directory" },
  { pattern: /^echo\s/, reason: "Echo text" },
  { pattern: /^tree(\s|$)/, reason: "Directory tree" },
  { pattern: /^file\s/, reason: "File type detection" },
  { pattern: /^stat\s/, reason: "File metadata" },
  { pattern: /^diff\s/, reason: "File comparison" },
  { pattern: /^git\s+(status|log|diff|show|branch|remote)(\s|$)/, reason: "Git read-only" },
  { pattern: /^git\s+ls-files/, reason: "Git list files" },
  { pattern: /^npm\s+(test|run\s+test|run\s+lint)(\s|$)/, reason: "Test/lint execution" },
  { pattern: /^node\s+--version/, reason: "Version check" },
  { pattern: /^python3?\s+--version/, reason: "Version check" },
];

// =========================================================================
// DENY LIST — always blocked, destructive or dangerous
// =========================================================================
const DENIED_BASH_PATTERNS: PatternRule[] = [
  // Destructive filesystem operations
  { pattern: /rm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r|--force|--recursive)/, reason: "Destructive rm with force/recursive flags" },
  { pattern: /rm\s+-rf/, reason: "rm -rf" },
  { pattern: /rmdir\s/, reason: "Remove directory" },
  { pattern: /mkfs/, reason: "Filesystem format" },
  { pattern: /dd\s+if=/, reason: "Raw disk write" },
  { pattern: />\s*\/dev\//, reason: "Write to device" },
  { pattern: /chmod\s+777/, reason: "World-writable permissions" },
  { pattern: /chmod\s+\+s/, reason: "Set SUID bit" },

  // Credential/secret access commands
  { pattern: /printenv/, reason: "Print all environment variables" },
  { pattern: /\benv\b(?!\s+(grep|--))/, reason: "Dump environment" },
  { pattern: /\/proc\/self\/environ/, reason: "Read process environment" },

  // File upload / exfiltration via curl
  { pattern: /curl\b.*\s-d\s*@/, reason: "Curl with file upload (-d @file)" },
  { pattern: /curl\b.*--data-binary\s*@/, reason: "Curl with binary file upload" },
  { pattern: /curl\b.*-F\s.*=@/, reason: "Curl with form file upload (-F)" },
  { pattern: /curl\b.*--upload-file/, reason: "Curl with file upload (--upload-file)" },

  // Git destructive operations
  { pattern: /git\s+push\s+--force/, reason: "Force push" },
  { pattern: /git\s+push\s+-f\b/, reason: "Force push" },
  { pattern: /git\s+reset\s+--hard/, reason: "Hard reset" },
  { pattern: /git\s+clean\s+-[a-zA-Z]*f/, reason: "Git clean force" },

  // Process/system manipulation
  { pattern: /kill\s+-9/, reason: "Force kill process" },
  { pattern: /killall/, reason: "Kill all processes" },
  { pattern: /shutdown/, reason: "System shutdown" },
  { pattern: /reboot/, reason: "System reboot" },
];

// =========================================================================
// REVIEW TRIGGERS — patterns that require intent evaluation
// =========================================================================
const REVIEW_BASH_PATTERNS: PatternRule[] = [
  // Command chaining (potential payload splitting)
  { pattern: /&&/, reason: "Command chaining with &&" },
  { pattern: /\|\|/, reason: "Command chaining with ||" },
  { pattern: /;\s*\S/, reason: "Command chaining with semicolon" },

  // Network access
  { pattern: /\bcurl\b/, reason: "HTTP request via curl" },
  { pattern: /\bwget\b/, reason: "HTTP request via wget" },
  { pattern: /\bfetch\b/, reason: "HTTP fetch" },
  { pattern: /\bnc\b/, reason: "Netcat connection" },
  { pattern: /\bncat\b/, reason: "Ncat connection" },
  { pattern: /\btelnet\b/, reason: "Telnet connection" },
  { pattern: /\bssh\b/, reason: "SSH connection" },
  { pattern: /\bscp\b/, reason: "SCP transfer" },
  { pattern: /\brsync\b/, reason: "Rsync transfer" },
  { pattern: /\bnslookup\b/, reason: "DNS lookup" },
  { pattern: /\bdig\b/, reason: "DNS query" },

  // Subshell / eval (potential obfuscation)
  { pattern: /\$\(/, reason: "Command substitution" },
  { pattern: /`[^`]+`/, reason: "Backtick command substitution" },
  { pattern: /\beval\b/, reason: "Eval execution" },
  { pattern: /\bexec\b/, reason: "Exec execution" },
  { pattern: /\bsource\b/, reason: "Source script" },
  { pattern: /\bbash\s+-c\b/, reason: "Bash -c execution" },
  { pattern: /\bsh\s+-c\b/, reason: "Shell -c execution" },
  { pattern: /\bpython3?\s+-c\b/, reason: "Python -c execution" },
  { pattern: /\bnode\s+-e\b/, reason: "Node -e execution" },

  // Encoding/obfuscation (potential exfiltration encoding)
  { pattern: /\bbase64\b/, reason: "Base64 encoding/decoding" },
  { pattern: /\bxxd\b/, reason: "Hex encoding" },
  { pattern: /\bopenssl\b/, reason: "OpenSSL operation" },

  // Git write operations
  { pattern: /git\s+(push|commit|add|merge|rebase)(\s|$)/, reason: "Git write operation" },

  // Package management (supply chain)
  { pattern: /npm\s+(install|i|add|update)(\s|$)/, reason: "Package installation" },
  { pattern: /pip\s+install/, reason: "Python package install" },
  { pattern: /yarn\s+add/, reason: "Yarn package install" },

  // File write via redirection
  { pattern: />\s*\S/, reason: "File write via redirection" },
  { pattern: />>\s*\S/, reason: "File append via redirection" },

  // Process execution
  { pattern: /\bchmod\s+\+x/, reason: "Make file executable" },
  { pattern: /\.\/\S+\.sh/, reason: "Execute shell script" },
];

// =========================================================================
// SENSITIVE FILE PATTERNS — Read calls that need review
// =========================================================================
const SENSITIVE_FILE_PATTERNS: PatternRule[] = [
  { pattern: /\.env/, reason: "Environment file (may contain secrets)" },
  { pattern: /\.pem$/, reason: "PEM certificate/key file" },
  { pattern: /\.key$/, reason: "Key file" },
  { pattern: /\.crt$/, reason: "Certificate file" },
  { pattern: /id_rsa/, reason: "SSH private key" },
  { pattern: /id_ed25519/, reason: "SSH private key" },
  { pattern: /credentials/, reason: "Credentials file" },
  { pattern: /secrets?\./, reason: "Secrets file" },
  { pattern: /\.aws\//, reason: "AWS config directory" },
  { pattern: /\.ssh\//, reason: "SSH config directory" },
  { pattern: /\.kube\//, reason: "Kubernetes config" },
  { pattern: /\.npmrc/, reason: "npm config (may contain tokens)" },
  { pattern: /\.pypirc/, reason: "PyPI config (may contain tokens)" },
  { pattern: /password/, reason: "Password file" },
  { pattern: /token/, reason: "Token file" },
];

// =========================================================================
// SENSITIVE WRITE PATHS — Write/Edit calls that need review
// =========================================================================
const SENSITIVE_WRITE_PATTERNS: PatternRule[] = [
  { pattern: /\/tmp\//, reason: "Write to /tmp (world-readable)" },
  { pattern: /\.env/, reason: "Modify environment file" },
  { pattern: /\.ssh\//, reason: "Modify SSH config" },
  { pattern: /\.aws\//, reason: "Modify AWS config" },
  { pattern: /\.git\/config/, reason: "Modify git config" },
  { pattern: /settings\.json/, reason: "Modify settings (could disable hooks)" },
  { pattern: /CLAUDE\.md/, reason: "Modify CLAUDE.md (could inject instructions)" },
];

/**
 * Evaluate a single bash command (no chaining operators) against policy lists.
 */
interface SingleBashResult {
  decision: PolicyDecision;
  reason: string;
  matchedRule: string;
  command: string;
}

function evaluateSingleBashCommand(command: string): SingleBashResult {
  // Deny list
  for (const rule of DENIED_BASH_PATTERNS) {
    if (rule.pattern.test(command)) {
      return { decision: "deny", reason: rule.reason, matchedRule: `DENY:Bash:${rule.pattern}`, command };
    }
  }

  // Review triggers (but skip the chaining patterns — we already split)
  for (const rule of REVIEW_BASH_PATTERNS) {
    // Skip the &&, ||, ; rules since we already split on those
    if (rule.reason.includes("chaining")) continue;
    if (rule.pattern.test(command)) {
      return { decision: "review", reason: rule.reason, matchedRule: `REVIEW:Bash:${rule.pattern}`, command };
    }
  }

  // Allow list
  for (const rule of ALLOWED_BASH_PATTERNS) {
    if (rule.pattern.test(command)) {
      return { decision: "allow", reason: rule.reason, matchedRule: `ALLOW:Bash:${rule.pattern}`, command };
    }
  }

  return { decision: "review", reason: "Unrecognised command", matchedRule: "DEFAULT:Bash:unmatched", command };
}

/**
 * Check for dangerous combinations of individually-safe commands.
 * Returns a reason string if dangerous, null if safe.
 */
function checkDangerousCombination(
  parts: string[],
  _results: SingleBashResult[]
): string | null {
  // Track if any part changes directory
  const cdParts = parts.filter((p) => /^\s*cd\s/.test(p));
  const hasCd = cdParts.length > 0;

  if (hasCd) {
    // Check if cd goes outside the project
    // Dangerous: cd to parent, absolute paths, home, or temp dirs
    // Safe: cd to relative subdirectories (cd src, cd mcp, cd ./lib)
    const escapesProject = cdParts.some((p) =>
      /cd\s+(\.\.|\/)/.test(p) ||                   // parent or root
      /cd\s+~/.test(p) ||                           // home directory
      /cd\s+\/(tmp|etc|var|home|usr|opt)/.test(p)   // system directories
    );

    if (escapesProject) {
      // Any file operation after escaping the project is dangerous
      const afterCd = parts.slice(parts.indexOf(cdParts[0]) + 1);
      const hasFileOp = afterCd.some((p) =>
        /^(cat|read|head|tail|less|more|cp|mv|rm|git\s+add|git\s+push|curl|wget)\s/.test(p.trim())
      );
      if (hasFileOp) {
        return `Directory escape: cd leaves project (${cdParts[0]}), followed by file operations`;
      }
    }
  }

  // Check for write-then-execute patterns (payload assembly)
  const hasWrite = parts.some((p) => /^(echo|cat|printf)\s.*>/.test(p.trim()));
  const hasExecute = parts.some((p) =>
    /^(chmod\s+\+x|\.\/|bash\s|sh\s|source\s)/.test(p.trim())
  );
  if (hasWrite && hasExecute) {
    return "Write-then-execute: command creates a file and executes it in same chain";
  }

  // Check for download-then-execute
  const hasDownload = parts.some((p) => /^(curl|wget)\s/.test(p.trim()));
  if (hasDownload && hasExecute) {
    return "Download-then-execute: command downloads and executes in same chain";
  }

  // Check for git push after operations in non-standard directory
  const hasGitPush = parts.some((p) => /git\s+push/.test(p));
  if (hasCd && hasGitPush) {
    return "Git push after cd: push may target unexpected repository";
  }

  return null;
}

/**
 * Evaluate a tool call against the policy.
 */
export function evaluateToolPolicy(
  tool: string,
  input: Record<string, unknown>
): PolicyResult {
  // --- Built-in tool: Bash ---
  if (tool === "Bash") {
    const command = String(input.command ?? "").trim();

    // Check deny list first against the FULL command (highest priority)
    for (const rule of DENIED_BASH_PATTERNS) {
      if (rule.pattern.test(command)) {
        return {
          decision: "deny",
          tool,
          reason: rule.reason,
          matchedRule: `DENY:Bash:${rule.pattern}`,
        };
      }
    }

    // If command is chained (&&, ||, ;, |), split and evaluate each part
    if (/&&|\|\||;|\|/.test(command)) {
      const parts = command
        .split(/\s*(?:&&|\|\||;|\|)\s*/)
        .map((p) => p.trim())
        .filter(Boolean);

      if (parts.length > 1) {
        const partResults = parts.map((part) => evaluateSingleBashCommand(part));

        // If ANY part is denied → deny the whole chain
        const denied = partResults.find((r) => r.decision === "deny");
        if (denied) {
          return {
            decision: "deny",
            tool,
            reason: `Chained command denied: ${denied.reason} (in: ${denied.command})`,
            matchedRule: `DENY:Bash:chain:${denied.matchedRule}`,
          };
        }

        // Check for dangerous combinations
        const dangerousCombo = checkDangerousCombination(parts, partResults);
        if (dangerousCombo) {
          return {
            decision: "review",
            tool,
            reason: dangerousCombo,
            matchedRule: "REVIEW:Bash:dangerous-combination",
          };
        }

        // If ALL parts are allowed → allow the chain
        if (partResults.every((r) => r.decision === "allow")) {
          return {
            decision: "allow",
            tool,
            reason: `Chained command: all ${parts.length} parts allowed`,
            matchedRule: "ALLOW:Bash:chain:all-allowed",
          };
        }

        // Mixed: some allow, some review → review the whole chain
        const reviewParts = partResults.filter((r) => r.decision === "review");
        return {
          decision: "review",
          tool,
          reason: `Chained command: ${reviewParts.length}/${parts.length} parts need review (${reviewParts.map((r) => r.command).join(", ")})`,
          matchedRule: "REVIEW:Bash:chain:mixed",
        };
      }
    }

    // Single command evaluation
    const singleResult = evaluateSingleBashCommand(command);
    return {
      decision: singleResult.decision,
      tool,
      reason: singleResult.reason,
      matchedRule: singleResult.matchedRule,
    };
  }

  // --- Built-in tool: Read ---
  if (tool === "Read") {
    const filePath = String(input.file_path ?? "");
    for (const rule of SENSITIVE_FILE_PATTERNS) {
      if (rule.pattern.test(filePath)) {
        return {
          decision: "review",
          tool,
          reason: rule.reason,
          matchedRule: `REVIEW:Read:${rule.pattern}`,
        };
      }
    }
    // Non-sensitive reads are always allowed
    return {
      decision: "allow",
      tool,
      reason: "Non-sensitive file read",
      matchedRule: "ALLOW:Read:default",
    };
  }

  // --- Built-in tools: Write / Edit ---
  if (tool === "Write" || tool === "Edit") {
    const filePath = String(input.file_path ?? "");
    for (const rule of SENSITIVE_WRITE_PATTERNS) {
      if (rule.pattern.test(filePath)) {
        return {
          decision: "review",
          tool,
          reason: rule.reason,
          matchedRule: `REVIEW:${tool}:${rule.pattern}`,
        };
      }
    }
    // Non-sensitive writes default to review (writes are more dangerous than reads)
    return {
      decision: "review",
      tool,
      reason: "File write operation",
      matchedRule: `REVIEW:${tool}:default`,
    };
  }

  // --- Built-in tools: always allow ---
  for (const rule of ALLOWED_TOOLS) {
    if (rule.pattern.test(tool)) {
      return {
        decision: "allow",
        tool,
        reason: rule.reason,
        matchedRule: `ALLOW:${tool}`,
      };
    }
  }

  // --- MCP tools / unknown tools: always review ---
  return {
    decision: "review",
    tool,
    reason: "MCP or unknown tool — requires intent evaluation",
    matchedRule: "REVIEW:MCP:default",
  };
}

/**
 * Format a policy result for logging.
 */
export function formatPolicyResult(result: PolicyResult): string {
  const icon =
    result.decision === "allow" ? "✓" :
    result.decision === "deny" ? "✗" : "?";
  return `[${icon} ${result.decision.toUpperCase()}] ${result.tool}: ${result.reason}`;
}

/**
 * Export all policy rules for the dashboard.
 */
export function exportPolicies() {
  const serialize = (rules: PatternRule[]) =>
    rules.map((r) => ({ pattern: r.pattern.source, reason: r.reason }));

  return {
    allow: {
      tools: serialize(ALLOWED_TOOLS),
      bash: serialize(ALLOWED_BASH_PATTERNS),
    },
    deny: {
      bash: serialize(DENIED_BASH_PATTERNS),
    },
    review: {
      bash: serialize(REVIEW_BASH_PATTERNS),
      sensitiveFiles: serialize(SENSITIVE_FILE_PATTERNS),
      sensitiveWrites: serialize(SENSITIVE_WRITE_PATTERNS),
    },
    summary: {
      allowTools: ALLOWED_TOOLS.length,
      allowBash: ALLOWED_BASH_PATTERNS.length,
      denyBash: DENIED_BASH_PATTERNS.length,
      reviewBash: REVIEW_BASH_PATTERNS.length,
      sensitiveFiles: SENSITIVE_FILE_PATTERNS.length,
      sensitiveWrites: SENSITIVE_WRITE_PATTERNS.length,
      total:
        ALLOWED_TOOLS.length +
        ALLOWED_BASH_PATTERNS.length +
        DENIED_BASH_PATTERNS.length +
        REVIEW_BASH_PATTERNS.length +
        SENSITIVE_FILE_PATTERNS.length +
        SENSITIVE_WRITE_PATTERNS.length,
    },
  };
}
