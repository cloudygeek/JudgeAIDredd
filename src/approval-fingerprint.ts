/**
 * Approval fingerprinting.
 *
 * Produces a stable identifier for a tool call so that "I already
 * approved this shape of action" can be checked deterministically.
 *
 * Per-tool fingerprinters are intentionally conservative on what they
 * include in the fingerprint shape — narrow enough that small semantic
 * changes (different host, different file) yield different
 * fingerprints, but loose enough that re-prompting on irrelevant
 * variation (HTTP method, query string) doesn't drive users mad.
 *
 * Hard constraint: no raw secrets ever land in a fingerprint. The curl
 * fingerprinter hashes the Authorization token and keeps only a 16-hex
 * truncation — enough to recognise "same key as last time", not enough
 * to recover the key.
 */

import { createHash } from "node:crypto";

export interface Fingerprint {
  tool: string;
  /** Canonical shape — keys must serialise deterministically. */
  shape: Record<string, unknown>;
  /** Human-readable one-liner for the dashboard + ask-prompt
   *  transparency text. Never contains secrets. */
  summary: string;
}

/** Compute a fingerprint for a tool call. Returns null when the input
 *  is unparseable or we don't have a fingerprinter for this tool —
 *  callers treat null as "don't record an approval for this one". */
export function computeFingerprint(
  tool: string,
  input: Record<string, unknown>,
): Fingerprint | null {
  if (tool === "Bash") return fingerprintBash(input);
  if (tool === "Edit" || tool === "Write") return fingerprintFileWrite(tool, input);
  if (tool === "WebFetch") return fingerprintWebFetch(input);
  if (tool.startsWith("mcp__")) return fingerprintMcp(tool, input);
  return null;
}

/** Stable JSON stringify with sorted keys, then sha256 hex. */
export function hashFingerprint(fp: Fingerprint): string {
  return createHash("sha256").update(stableStringify({ tool: fp.tool, shape: fp.shape })).digest("hex");
}

export function fingerprintJson(fp: Fingerprint): string {
  return stableStringify({ tool: fp.tool, shape: fp.shape });
}

// ---- Bash fingerprinter ---------------------------------------------------

/** Shell statement separators we split on for fingerprinting. A newline
 *  is a statement separator in bash, equivalent to `;`. */
const STATEMENT_OPERATORS = new Set([";", "&&", "||", "|", "\n"]);
/** Verbs that carry no security-relevant identity on their own — a
 *  leading one of these must NOT mask a network call later in the chain
 *  (the `echo "..."; curl http://evil` shape). */
const NOISE_VERBS = new Set([
  "echo", "cd", "pwd", "true", "false", ":", "printf", "export", "set", "ls",
]);

function fingerprintBash(input: Record<string, unknown>): Fingerprint | null {
  const cmd = String(input.command ?? "").trim();
  if (!cmd) return null;

  // Split into statements on top-level operators (incl. newlines). This
  // is the fix for the `echo "..."; curl …` shape: the old fingerprinter
  // looked only at the first token of the whole command, so a leading
  // echo produced a host-blind generic fingerprint that then auto-allowed
  // a curl to ANY host. Splitting lets us find the curl wherever it sits.
  const statements = splitStatements(cmd);
  if (statements.length === 0) return null;

  // Collect VAR=value assignments across the whole command so that a
  // later `curl "${URL}?…"` / `-H "x-api-key: $KEY"` can be resolved to
  // the real host + key before hashing. Assignments are only valid at a
  // statement start, so we read each statement's leading run of them.
  const env: Record<string, string> = {};
  for (const st of statements) {
    for (const tok of st) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tok);
      if (m) env[m[1]] = m[2];
      else break;
    }
  }

  // Reduce each statement to argv after its leading env assignments.
  const cmds = statements
    .map((st) => {
      let i = 0;
      while (i < st.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(st[i])) i++;
      return st.slice(i);
    })
    .filter((a) => a.length > 0);
  if (cmds.length === 0) return null;

  // Network sub-commands are the security-relevant surface. Among any
  // curl/wget calls in the chain, prefer one that carries an auth token
  // (that's the call transmitting a credential); fall back to the first
  // that at least resolves to a host.
  const netCmds = cmds.filter((a) => a[0] === "curl" || a[0] === "wget");
  let firstHostful: Fingerprint | null = null;
  for (const a of netCmds) {
    const fp = fingerprintCurl(a, env);
    if (!fp) continue;
    if ((fp.shape as { auth_hash?: string | null }).auth_hash) return fp;
    if (!firstHostful) firstHostful = fp;
  }
  if (firstHostful) return firstHostful;

  // No network call: fingerprint the first meaningful (non-noise)
  // statement, falling back to the very first if all are noise.
  const meaningful = cmds.find((a) => !NOISE_VERBS.has(a[0])) ?? cmds[0];
  return fingerprintGenericBash(meaningful);
}

/** curl/wget gets host + auth-hash only — no path, no method, no body.
 *  One approval covers an entire integration (one host + one key).
 *  `env` lets us resolve `${VAR}` references assigned earlier in the
 *  same command so a variable URL / key still pins a concrete host. */
function fingerprintCurl(argv: string[], env: Record<string, string> = {}): Fingerprint | null {
  const expanded = argv.map((t) => expandEnv(t, env));
  const url = extractCurlUrl(expanded);
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }

  const authToken = extractAuthToken(expanded);
  const authHash = authToken
    ? createHash("sha256").update(authToken).digest("hex").slice(0, 16)
    : null;

  return {
    tool: "Bash",
    // verb kept as "curl" for both curl and wget so an approval survives
    // a curl→wget swap to the same host+key; the host+auth_hash are the
    // identity that matters.
    shape: { verb: "curl", host, auth_hash: authHash },
    summary: authHash
      ? `curl to ${host} with API key ${authHash.slice(0, 8)}…`
      : `curl to ${host} (no auth header)`,
  };
}

/** Expand `$VAR` and `${VAR}` references using assignments collected from
 *  the same command. Unknown variables are left as-is (so they won't
 *  accidentally resolve to empty and produce a bogus host). */
function expandEnv(token: string, env: Record<string, string>): string {
  return token.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, braced, bare) => {
      const name = braced ?? bare;
      return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : whole;
    },
  );
}

/** Tokenise into statements, splitting on top-level `;` `&&` `||` `|` and
 *  newlines while respecting single/double quotes. Returns one string[]
 *  (argv) per statement. Quote-aware but does NOT expand `$(...)` /
 *  heredocs — good enough for fingerprinting the curl invocations Claude
 *  emits; an ambiguous parse only means "approval re-prompts", never a
 *  security hole. */
function splitStatements(cmd: string): string[][] {
  const statements: string[][] = [];
  let cur: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  const flushTok = () => { if (buf) { cur.push(buf); buf = ""; } };
  const flushStmt = () => { flushTok(); if (cur.length) { statements.push(cur); cur = []; } };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else buf += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "\\" && i + 1 < cmd.length) { buf += cmd[++i]; continue; }
    if (c === "\n" || c === ";") { flushStmt(); continue; }
    if (c === "&" && cmd[i + 1] === "&") { flushStmt(); i++; continue; }
    if (c === "|" && cmd[i + 1] === "|") { flushStmt(); i++; continue; }
    if (c === "|") { flushStmt(); continue; }
    if (/\s/.test(c)) { flushTok(); continue; }
    buf += c;
  }
  flushStmt();
  return statements;
}

/** Generic bash: argv[0..2]. Wide enough to differentiate `git status`
 *  from `git push`, narrow enough that `git status -s` still matches
 *  `git status`. argv beyond index 2 is ignored. */
function fingerprintGenericBash(argv: string[]): Fingerprint {
  const truncated = argv.slice(0, 3);
  return {
    tool: "Bash",
    shape: { argv: truncated },
    summary: truncated.join(" "),
  };
}

/** Find the first http(s) URL in a curl argv. Handles `--url <u>` and
 *  bare URL positional. Skips `-u user:pass` basic-auth arg, which is
 *  NOT a URL despite the flag name. */
function extractCurlUrl(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--url" && i + 1 < argv.length) return argv[i + 1];
    if (t === "-u" || t === "--user") { i++; continue; } // skip user:pass
    if (/^https?:\/\//.test(t)) return t;
  }
  return null;
}

/** Extract a credential header value from a curl argv. Recognises the
 *  common auth header shapes — `Authorization:` (Bearer/Basic) plus the
 *  API-key family (`x-api-key:`, `api-key:`, `apikey:`, `x-auth-token:`).
 *  Returns the raw value for hashing — we hash the whole string so that
 *  "Bearer X" and "Basic Y" with the same X are distinct. Only the
 *  16-hex truncation of the hash is ever persisted (see fingerprintCurl);
 *  the raw secret never leaves this function.
 *
 *  Also recognises curl's own credential flags: `-u user:pass` /
 *  `--user`, and `-H`/`--header`. */
const AUTH_HEADER_RE =
  /^(?:authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token):\s*(.+)$/i;

function extractAuthToken(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if ((t === "-H" || t === "--header") && i + 1 < argv.length) {
      const header = argv[i + 1];
      const m = AUTH_HEADER_RE.exec(header);
      if (m) return m[1].trim();
      i++;
    } else if ((t === "-u" || t === "--user") && i + 1 < argv.length) {
      // Basic-auth credential pair — hash it the same way.
      return `basic:${argv[i + 1]}`;
    }
  }
  return null;
}

// ---- File-write fingerprinter ---------------------------------------------

function fingerprintFileWrite(tool: string, input: Record<string, unknown>): Fingerprint | null {
  const path = String(input.file_path ?? "");
  if (!path) return null;
  return {
    tool,
    shape: { file_path: path },
    summary: `${tool} ${path}`,
  };
}

// ---- WebFetch fingerprinter -----------------------------------------------

function fingerprintWebFetch(input: Record<string, unknown>): Fingerprint | null {
  const url = String(input.url ?? "");
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      tool: "WebFetch",
      shape: { host: u.hostname, path: u.pathname },
      summary: `WebFetch ${u.hostname}${u.pathname}`,
    };
  } catch {
    return null;
  }
}

// ---- MCP fingerprinter ----------------------------------------------------

/** Generic for any `mcp__*` tool: tool name + sorted top-level input
 *  keys. Per-tool whitelists can replace this once we know which MCP
 *  args are stable identifiers vs. volatile payload. */
function fingerprintMcp(tool: string, input: Record<string, unknown>): Fingerprint {
  const inputKeys = Object.keys(input).sort();
  return {
    tool,
    shape: { tool, input_keys: inputKeys },
    summary: `${tool}(${inputKeys.join(",")})`,
  };
}

// ---- helpers --------------------------------------------------------------

/** Stable JSON.stringify — keys sorted at every depth so the same
 *  object always serialises to the same string regardless of insertion
 *  order. Used to make fingerprint hashes deterministic across processes. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as object).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",") + "}";
}
