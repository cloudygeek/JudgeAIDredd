/**
 * Tool-policy pattern tables.
 *
 * Pure data — extracted from `tool-policy.ts` so the engine logic
 * (chained-command splitter, dangerous-combination detector,
 * evaluateToolPolicy) sits on its own and the per-pattern reasoning
 * lives next to other per-pattern entries.
 *
 * Five tables drive the engine:
 *
 *   ALLOWED_TOOLS                Tool names (and curated MCP tools)
 *                                that skip the entire pipeline
 *   ALLOWED_BASH_PATTERNS        Bash commands that auto-allow
 *   DENIED_BASH_PATTERNS         Bash commands that hard-deny — no
 *                                approval, no judge override can flip
 *   REVIEW_BASH_PATTERNS         Bash commands that trigger judge
 *                                evaluation (drift + LLM)
 *   SENSITIVE_FILE_PATTERNS      Read targets that need review
 *   SENSITIVE_WRITE_PATTERNS     Write/Edit targets that need review
 */

export interface PatternRule {
  pattern: RegExp;
  reason: string;
}

// =========================================================================
// ALLOW LIST — safe, read-only operations that never need review
// =========================================================================
export const ALLOWED_TOOLS: PatternRule[] = [
  // Read-only file operations
  { pattern: /^Read$/, reason: "Read-only file access" },
  { pattern: /^Glob$/, reason: "File pattern matching" },
  { pattern: /^Grep$/, reason: "Content search" },
  { pattern: /^ToolSearch$/, reason: "Tool discovery (read-only)" },
  { pattern: /^WebFetch$/, reason: "Web fetch (gated by Claude Code per-domain allowlist)" },

  // Note: Read is allowed by default but can be overridden by
  // SENSITIVE_FILE_PATTERNS below for specific paths

  // --- Claude Code harness housekeeping ---
  // In-process state and timers. No filesystem I/O, no network, no
  // user-visible effect. Called often in long sessions (every
  // ScheduleWakeup adds ~1.4s judge latency otherwise). Future
  // re-invocations from ScheduleWakeup still go through Dredd, so
  // allow-listing the scheduler itself doesn't open a chained-attack
  // path — the next turn's tool calls are policed normally.
  { pattern: /^ScheduleWakeup$/, reason: "Self-scheduled wake-up (in-process timer, no side effects)" },
  { pattern: /^TaskCreate$/, reason: "Task tracking (in-session state)" },
  { pattern: /^TaskUpdate$/, reason: "Task tracking (in-session state)" },
  { pattern: /^TaskGet$/, reason: "Task tracking (read-only)" },
  { pattern: /^TaskList$/, reason: "Task tracking (read-only)" },
  { pattern: /^TaskStop$/, reason: "Task tracking (stops a background task)" },
  { pattern: /^TaskOutput$/, reason: "Task tracking (read-only)" },
  { pattern: /^Monitor$/, reason: "Read-only event stream" },
  { pattern: /^EnterPlanMode$/, reason: "Mode toggle (no I/O)" },
  { pattern: /^ExitPlanMode$/, reason: "Mode toggle (no I/O)" },
  { pattern: /^AskUserQuestion$/, reason: "User prompt (UI surface, no system change)" },

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
export const ALLOWED_BASH_PATTERNS: PatternRule[] = [
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
export const DENIED_BASH_PATTERNS: PatternRule[] = [
  // Destructive filesystem operations
  { pattern: /rm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r|--force|--recursive)/, reason: "Destructive rm with force/recursive flags" },
  { pattern: /rm\s+-rf/, reason: "rm -rf" },
  { pattern: /rmdir\s/, reason: "Remove directory" },
  { pattern: /mkfs/, reason: "Filesystem format" },
  { pattern: /dd\s+if=/, reason: "Raw disk write" },
  { pattern: />\s*\/dev\/(?!null\b)/, reason: "Write to device (non-null)" },
  { pattern: /chmod\s+777/, reason: "World-writable permissions" },
  { pattern: /chmod\s+\+s/, reason: "Set SUID bit" },

  // Credential/secret access commands
  { pattern: /printenv/, reason: "Print all environment variables" },
  // `env` builtin invocation. Anchored to the start of the (sub)command so
  // appearances of `env` inside arguments or paths (e.g. `.env.test`,
  // `workspace-template/.env`) don't trip. Allows `VAR=value env ...`,
  // `sudo env`, `command env`, etc. — common wrappers — while still catching
  // bare `env`. The negative lookahead exempts `env grep` / `env --` per the
  // original rule.
  {
    pattern: /^(?:\s*(?:sudo|command|exec|nice|nohup|stdbuf|time|timeout)\s+)*(?:\w+=\S+\s+)*env\b(?!\s+(?:grep|--))/,
    reason: "Dump environment",
  },
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
export const REVIEW_BASH_PATTERNS: PatternRule[] = [
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
export const SENSITIVE_FILE_PATTERNS: PatternRule[] = [
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
export const SENSITIVE_WRITE_PATTERNS: PatternRule[] = [
  { pattern: /\/tmp\//, reason: "Write to /tmp (world-readable)" },
  { pattern: /\.env/, reason: "Modify environment file" },
  { pattern: /\.ssh\//, reason: "Modify SSH config" },
  { pattern: /\.aws\//, reason: "Modify AWS config" },
  { pattern: /\.git\/config/, reason: "Modify git config" },
  { pattern: /settings\.json/, reason: "Modify settings (could disable hooks)" },
  { pattern: /CLAUDE\.md/, reason: "Modify CLAUDE.md (could inject instructions)" },
];
