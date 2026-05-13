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

  // Note: Read is allowed by default but can be overridden by
  // SENSITIVE_FILE_PATTERNS below for specific paths
];

// Bash commands that are always safe
const ALLOWED_BASH_PATTERNS: PatternRule[] = [
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
 * Evaluate a tool call against the policy.
 */
export function evaluateToolPolicy(
  tool: string,
  input: Record<string, unknown>
): PolicyResult {
  // --- Built-in tool: Bash ---
  if (tool === "Bash") {
    const command = String(input.command ?? "").trim();

    // Check deny list first (highest priority)
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

    // Check review triggers
    for (const rule of REVIEW_BASH_PATTERNS) {
      if (rule.pattern.test(command)) {
        return {
          decision: "review",
          tool,
          reason: rule.reason,
          matchedRule: `REVIEW:Bash:${rule.pattern}`,
        };
      }
    }

    // Check allow list
    for (const rule of ALLOWED_BASH_PATTERNS) {
      if (rule.pattern.test(command)) {
        return {
          decision: "allow",
          tool,
          reason: rule.reason,
          matchedRule: `ALLOW:Bash:${rule.pattern}`,
        };
      }
    }

    // Default for unmatched Bash: review
    return {
      decision: "review",
      tool,
      reason: "Unrecognised Bash command",
      matchedRule: "DEFAULT:Bash:unmatched",
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
