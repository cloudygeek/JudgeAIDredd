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
 *
 * The pattern tables themselves live in `policy-patterns.ts` so they
 * can be browsed independently of the engine logic. Re-exported here
 * for backwards compatibility with existing import sites.
 */

import {
  type PatternRule,
  ALLOWED_TOOLS,
  ALLOWED_BASH_PATTERNS,
  DENIED_BASH_PATTERNS,
  REVIEW_BASH_PATTERNS,
  SENSITIVE_FILE_PATTERNS,
  SENSITIVE_WRITE_PATTERNS,
} from "./policy-patterns.js";

export {
  ALLOWED_TOOLS,
  ALLOWED_BASH_PATTERNS,
  DENIED_BASH_PATTERNS,
  REVIEW_BASH_PATTERNS,
  SENSITIVE_FILE_PATTERNS,
  SENSITIVE_WRITE_PATTERNS,
};
export type { PatternRule };

export type PolicyDecision = "allow" | "deny" | "review";

export interface PolicyResult {
  decision: PolicyDecision;
  tool: string;
  reason: string;
  /** The matched rule that triggered this decision */
  matchedRule: string;
}


/**
 * Allow-listed command substitutions that are safe to embed in a git
 * commit/tag message. A substitution inside a commit message executes at
 * shell expansion time — before git sees the message — so each entry is
 * effectively "this command is OK to run as a side effect of committing."
 *
 * Extending the list: add a RegExp whose content matches the INNER text of
 * the substitution (between `$(...)` / backticks). Keep it narrow — the
 * whole point is that anything not on the list goes through the judge.
 */
const SAFE_COMMIT_SUBSTITUTIONS: RegExp[] = [
  // Dates / timestamps
  /^date(\s+[+][^;|&`$<>]*)?$/,         // date, date +%Y-%m-%d, etc.
  /^date\s+-u(\s+[+][^;|&`$<>]*)?$/,    // date -u +...
  /^date\s+--iso-8601(=\w+)?$/,         // date --iso-8601
  // Git metadata — safe because "git" is not the destructive surface
  /^git\s+rev-parse\s+(--short\s+)?HEAD$/,
  /^git\s+rev-parse\s+(--short\s+)?--verify\s+HEAD$/,
  /^git\s+describe(\s+--tags)?(\s+--always)?$/,
  /^git\s+rev-list\s+--count\s+HEAD$/,
  // Whoami / hostname
  /^whoami$/,
  /^hostname(\s+-\w+)?$/,
  // Version fields
  /^cat\s+VERSION$/,
];

/**
 * Does the text (already extracted from `$(...)` or backticks) match one of
 * the allow-listed safe substitutions? Used by the git-commit sanitiser.
 *
 * Special case: `cat <<'TAG' ... TAG` with a SINGLE-QUOTED heredoc delimiter
 * is equivalent to a literal multi-line string — the shell performs no
 * expansion inside the body. It's the canonical idiom for long commit
 * messages (`git commit -m "$(cat <<'EOF' … EOF)"`). We recognise the
 * shape here and treat it as safe regardless of body contents.
 */
function isSafeCommitSubstitution(inner: string): boolean {
  const trimmed = inner.trim();
  if (SAFE_COMMIT_SUBSTITUTIONS.some((re) => re.test(trimmed))) return true;
  // cat <<'TAG' \n ... \n TAG  — single-quoted tag disables expansion
  const safeHeredoc = /^cat\s+<<-?'(\w+)'\s*\n[\s\S]*\n\s*\1\s*$/;
  if (safeHeredoc.test(trimmed)) return true;
  return false;
}

/**
 * Extract every `$(...)` and `` `...` `` substitution from the commit-message
 * argument(s) of a git commit/tag command. Returns the inner contents.
 *
 * We only scan the portion of the command that is the commit MESSAGE so
 * that unrelated substitutions elsewhere in the command (e.g. in
 * `git commit --author=$(whoami)`) aren't swept by this check — they're
 * still inspected by the normal review rule for `$(` at the top level.
 */
function extractCommitMessageSubstitutions(command: string): string[] {
  const out: string[] = [];

  // Strip quoted-heredoc bodies (`<<'TAG'` / `<<"TAG"`) before any
  // extraction. The shell performs no expansion inside those bodies,
  // so `$()` and backticks within them are literal text — typically
  // markdown-style code formatting in a long commit message
  // (`commit -m "$(cat <<'EOF' ... \`npx tsx\` ... EOF)"`). Without
  // this strip step, the `-m "..."` extractor below pulls backticks
  // out of the heredoc body and the safety check rejects ordinary
  // commit-message prose. (Confirmed false-positive on session
  // 455e88d2, 2026-05-23.)
  //
  // We replace just the body, preserving the `<<TAG\n ... \nTAG`
  // shape so the outer `$(cat <<'TAG'…TAG)` substitution still
  // matches the safeHeredoc rule in isSafeCommitSubstitution.
  const stripped = command.replace(
    /(<<-?\s*['"](\w+)['"]\s*\n)[\s\S]*?(\n\s*\2)/g,
    (_, lead, _tag, trail) => `${lead}<msg-body-redacted>${trail}`,
  );

  // -m "..." / -m '...' — quoted message arg
  const mArgs = [
    ...stripped.matchAll(/\s-m\s+"((?:[^"\\]|\\.)*)"/g),
    ...stripped.matchAll(/\s-m\s+'((?:[^'\\]|\\.)*)'/g),
    ...stripped.matchAll(/\s-m=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g),
    ...stripped.matchAll(/\s--message=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g),
  ];
  for (const m of mArgs) {
    const body = m[1].replace(/^['"]|['"]$/g, "");
    // $( ... ) with simple nesting-free parens
    for (const sub of body.matchAll(/\$\(([^()]*)\)/g)) out.push(sub[1]);
    // backtick substitution
    for (const sub of body.matchAll(/`([^`]*)`/g)) out.push(sub[1]);
  }
  // Heredoc-fed messages: `git commit -F - <<EOF … EOF` with an
  // UNQUOTED tag — those DO undergo expansion, so we still extract
  // substitutions for the safety check. Quoted-tag heredocs were
  // already redacted above.
  const heredocs = stripped.matchAll(/<<-?\s*(\w+)\s*\n([\s\S]*?)\n\s*\1(?=\s|$)/g);
  for (const h of heredocs) {
    const body = h[2];
    for (const sub of body.matchAll(/\$\(([^()]*)\)/g)) out.push(sub[1]);
    for (const sub of body.matchAll(/`([^`]*)`/g)) out.push(sub[1]);
  }
  return out;
}

/**
 * Is `command` an invocation of `git <subcommand>` from the given list,
 * allowing for git's global flags (`-C <path>`, `-c key=val`, `--git-dir=`,
 * `--work-tree=`, `--no-pager`, etc.) between `git` and the subcommand?
 *
 * The previous version matched only `^git\s+(commit|tag)\b`, which misses
 * common forms like `git -C /path commit -m ...` — the `-C <path>` global
 * option comes before the subcommand. Without detection, sanitisation
 * below never fires and free-form commit message bodies are swept by
 * deny rules like `\benv\b` ("Dump environment").
 */
function isGitSubcommand(command: string, subcommands: readonly string[]): boolean {
  const trimmed = command.trim();
  if (!/^git(\s|$)/.test(trimmed)) return false;

  // Tokens after the literal "git". Simple whitespace split is fine here
  // because we're only scanning up to the first non-flag token; anything
  // past that (args, quoted messages, heredocs) doesn't matter for this
  // check.
  const tokens = trimmed.split(/\s+/).slice(1);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t.startsWith("-")) {
      return subcommands.includes(t);
    }
    // -C <path> and -c <key=val> take a value in the NEXT token when
    // no `=` is fused into the flag itself.
    if ((t === "-C" || t === "-c") && !t.includes("=")) {
      i += 2; continue;
    }
    // Long options: `--long=value` is self-contained; `--long value`
    // requires the next token. We conservatively assume bare long
    // flags are boolean and skip only 1 token — worst case this over-
    // consumes nothing and we find the subcommand one token later.
    i += 1;
  }
  return false;
}

/**
 * Git commit/tag messages are free-form text that often legitimately contains
 * strings like destructive-delete commands or bare words like "env var" when
 * describing a change. Those are payload, not executable — but naive regex
 * matching over the raw command trips deny rules on them. This strips the
 * message body (returning a placeholder) so pattern matching sees only the
 * actual invocation.
 *
 * Only applied to `git commit` / `git tag`; every other command is returned
 * unchanged so heredoc bodies (e.g. `bash <<EOF ... EOF`) still deny on
 * dangerous content.
 */
function sanitizeForMatching(command: string): string {
  // VCS removals first: `git rm`, `svn rm`, `hg rm`, `jj rm`, `bzr rm`
  // are version-control operations — the removal is staged and fully
  // recoverable via the VCS, not the destructive filesystem `rm`. Rewrite
  // the `rm` subcommand token to a placeholder so the destructive-rm deny
  // patterns in policy-patterns.ts can't match the "rm -r" substring.
  // Handles intervening global flags (`git -C /path rm -r`, `git -c k=v
  // rm …`). Confirmed false positive on sessions 8eaf2d7f / 654fa809.
  const vcsNeutralised = command.replace(
    // VCS verb, then any run of global flags — including git's
    // value-taking globals `-C <path>` / `-c <key=val>` (space-separated
    // value), `=`-fused long opts, and boolean short/long flags — then
    // the `rm` subcommand.
    /\b(git|svn|hg|jj|bzr)((?:\s+-[Cc]\s+\S+|\s+-[A-Za-z][\w-]*(?:=\S+)?|\s+--[\w-]+(?:=\S+)?)*)\s+rm\b/g,
    "$1$2 vcs-removal",
  );

  if (!isGitSubcommand(vcsNeutralised, ["commit", "tag"])) return vcsNeutralised;

  let s = vcsNeutralised;
  // -m "..." / -m '...' — quoted message arg.
  s = s.replace(/\s-m\s+"(?:[^"\\]|\\.)*"/g, ' -m "<msg>"');
  s = s.replace(/\s-m\s+'(?:[^'\\]|\\.)*'/g, " -m '<msg>'");
  // --message="..." / --message='...' / --message=bare
  s = s.replace(/\s--message=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g, " --message=<msg>");
  // -m=... variants.
  s = s.replace(/\s-m=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g, " -m=<msg>");
  // Heredoc bodies: <<EOF ... EOF / <<-EOF ... EOF / <<'EOF' ... EOF
  //
  // NOTE: we deliberately do NOT strip `$(...)` or backticks anywhere. They
  // execute at shell expansion time, before git even runs — so they are
  // commands, not message prose. `checkCommitMessageSubstitutions` evaluates
  // them against SAFE_COMMIT_SUBSTITUTIONS ahead of this sanitiser; anything
  // that got past that is either safe or the command has already been denied.
  s = s.replace(/<<-?\s*(['"]?)(\w+)\1\s*\n[\s\S]*?\n\2\s*/g, "<<$2\n<msg>\n$2\n");

  return s;
}

/**
 * For `git commit` / `git tag`: enforce the rule that command substitutions
 * inside the message body are only allowed if they match the
 * SAFE_COMMIT_SUBSTITUTIONS list. Returns a deny result if any substitution
 * is not on the list, null if the command is fine (or isn't a git commit).
 */
function checkCommitMessageSubstitutions(command: string): SingleBashResult | null {
  if (!isGitSubcommand(command, ["commit", "tag"])) return null;
  const subs = extractCommitMessageSubstitutions(command);
  if (subs.length === 0) return null;
  for (const s of subs) {
    if (!isSafeCommitSubstitution(s)) {
      return {
        decision: "deny",
        reason: `Unsafe command substitution in git commit message: \`${s.substring(0, 60)}\``,
        matchedRule: "DENY:Bash:commit-msg-subst-unsafe",
        command,
      };
    }
  }
  return null;
}

/**
 * Split `command` on top-level chain operators (`&&`, `||`, `;`, `|`) while
 * treating heredoc bodies, command substitutions, backticks, and quoted
 * strings as opaque tokens.
 *
 * A naive `command.split(/&&|\|\||;|\|/)` finds chain operators inside
 * quoted strings and heredoc bodies — which is wrong. For example:
 *
 *   git commit -m "$(cat <<'EOF'
 *   add foo && bar
 *   EOF
 *   )"
 *
 * has exactly one top-level command. The naive splitter sees "&&" inside
 * the heredoc body and yields two parts, neither of which is a valid git
 * invocation, which causes sanitisation to fail downstream.
 *
 * Approach: extract heredoc blocks, `$(...)` and backtick substitutions,
 * and double/single-quoted strings into placeholders so the splitter sees
 * only real top-level chain operators. After splitting, re-inject the
 * placeholders into whichever part they came from.
 */
export function splitChainedSafely(command: string): string[] {
  const placeholders: Array<{ key: string; content: string }> = [];
  let s = command;

  // The order matters: heredocs first (they can span newlines and contain
  // everything else), then command substitutions (which can contain quoted
  // strings), then backticks, then plain quoted strings.
  const replace = (re: RegExp, prefix: string) => {
    s = s.replace(re, (match) => {
      const key = `\0${prefix}${placeholders.length}\0`;
      placeholders.push({ key, content: match });
      return key;
    });
  };

  // Heredocs: <<WORD / <<-WORD / <<'WORD' / <<"WORD" ... WORD
  // The terminator must be on its own line, optionally indented for <<-.
  replace(/<<(-?)(['"]?)(\w+)\2([\s\S]*?\n)\s*\3(?=\s|$)/g, "H");

  // $(...) substitution — balance is approximate (no nesting).
  replace(/\$\([^()]*\)/g, "S");

  // `...` backtick substitution.
  replace(/`[^`]*`/g, "B");

  // "..." / '...' quoted strings.
  replace(/"(?:[^"\\]|\\.)*"/g, "D");
  replace(/'(?:[^'\\]|\\.)*'/g, "Q");

  // Join shell line-continuations (`\<newline>` is a single logical line)
  // so a wrapped command isn't shredded into meaningless fragments.
  s = s.replace(/\\\r?\n/g, " ");

  // Now split on top-level chain operators AND newlines. A bare newline is
  // a command separator in bash, so a multi-line script must be split the
  // same as `;`-separated commands — otherwise the whole blob is evaluated
  // as one "command", the anchored per-command carve-outs (e.g. the /tmp
  // rm carve-out, which matches `^rm`) never fire, and an unanchored deny
  // pattern matches a substring anywhere in the blob. Heredoc bodies and
  // quoted strings were masked above, so their internal newlines are safe.
  const parts = s.split(/\s*(?:&&|\|\||;|\|)\s*|[\r\n]+/).filter(Boolean);

  // Re-inject placeholders. Placeholders are unique and never overlap
  // with user content (contain NUL bytes), so a plain replace is safe.
  return parts.map((p) => {
    let reconstructed = p;
    // Iterate until no more placeholders — handles nested extractions
    // where a heredoc placeholder itself contains a quoted placeholder.
    let changed = true;
    while (changed) {
      changed = false;
      for (const { key, content } of placeholders) {
        if (reconstructed.includes(key)) {
          reconstructed = reconstructed.split(key).join(content);
          changed = true;
        }
      }
    }
    return reconstructed.trim();
  });
}

/**
 * Does the command contain a top-level chain operator?
 * Mirror of `splitChainedSafely` but yes/no — used to early-exit the
 * unchained carve-outs without paying the cost of full tokenisation.
 */
function hasTopLevelChain(command: string): boolean {
  return splitChainedSafely(command).length > 1;
}

/**
 * Narrow carve-out for `rm` / `rmdir` with destructive flags: the command
 * is allowed when every path target sits under /tmp/ (or the literal path
 * is /tmp itself is NOT allowed — that would wipe the whole tmpdir).
 * Returns false for anything that isn't an rm invocation so callers can
 * safely use it as a guard.
 */
function isRmLimitedToTmp(command: string): boolean {
  const trimmed = command.trim();
  // Match: rm [flags...] <targets...>   (no leading tokens before rm)
  const m = /^rm(?:\s+-[a-zA-Z]+|\s+--[a-zA-Z-]+(?:=\S+)?)*\s+(.+)$/.exec(trimmed);
  if (!m) return false;

  // Tokenise the target list. We intentionally don't handle quoted paths
  // with embedded spaces — those hit the normal deny path. Glob chars in
  // the target disqualify (rm -rf /tmp/foo/* is fine because /tmp/foo/*
  // still starts with /tmp/; but rm -rf /* or $HOME/* is not).
  const tail = m[1].trim();
  const targets = tail.split(/\s+/).filter(t => !t.startsWith("-"));
  if (targets.length === 0) return false;

  for (const t of targets) {
    // Reject shell metacharacters that could expand outside /tmp.
    if (/[$`(){}]/.test(t)) return false;
    // Strip surrounding quotes if any.
    const unquoted = t.replace(/^['"]/, "").replace(/['"]$/, "");
    // Must be an absolute path under /tmp/ (not bare /tmp).
    if (!/^\/tmp\/\S/.test(unquoted)) return false;
    // Block exact /tmp or attempts to escape via /tmp/../...
    if (unquoted === "/tmp" || unquoted === "/tmp/") return false;
    if (unquoted.includes("/..")) return false;
  }
  return true;
}

/**
 * Narrow carve-out for non-recursive `rm -f <literal-path>`. Idempotent
 * "delete if present" is the canonical cleanup pattern in build scripts
 * (e.g. `rm -f some-artifact.zip` before rebuilding) and on its own is
 * not what the `rm -f` deny rule was added to stop. The deny rule still
 * catches `rm -rf`, `rm -fr`, and any force-delete with a wildcard,
 * variable, tilde, or path traversal in the target.
 *
 * Rules:
 *   - Must be exactly `rm` with flags that include `f`/`force` but NOT
 *     `r`/`R`/`recursive`/`--dir`/`-d` (no recursion, no directories).
 *   - Exactly one target. Multiple targets fall through — if you want
 *     to delete many things, say so explicitly and go through review.
 *   - Target must be a literal path: no `*`, `?`, `[`, `$`, backtick,
 *     `~`, `..`, no trailing `/`, no shell metacharacters.
 *   - Target must NOT be absolute (e.g. /etc/...) unless under /tmp/;
 *     the existing `isRmLimitedToTmp` already covers the /tmp case.
 */
function isRmForceSingleLiteralFile(command: string): boolean {
  const trimmed = command.trim();
  // Split into the rm call and its tokens.
  const m = /^rm((?:\s+-[a-zA-Z]+|\s+--[a-zA-Z-]+(?:=\S+)?)*)\s+(\S+)\s*$/.exec(trimmed);
  if (!m) return false;

  const flagBlock = m[1];
  const target = m[2];

  // Tokenise the flag block so short-flag clusters (-rf) and long flags
  // (--force) are checked independently; otherwise the `r` at the end of
  // "--force" falsely triggers the recursive check.
  const tokens = flagBlock.trim().split(/\s+/).filter(Boolean);
  let hasForce = false;
  let hasRecursive = false;
  let hasDir = false;
  for (const tok of tokens) {
    if (tok.startsWith("--")) {
      if (tok === "--force") hasForce = true;
      else if (tok === "--recursive") hasRecursive = true;
      else if (tok === "--dir") hasDir = true;
    } else if (tok.startsWith("-")) {
      // Short-flag cluster like "-rf": inspect each letter.
      for (const ch of tok.slice(1)) {
        if (ch === "f") hasForce = true;
        else if (ch === "r" || ch === "R") hasRecursive = true;
        else if (ch === "d") hasDir = true;
      }
    }
  }
  if (!hasForce || hasRecursive || hasDir) return false;

  // Reject dangerous patterns in the target.
  if (/[*?\[\]$`(){}~]/.test(target)) return false;      // globs, vars, subshells, home
  if (target.includes("..")) return false;                // path traversal
  if (target.endsWith("/")) return false;                 // directory-looking
  if (target === "." || target === "..") return false;

  // Absolute paths: only allowed under /tmp/ via the other carve-out.
  // Everything else in absolute-path land (e.g. /etc/passwd) falls through
  // to the deny list.
  if (target.startsWith("/") && !/^\/tmp\/\S/.test(target)) return false;

  return true;
}

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
  // Commit-message substitution check runs FIRST so an unsafe `$()` in a
  // commit message denies even when the rest of the sanitised form would
  // otherwise pass. The allow-list is narrow; extend SAFE_COMMIT_SUBSTITUTIONS
  // to broaden it.
  const commitSub = checkCommitMessageSubstitutions(command);
  if (commitSub) return commitSub;

  // Narrow carve-outs: allow destructive delete when every target is under
  // /tmp/, or when the command is a non-recursive `rm -f <literal-file>`.
  // Build-scratch workflows (zip staging, artifact cleanup) need these; the
  // path / shape checks stop them becoming a general bypass.
  if (isRmLimitedToTmp(command)) {
    return { decision: "allow", reason: "rm under /tmp/", matchedRule: "ALLOW:Bash:rm-tmp", command };
  }
  if (isRmForceSingleLiteralFile(command)) {
    return {
      decision: "allow",
      reason: "rm -f of a single literal file (non-recursive)",
      matchedRule: "ALLOW:Bash:rm-f-literal",
      command,
    };
  }

  // Match rules against the sanitized command (commit-message bodies
  // stripped); the returned `command` and reason still use the original.
  const matchTarget = sanitizeForMatching(command);

  // Deny list
  for (const rule of DENIED_BASH_PATTERNS) {
    if (rule.pattern.test(matchTarget)) {
      return { decision: "deny", reason: rule.reason, matchedRule: `DENY:Bash:${rule.pattern}`, command };
    }
  }

  // Review triggers (but skip the chaining patterns — we already split)
  for (const rule of REVIEW_BASH_PATTERNS) {
    // Skip the &&, ||, ; rules since we already split on those
    if (rule.reason.includes("chaining")) continue;
    if (rule.pattern.test(matchTarget)) {
      return { decision: "review", reason: rule.reason, matchedRule: `REVIEW:Bash:${rule.pattern}`, command };
    }
  }

  // Allow list
  for (const rule of ALLOWED_BASH_PATTERNS) {
    if (rule.pattern.test(matchTarget)) {
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
 * Return a "review" result for a write that lands outside the project sandbox.
 * Used for both file-write tools and bash redirect targets.
 */
function sandboxReview(tool: string, path: string, projectRoot: string): PolicyResult {
  const isDotClaude = path.includes("/.claude/");
  return {
    decision: "review",
    tool,
    reason: isDotClaude
      ? `.claude/ write outside project root — judge required`
      : `Write outside project sandbox (${projectRoot}) — judge required`,
    matchedRule: isDotClaude
      ? "REVIEW:sandbox:dot-claude"
      : "REVIEW:sandbox:out-of-project",
  };
}

/**
 * Check whether an absolute path is outside the project sandbox.
 * Returns a sandbox review result if so, null if the path is within bounds.
 */
function checkSandbox(
  tool: string,
  filePath: string,
  projectRoot: string | null | undefined
): PolicyResult | null {
  if (!projectRoot || !filePath.startsWith("/")) return null;
  if (filePath.startsWith(projectRoot)) return null;
  return sandboxReview(tool, filePath, projectRoot);
}

/**
 * Extract the write target from a bash redirect expression (> path or >> path).
 * Returns null if no redirect to an absolute path is found.
 */
function extractRedirectTarget(command: string): string | null {
  const m = command.match(/>>?\s*(\/[^\s;|&]+)/);
  return m ? m[1] : null;
}

/**
 * Evaluate a tool call against the policy.
 */
export function evaluateToolPolicy(
  tool: string,
  input: Record<string, unknown>,
  projectRoot?: string | null
): PolicyResult {
  // --- Built-in tool: Bash ---
  if (tool === "Bash") {
    const command = String(input.command ?? "").trim();

    // Narrow carve-outs before the deny-list sweep:
    //   1. rm -rf is OK if every target is under /tmp/.
    //   2. rm -f <literal-file> (non-recursive, single target) is a common
    //      idempotent cleanup and is safe without recursion.
    // Unchained only; chained commands fall through to per-part evaluation
    // which applies the same carve-outs. `hasTopLevelChain` uses the
    // heredoc/quote-aware splitter so chain operators inside quoted strings
    // or heredoc bodies don't fool us into taking the chained path.
    const unchained = !hasTopLevelChain(command);
    if (unchained && isRmLimitedToTmp(command)) {
      return {
        decision: "allow",
        tool,
        reason: "rm under /tmp/",
        matchedRule: "ALLOW:Bash:rm-tmp",
      };
    }
    if (unchained && isRmForceSingleLiteralFile(command)) {
      return {
        decision: "allow",
        tool,
        reason: "rm -f of a single literal file (non-recursive)",
        matchedRule: "ALLOW:Bash:rm-f-literal",
      };
    }

    // Commit-message substitution gate (unchained path). For chained
    // commands this runs per-part inside `evaluateSingleBashCommand`.
    if (unchained) {
      const commitSub = checkCommitMessageSubstitutions(command);
      if (commitSub) {
        return {
          decision: "deny",
          tool,
          reason: commitSub.reason,
          matchedRule: commitSub.matchedRule,
        };
      }
    }

    // Carve-out checks come first in the unchained path so that narrow
    // exceptions (rm -rf /tmp/..., rm -f literal-file) can short-circuit
    // before the deny list sees the raw `rm -rf` substring. Otherwise
    // `rm -rf /tmp/foo` matches the destructive-rm deny rule and never
    // reaches isRmLimitedToTmp. The chained path doesn't have this issue
    // because evaluateSingleBashCommand runs the carve-outs first per
    // segment.
    if (unchained) {
      if (isRmLimitedToTmp(command)) {
        return {
          decision: "allow",
          tool,
          reason: "rm under /tmp/",
          matchedRule: "ALLOW:Bash:rm-tmp",
        };
      }
      if (isRmForceSingleLiteralFile(command)) {
        return {
          decision: "allow",
          tool,
          reason: "rm -f of a single literal file (non-recursive)",
          matchedRule: "ALLOW:Bash:rm-f-literal",
        };
      }
    }

    // Check deny list first against the FULL command (highest priority).
    // Use the sanitized view so git commit/tag message bodies don't trigger
    // deny rules on free-form descriptive text.
    //
    // Only applied to unchained commands. For chained commands we fall
    // through to per-part evaluation so that narrow carve-outs (e.g.
    // `rm -rf /tmp/...` or `rm -f <literal>`) can match on each segment —
    // a full-command sweep would otherwise short-circuit on the raw `rm -f`
    // substring before the chain splitter ever runs.
    const matchTarget = sanitizeForMatching(command);
    if (unchained) {
      for (const rule of DENIED_BASH_PATTERNS) {
        if (rule.pattern.test(matchTarget)) {
          return {
            decision: "deny",
            tool,
            reason: rule.reason,
            matchedRule: `DENY:Bash:${rule.pattern}`,
          };
        }
      }
    }

    // Sandbox: if the command writes to an absolute path outside the project, review
    if (projectRoot) {
      const redirectTarget = extractRedirectTarget(command);
      if (redirectTarget) {
        const sandboxResult = checkSandbox(tool, redirectTarget, projectRoot);
        if (sandboxResult) return sandboxResult;
      }
    }

    // If command is chained (&&, ||, ;, |), split and evaluate each part.
    // Use the heredoc/quote-aware splitter so chain operators inside a
    // commit-message heredoc or quoted argument don't get treated as
    // top-level separators.
    if (!unchained) {
      const parts = splitChainedSafely(command);

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

    // Sandbox: writes outside the project root go straight to judge
    const sandboxResult = checkSandbox(tool, filePath, projectRoot);
    if (sandboxResult) return sandboxResult;

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
