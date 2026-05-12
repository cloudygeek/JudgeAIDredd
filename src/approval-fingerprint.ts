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

function fingerprintBash(input: Record<string, unknown>): Fingerprint | null {
  const cmd = String(input.command ?? "").trim();
  if (!cmd) return null;
  const tokens = tokeniseShell(cmd);
  if (tokens.length === 0) return null;

  // Skip leading env-var assignments (e.g. `FOO=bar curl …`).
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return null;

  if (tokens[i] === "curl") return fingerprintCurl(tokens.slice(i));
  return fingerprintGenericBash(tokens.slice(i));
}

/** curl gets host + auth-hash only — no path, no method, no body. One
 *  approval covers an entire integration (one host + one key). */
function fingerprintCurl(argv: string[]): Fingerprint | null {
  const url = extractCurlUrl(argv);
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }

  const authToken = extractAuthToken(argv);
  const authHash = authToken
    ? createHash("sha256").update(authToken).digest("hex").slice(0, 16)
    : null;

  return {
    tool: "Bash",
    shape: { verb: "curl", host, auth_hash: authHash },
    summary: authHash
      ? `curl to ${host} with API key ${authHash.slice(0, 8)}…`
      : `curl to ${host} (no auth header)`,
  };
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

/** Extract the Authorization header value from a curl argv. Returns
 *  the raw value (e.g. "Bearer sk_test_xxx") for hashing — we hash the
 *  whole string so that "Bearer X" and "Basic Y" with the same X are
 *  distinct. */
function extractAuthToken(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if ((t === "-H" || t === "--header") && i + 1 < argv.length) {
      const header = argv[i + 1];
      const m = /^Authorization:\s*(.+)$/i.exec(header);
      if (m) return m[1].trim();
      i++;
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

/** Very small shell-style tokeniser that respects single + double
 *  quotes. Doesn't handle backticks, $(), nested quotes, or escapes
 *  exhaustively — good enough for fingerprinting curl invocations as
 *  Claude tends to emit them. If the parse is ambiguous the fingerprint
 *  will just be slightly different from a hand-rolled one; the worst
 *  case is "approval doesn't fire next time", not a security issue. */
function tokeniseShell(cmd: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        buf += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "\\" && i + 1 < cmd.length) {
      buf += cmd[++i];
    } else if (/\s/.test(c)) {
      if (buf) { out.push(buf); buf = ""; }
    } else {
      buf += c;
    }
  }
  if (buf) out.push(buf);
  return out;
}
