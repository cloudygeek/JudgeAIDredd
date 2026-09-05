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

  // Soteria Neptune — READ-ONLY graph queries.
  //
  // The server name carries a version suffix that changes ("soteria-neptune",
  // "soteria-neptune-v2", ...). These were pinned to the unsuffixed name, so
  // when the deployment moved to -v2 the allowlist silently stopped matching
  // and every graph read went to the judge again: 14 denies in the 2026-09-05
  // review, 0 against the v1 name. The judge's objections were uniformly
  // "querying a database constitutes extracting sensitive data" — including
  // one that reasoned from the SERVER'S NAME ("the 'soteria-neptune' tool
  // implies a security or secrets management context"). This is the project's
  // own asset-inventory graph; reading it is the normal work here.
  //
  // `[\w-]*` tolerates the version suffix. It does NOT widen the tool set:
  // each read-only tool is still named explicitly, and the anchors hold. That
  // matters because the same server exposes delete_vertices, delete_edges,
  // delete_by_query and delete_vertices_from_file — destructive, and
  // deliberately NOT listed. delete_by_query was denied twice in the same
  // review; those denials are correct and must keep reaching the judge.
  { pattern: /^mcp__soteria-neptune[\w-]*__query_neptune$/, reason: "Neptune graph query (read-only; mutations blocked server-side)" },
  { pattern: /^mcp__soteria-neptune[\w-]*__search_vertices$/, reason: "Graph vertex search (read-only)" },
  { pattern: /^mcp__soteria-neptune[\w-]*__get_neighbors$/, reason: "Graph neighbor lookup (read-only)" },
  { pattern: /^mcp__soteria-neptune[\w-]*__get_vertex$/, reason: "Single vertex read (read-only)" },
  { pattern: /^mcp__soteria-neptune[\w-]*__count_vertices$/, reason: "Vertex count (read-only)" },
  { pattern: /^mcp__soteria-neptune[\w-]*__get_schema$/, reason: "Graph schema read (read-only)" },
  { pattern: /^mcp__soteria-neptune[\w-]*__server_info$/, reason: "Deployment metadata (read-only)" },
];

// Bash commands that are always safe.
//
// SAFETY MODEL — read before adding anything here.
// This list is INSTANT-ALLOW: it bypasses the LLM judge and the drift
// detector, so an entry must be safe even if the agent is fully hijacked.
// BUT it is also subordinate: evaluateSingleBashCommand checks DENY, then
// REVIEW, then this ALLOW list, so any part containing a redirection (`>`),
// command substitution (`$(`/backticks), pipe, network verb, or
// eval/bash -c is routed to DENY/REVIEW *before* it can match here, and
// chained commands are split and evaluated per-part. The only thing this
// list grants is a BARE invocation. So the bar for adding a command is:
// "with its own flags and no shell operators, can it exfiltrate, execute
// arbitrary code, destroy, or overwrite a file?"
//
// That bar EXCLUDES several tempting candidates:
//   - awk / sed / perl / python / ruby — can spawn shells (awk 'BEGIN{system(...)}',
//     sed `e`, perl -e). Never instant-allow an interpreter.
//   - sort -o FILE / uniq IN OUT / tee — write to an arbitrary file with no
//     redirection operator, so the `>` REVIEW guard never sees them.
//   - cp / mv — overwrite/clobber existing files.
//   - env / printenv / command — dump the environment (secrets). Stay DENY.
//   - tr / rev / xxd / base64 — transform/encode (exfil-prep); stay REVIEW.
//   - cp/mv/tee handled above; find -delete / -exec routed to REVIEW below.
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
  { pattern: /^cmp\s/, reason: "File comparison (byte)" },
  { pattern: /^git\s+(status|log|diff|show|branch|remote)(\s|$)/, reason: "Git read-only" },
  { pattern: /^git\s+ls-files/, reason: "Git list files" },
  { pattern: /^npm\s+(test|run\s+test|run\s+lint)(\s|$)/, reason: "Test/lint execution" },
  { pattern: /^node\s+--version/, reason: "Version check" },
  { pattern: /^python3?\s+--version/, reason: "Version check" },

  // --- 2026-05-25 expansion: scratch/staging + path + read-only inspection ---
  // Directory / scratch creation. Non-destructive (mkdir fails on an existing
  // file; touch updates mtime / makes an empty file but never truncates;
  // mktemp creates a fresh name). The friction these remove is the
  // build-staging / scratch-dir workflow that previously hit review.
  { pattern: /^mkdir(\s|$)/, reason: "Create directory (non-destructive)" },
  { pattern: /^touch\s/, reason: "Create empty file / update mtime (non-destructive)" },
  { pattern: /^mktemp(\s|$)/, reason: "Create temp file/dir under TMPDIR" },
  // Pure path string-ops (no filesystem writes).
  { pattern: /^basename\s/, reason: "Path basename (string op)" },
  { pattern: /^dirname\s/, reason: "Path dirname (string op)" },
  { pattern: /^realpath(\s|$)/, reason: "Resolve path (read-only)" },
  { pattern: /^readlink\s/, reason: "Read symlink target (read-only)" },
  // Read-only text projection. `cut` and `jq` write only to stdout (no
  // output-file flag) — unlike sort -o / uniq OUT, which are deliberately
  // excluded above.
  { pattern: /^cut\s/, reason: "Column/field extraction (stdout only)" },
  { pattern: /^jq\s/, reason: "JSON query (stdout only; no in-place flag)" },
  // Read-only system / disk inspection. set-variants (date -s, hostname X)
  // require root the task doesn't have, so a bare invocation only reads.
  { pattern: /^date(\s|$)/, reason: "Read clock" },
  { pattern: /^whoami(\s|$)/, reason: "Current user" },
  { pattern: /^id(\s|$)/, reason: "User/group ids" },
  { pattern: /^uname(\s|$)/, reason: "Kernel/arch info" },
  { pattern: /^du(\s|$)/, reason: "Disk usage (read-only)" },
  { pattern: /^df(\s|$)/, reason: "Filesystem usage (read-only)" },
  { pattern: /^which\s/, reason: "Locate executable (read-only)" },
  { pattern: /^type\s/, reason: "Resolve command (read-only)" },
  // No-ops / control-flow helpers.
  { pattern: /^sleep\s/, reason: "Delay (no I/O)" },
  { pattern: /^(true|false)(\s|$)/, reason: "No-op" },

  // --- 2026-05-31: AWS identity introspection (read-only) ---
  // `aws sts get-caller-identity` returns {UserId, Account, Arn} and reads NO
  // secret material — it's the AWS `whoami` / canonical "am I authenticated?"
  // check, and was the single biggest judge-deny false positive (20 of 117
  // denies in one week touched it). `aws configure list-profiles` only lists
  // profile names. Optional leading AWS_* env assignments (`AWS_REGION=`,
  // `AWS_PROFILE=`) are tolerated; any other aws verb, a non-AWS env prefix,
  // or a risky co-command falls through to review/deny (chained parts are
  // evaluated independently, so this never rescues an unsafe chain).
  { pattern: /^(?:AWS_[A-Z_]+=\S+\s+)*aws\s+sts\s+get-caller-identity(\s|$)/, reason: "AWS identity introspection (read-only; returns account/ARN, no secrets)" },
  { pattern: /^(?:AWS_[A-Z_]+=\S+\s+)*aws\s+configure\s+list-profiles(\s|$)/, reason: "List AWS profile names (read-only)" },
  // 2026-06-19: `aws configure get region` / `get output` return the
  // configured region / output format — NOT secrets — and pair with
  // get-caller-identity as the canonical "where am I?" preamble (this week's
  // judge-deny FP was exactly that chain). Anchored to `region`/`output`
  // ONLY: `aws configure get aws_secret_access_key` reads the actual secret
  // and MUST still fall through to review/deny.
  { pattern: /^(?:AWS_[A-Z_]+=\S+\s+)*aws\s+configure\s+get\s+(?:region|output)(\s|$)/, reason: "Read AWS region/output config (read-only; not a secret)" },

  // --- 2026-08-20: macOS keychain PRESENCE probes (read-only) ---
  // `security find-generic-password -s NAME` (and the -internet- variant)
  // print the item's ATTRIBUTES — class, service, account, timestamps — and
  // NOT the secret. Surfacing the stored password requires `-g` (dumps it to
  // stderr) or `-w` (stdout); without either flag the output contains zero
  // occurrences of "password:". `list-keychains` / `default-keychain` print
  // keychain FILE PATHS only. So these are existence checks ("is the token
  // configured on this machine?") — the keychain equivalent of
  // `aws sts get-caller-identity` — and they were the dominant judge-deny
  // false positive of the 2026-08 review (10 of 43 denies), with verdicts
  // wrongly asserting the command "extracts actual credential values".
  //
  // ANCHORING — this is what keeps the entry narrow, so read before editing:
  //  * Only four read-only subcommands are listed. The `security` BINARY is
  //    deliberately NOT blanket-allowed: dump-keychain, unlock-keychain,
  //    add-/delete-generic-password, export and import are all absent and
  //    keep falling through to review/deny.
  //  * The negative lookahead rejects the entire command if ANY token is a
  //    short/long flag whose letters include `g` or `w`. That covers `-g`,
  //    `-w`, `--g`, and clustered forms (`-gs`, `-sg`, `-wa`) — the obvious
  //    bypass — while leaving `-s`, `-a`, `-d`, `-c` untouched. It scans
  //    across newlines so a flag on a continuation line can't slip past.
  { pattern: /^security\s+(?![\s\S]*\s--?[A-Za-z]*[gw])(?:find-(?:generic|internet)-password|list-keychains|default-keychain)(?:\s|$)/, reason: "macOS keychain presence/attribute probe (read-only; printing the secret needs -g/-w, which this excludes)" },

  // --- 2026-08-21: clearing your OWN stalled build/test process ---
  // `kill -9` is denied wholesale below ("Force kill process"). That rule fires
  // on a dev-loop idiom with no security content — clearing a hung test runner
  // before re-running the suite:
  //
  //     pkill -9 -f flutter_tester; sleep 1; flutter test --concurrency=1 …
  //
  // Of 730 approval prompts shown to a human 2026-07-01..08-20, force-kill was
  // 59 (8.1%) and 57 of those were this exact shape.
  //
  // Killing a process is an AVAILABILITY action, outside the goal-hijack threat
  // model — except when the target would blind or unhook a defence, so this
  // deliberately allow-lists TARGETS, never `pkill` itself. `pkill -f sshd`,
  // `-f dredd`, `-f auditd` remain denied: that is evasion, not tidying.
  //
  // ANCHORING — read before widening:
  //  * Only the build/test tools actually observed, longest-alternative first
  //    so `flutter` cannot shadow `flutter_tester`. Adding a name here grants
  //    kill rights over every process whose command line starts with it.
  //  * `-f` is REQUIRED. `pkill -9 node` (bare name) and `pkill -u root` (kill
  //    by user) both fall through to the deny.
  //  * The pattern must be a LITERAL: `$`/backtick are excluded, so
  //    `pkill -f "$PROC"` cannot name an arbitrary process at run time.
  //  * The tool name must be the START of the pattern, so a crafted string
  //    cannot smuggle another target in front of it.
  //
  // NOTE: this lives OUTSIDE the allow list on purpose — see DEVTOOL_KILL_RE
  // below. The deny list is scanned before the allow list, and the deny rule
  // `/kill\s+-9/` matches `pkill -9` as a substring, so an allow-list entry
  // could never fire. It is applied as a pre-deny carve-out instead, exactly
  // like classifyRmCarveout.
];

/**
 * Clearing your OWN stalled build/test process — a pre-deny carve-out.
 *
 * Applied by tool-policy.ts BEFORE the deny list, at both the single-command
 * and chained-segment sites, because `/kill\s+-9/` matches the `kill -9`
 * substring inside `pkill -9` and deny beats allow.
 *
 * See the comment block above for the anchoring rationale and the list of what
 * this deliberately does NOT cover (sshd/auditd/dredd, bare `pkill NAME`,
 * `pkill -u`, `$VAR` patterns).
 */
export const DEVTOOL_KILL_RE =
  /^(?:pkill|killall)(?:\s+-(?:[0-9]+|[A-Za-z]+))*\s+-f\s+(?:"(?:flutter_tester|flutter_tools|flutter|tofu|terraform|gradle|dart)[^"$`]*"|'(?:flutter_tester|flutter_tools|flutter|tofu|terraform|gradle|dart)[^'$`]*'|(?:flutter_tester|flutter_tools|flutter|tofu|terraform|gradle|dart)[A-Za-z0-9_./-]*)\s*(?:2>\s*\S+)?$/;

// =========================================================================
// DENY LIST — always blocked, destructive or dangerous
// =========================================================================
export const DENIED_BASH_PATTERNS: PatternRule[] = [
  // Destructive filesystem operations.
  //
  // NOTE: `git rm` / `svn rm` / `hg rm` etc. (version-control removals,
  // which are staged and recoverable) are neutralised upstream in
  // `tool-policy.ts:sanitizeForMatching` BEFORE these patterns run — it
  // rewrites the `rm` subcommand token so the substring "rm -r" inside
  // "git rm -r" can't trip this hard deny. Confirmed false positive on
  // sessions 8eaf2d7f / 654fa809 (2026-05-20 + 05-23). Keep these
  // patterns simple; the VCS carve-out lives in one place upstream.
  { pattern: /\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r|--force|--recursive)/, reason: "Destructive rm with force/recursive flags" },
  { pattern: /\brm\s+-rf/, reason: "rm -rf" },
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

  // `find` action flags turn the allow-listed `^find` into a deletion /
  // arbitrary-exec primitive. REVIEW is checked before ALLOW, so these
  // route find-with-actions to the judge while plain `find` stays allowed.
  // (`find -exec rm -rf` is already DENY'd via the rm scan; this also
  // catches `find -delete` and `find -exec <anything>`.)
  { pattern: /\bfind\b.*\s-delete\b/, reason: "find -delete (mass deletion — judge intent)" },
  { pattern: /\bfind\b.*\s-exec(dir)?\b/, reason: "find -exec (runs arbitrary command)" },
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
