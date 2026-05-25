/**
 * credential-flow.ts — taint analysis of a Bash command.
 *
 * Answers: which credential SOURCES (a file read as a secret, a cookie
 * jar, a -u credential, an inline auth token) reach which network SINKS
 * (the host a curl/wget talks to)?
 *
 * This is the resolver behind "(principal, target)" approval consent.
 * The principal is the credential's SOURCE IDENTITY (e.g. the path
 * `~/.claude/dredd/api-key`), not a hash of its value — so it survives
 * key rotation and makes "a different secret to an approved host"
 * detectable. The target is the exact host.
 *
 * It exists because the original `approval-fingerprint.ts` curl
 * fingerprinter resolves only literal `VAR=value` and is blind to the
 * forms agents actually emit:
 *   - `KEY=$(cat ~/.claude/dredd/api-key); curl -H "Authorization: Bearer $KEY" H`
 *   - `curl -H "Authorization: Bearer $(cat ~/.claude/dredd/api-key)" H`
 *   - `cat ~/.claude/dredd/api-key | curl --data-binary @- H`
 * All three are the same logical principal→target and must fingerprint
 * identically (when the host matches).
 *
 * SAFETY: the analysis is fail-safe toward RE-PROMPTING. When unsure
 * whether a credential reaches a sink, we INCLUDE it — a superfluous
 * principal only makes the fingerprint more specific (→ re-ask), never
 * less. Raw secret bytes never leave this module: inline literals are
 * hashed (`value:<sha256[:16]>`); file/cookie/basic sources keep only a
 * path or username, which are not the secret.
 */

import { createHash } from "node:crypto";
import { isSensitiveEnvVar } from "./sensitive-env.js";

export type CredentialSource =
  | { kind: "file"; id: string }
  | { kind: "cookie"; id: string }
  | { kind: "basic"; id: string }
  | { kind: "value"; id: string };

export interface NetworkAccess {
  /** curl and wget both normalise to "curl" — the transport doesn't
   *  change the (principal, target) identity. */
  verb: "curl";
  host: string | null;
  /** Sorted + deduped credential sources reaching this sink. */
  principals: CredentialSource[];
}

export interface CommandFlow {
  network: NetworkAccess[];
}

/** Stable string key for a source — used for dedup, sort, and as the
 *  human-readable token in summaries. */
export function sourceKey(s: CredentialSource): string {
  return `${s.kind}:${s.id}`;
}

function hashValue(v: string): string {
  return createHash("sha256").update(v).digest("hex").slice(0, 16);
}

// ---- tokenizer -------------------------------------------------------------

type Segment = string[]; // argv of one pipeline stage
type Statement = Segment[]; // a pipeline (segments joined by `|`)

/** Tokenise into statements → pipeline segments → argv.
 *
 *  - statement separators: `;`, newline, `&&`, `||`
 *  - `|` separates pipeline segments WITHIN a statement (so taint can
 *    flow from an upstream `cat` to a downstream `curl`)
 *  - `$( … )` / backticks are grouped (internal whitespace preserved) so
 *    an UNQUOTED `$(cat path)` is one token, not `$(cat` + `path)`
 *  - quoted strings preserve internal whitespace (one token)
 *
 *  Quote/group-aware but does not expand substitutions or heredocs — an
 *  ambiguous parse only costs a re-prompt, never a security hole. */
export function tokenize(cmd: string): Statement[] {
  const statements: Statement[] = [];
  let stmt: Statement = [];
  let seg: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  let subst = 0; // paren depth inside $( … )
  let btick = false;

  const flushTok = () => { if (buf) { seg.push(buf); buf = ""; } };
  const flushSeg = () => { flushTok(); if (seg.length) { stmt.push(seg); seg = []; } };
  const flushStmt = () => { flushSeg(); if (stmt.length) { statements.push(stmt); stmt = []; } };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (quote) { if (ch === quote) quote = null; else buf += ch; continue; }
    if (btick) { buf += ch; if (ch === "`") btick = false; continue; }
    if (subst > 0) { buf += ch; if (ch === "(") subst++; else if (ch === ")") subst--; continue; }

    if (ch === "$" && cmd[i + 1] === "(") { buf += "$("; subst = 1; i++; continue; }
    if (ch === "`") { buf += "`"; btick = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "\\" && i + 1 < cmd.length) { buf += cmd[++i]; continue; }

    if (ch === "\n" || ch === ";") { flushStmt(); continue; }
    if (ch === "&" && cmd[i + 1] === "&") { flushStmt(); i++; continue; }
    if (ch === "|" && cmd[i + 1] === "|") { flushStmt(); i++; continue; }
    if (ch === "|") { flushSeg(); continue; }
    if (/\s/.test(ch)) { flushTok(); continue; }

    buf += ch;
  }
  flushStmt();
  return statements;
}

// ---- source extraction -----------------------------------------------------

/** A file path read as a secret via `$(cat P)`, `$(< P)`, `` `cat P` ``.
 *  Returns the path token(s) found in an arbitrary string. */
function fileSubstPaths(s: string): string[] {
  const out: string[] = [];
  const re = /(?:\$\(\s*(?:cat|<)\s+([^\s)]+)|`\s*cat\s+([^\s`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const p = (m[1] ?? m[2] ?? "").replace(/^["']|["']$/g, "");
    if (p) out.push(p);
  }
  return out;
}

const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Resolve all credential sources implied by an arbitrary string value,
 *  given the variable→source map collected from earlier assignments.
 *  Used for `-H` header values, `-d` bodies, etc. */
function sourcesFromValue(
  value: string,
  varSource: Map<string, CredentialSource>,
): CredentialSource[] {
  const out: CredentialSource[] = [];
  for (const p of fileSubstPaths(value)) out.push({ kind: "file", id: p });

  let m: RegExpExecArray | null;
  VAR_REF_RE.lastIndex = 0;
  while ((m = VAR_REF_RE.exec(value))) {
    const name = m[1] ?? m[2];
    const src = varSource.get(name);
    if (src) out.push(src);
  }
  return out;
}

const AUTH_HEADER_RE =
  /^(?:authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token):\s*(.+)$/i;

// ---- variable / host expansion ---------------------------------------------

/** Expand `$VAR` / `${VAR}` using only literal values (for resolving a
 *  host). Unknown vars are left intact so they can't collapse to "". */
function expandLiteral(token: string, varValue: Map<string, string>): string {
  return token.replace(VAR_REF_RE, (whole, braced, bare) => {
    const v = varValue.get(braced ?? bare);
    return v !== undefined ? v : whole;
  });
}

function extractUrl(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--url" && i + 1 < argv.length) return argv[i + 1];
    if (t === "-u" || t === "--user") { i++; continue; }
    if (/^https?:\/\//.test(t)) return t;
  }
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

// ---- analysis --------------------------------------------------------------

const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

function collectAssignments(statements: Statement[]): {
  varSource: Map<string, CredentialSource>;
  varValue: Map<string, string>;
} {
  const varSource = new Map<string, CredentialSource>();
  const varValue = new Map<string, string>();

  for (const stmt of statements) {
    for (const seg of stmt) {
      // Only a leading run of assignments at a segment start counts.
      for (const tok of seg) {
        const m = ASSIGN_RE.exec(tok);
        if (!m) break;
        const [, name, rhsRaw] = m;
        const rhs = rhsRaw.replace(/^["']|["']$/g, "");

        const fileSrcs = fileSubstPaths(rhs);
        const refSrcs = sourcesFromValue(rhs, varSource);
        if (fileSrcs.length) {
          varSource.set(name, { kind: "file", id: fileSrcs[0] });
        } else if (refSrcs.length) {
          varSource.set(name, refSrcs[0]);
        } else if (!/[$`]/.test(rhs)) {
          varValue.set(name, rhs);
          if (isSensitiveEnvVar(name, rhs)) {
            varSource.set(name, { kind: "value", id: hashValue(rhs) });
          }
        }
      }
    }
  }
  return { varSource, varValue };
}

/** Credential sources of one curl/wget segment, plus any upstream
 *  `cat <path>` piped into it. */
function principalsForCurl(
  seg: Segment,
  upstreamCatPaths: string[],
  varSource: Map<string, CredentialSource>,
): CredentialSource[] {
  const out: CredentialSource[] = [];

  // A pipe `cat secret | curl …` taints the curl with that file.
  for (const p of upstreamCatPaths) out.push({ kind: "file", id: p });

  for (let i = 1; i < seg.length; i++) {
    const t = seg[i];

    if ((t === "-H" || t === "--header") && i + 1 < seg.length) {
      const header = seg[++i];
      const hm = AUTH_HEADER_RE.exec(header);
      if (hm) {
        const val = hm[1].trim();
        const srcs = sourcesFromValue(val, varSource);
        if (srcs.length) out.push(...srcs);
        else out.push({ kind: "value", id: hashValue(val) });
      }
    } else if ((t === "-b" || t === "--cookie") && i + 1 < seg.length) {
      const arg = seg[++i];
      // `-b name=value` is an inline cookie string; `-b file` is a jar.
      if (arg.includes("=")) out.push({ kind: "value", id: hashValue(arg) });
      else out.push({ kind: "cookie", id: arg });
    } else if ((t === "-u" || t === "--user") && i + 1 < seg.length) {
      const user = seg[++i].split(":")[0];
      out.push({ kind: "basic", id: user });
    } else if (/^(?:--data(?:-binary|-raw)?|-d)$/.test(t) && i + 1 < seg.length) {
      const body = seg[++i];
      for (const p of fileSubstPaths(body)) out.push({ kind: "file", id: p });
      out.push(...sourcesFromValue(body, varSource));
      // `@-` consumes stdin; the upstream cat (handled above) is the source.
    } else {
      // A bare token may itself carry a substitution, e.g. `"$(cat p)"`.
      for (const p of fileSubstPaths(t)) out.push({ kind: "file", id: p });
    }
  }
  return out;
}

function dedupeSort(sources: CredentialSource[]): CredentialSource[] {
  const seen = new Map<string, CredentialSource>();
  for (const s of sources) seen.set(sourceKey(s), s);
  return [...seen.values()].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
}

export function analyzeCommand(command: string): CommandFlow {
  const statements = tokenize(String(command ?? ""));
  const { varSource, varValue } = collectAssignments(statements);
  const network: NetworkAccess[] = [];

  for (const stmt of statements) {
    // Paths read by any `cat` upstream in this pipeline taint the
    // downstream curl (the `cat secret | curl @-` exfil/auth shape).
    const upstreamCatPaths: string[] = [];
    for (const seg of stmt) {
      // strip a leading run of assignments to find the real argv[0]
      let k = 0;
      while (k < seg.length && ASSIGN_RE.test(seg[k]) && !/[$`]/.test(seg[k])) k++;
      const argv = seg.slice(k);
      if (argv.length === 0) continue;

      const verb = argv[0];
      if (verb === "curl" || verb === "wget") {
        const principals = principalsForCurl(argv, upstreamCatPaths, varSource);
        const url = extractUrl(argv);
        const host = url ? hostOf(expandLiteral(url, varValue)) : null;
        network.push({ verb: "curl", host, principals: dedupeSort(principals) });
      } else if (verb === "cat") {
        for (let j = 1; j < argv.length; j++) {
          if (!argv[j].startsWith("-")) upstreamCatPaths.push(argv[j]);
        }
      }
    }
  }
  return { network };
}

// ---- fingerprint -----------------------------------------------------------

/** Fingerprint-shape version. Bumped when the curl shape changes so old
 *  stored approvals (different shape → different hash) are simply never
 *  matched and age out via TTL, rather than colliding. */
export const CREDENTIAL_FP_VERSION = 2;

export interface NetworkFingerprint {
  shape: { verb: "curl"; host: string; principals: string[] };
  summary: string;
  /** Stable pre-image of the hash — stored as the approval's
   *  fingerprintJson for audit + pattern-trust embedding. */
  fingerprintJson: string;
  hash: string;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as object).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",") + "}";
}

/** (principal, target) fingerprint for a Bash command. Picks the network
 *  call that carries credentials (the one transmitting a principal);
 *  falls back to the first call that resolves a host. Returns null when
 *  no host resolves (caller treats as "no network approval to record"). */
export function fingerprintNetwork(command: string): NetworkFingerprint | null {
  const { network } = analyzeCommand(command);
  const access =
    network.find((n) => n.host && n.principals.length > 0) ??
    network.find((n) => n.host) ??
    null;
  if (!access || !access.host) return null;

  const principals = access.principals.map(sourceKey);
  const shape = { verb: "curl" as const, host: access.host, principals };
  const summary = principals.length
    ? `curl to ${access.host} with credential ${principals.join(", ")}`
    : `curl to ${access.host} (no credential)`;
  const fingerprintJson = stableStringify({ tool: "Bash", shape });
  return {
    shape,
    summary,
    fingerprintJson,
    hash: createHash("sha256").update(fingerprintJson).digest("hex"),
  };
}
