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
  | { kind: "value"; id: string }
  /** Sinks v2: the ambient AWS identity an `aws` CLI call runs as —
   *  `profile:<name>` (from --profile / AWS_PROFILE) or `env:default`.
   *  Resolved syntactically; no file is read and none is claimed. A
   *  distinct kind so it can never merge with file-source principals. */
  | { kind: "aws"; id: string };

export interface NetworkAccess {
  /** curl and wget both normalise to "curl" — the transport doesn't
   *  change the (principal, target) identity. Sinks v2 adds "aws"
   *  (target = service:region[:bucket], not a hostname) and
   *  "inline-http" (an HTTPS literal inside `python -c` / `node -e`). */
  verb: "curl" | "aws" | "inline-http";
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

    // Substitution consumption runs FIRST: a `$(…)` opened inside double
    // quotes must keep paren-counting until it closes — if the quote
    // branch ran first it would eat the closing paren as plain string
    // content and the substitution would never terminate.
    if (subst > 0) { buf += ch; if (ch === "(") subst++; else if (ch === ")") subst--; continue; }
    if (quote) {
      // Inside DOUBLE quotes, `$(…)` opens its own quoting context in
      // bash — `"X: $(python -c 'print(open("/k").read())')"` is one
      // string whose inner double quotes belong to the substitution.
      // Group it with paren counting (quote survives; when the subst
      // closes we fall back into the same double-quoted string).
      if (quote === '"' && ch === "$" && cmd[i + 1] === "(") { buf += "$("; subst = 1; i++; continue; }
      if (ch === quote) quote = null; else buf += ch;
      continue;
    }
    if (btick) { buf += ch; if (ch === "`") btick = false; continue; }

    if (ch === "$" && cmd[i + 1] === "(") { buf += "$("; subst = 1; i++; continue; }
    // Process substitution `<(cmd)` groups like `$(cmd)` — without this,
    // whitespace splits `<(cat P)` into `<(cat` + `P)` and no pattern can
    // see the read (phase 3, resolver gaps).
    if (ch === "<" && cmd[i + 1] === "(") { buf += "<("; subst = 1; i++; continue; }
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

/** A file path read as a secret via `$(cat P)`, `$(< P)` / `$(<P)`,
 *  `` `cat P` ``, `<(cat P)` process substitution, or an interpreter
 *  one-liner's `open("P").read()`. Returns the path token(s) found in an
 *  arbitrary string.
 *
 *  The `open(…).read()` form is deliberately narrow (phase 3): a literal
 *  quoted path immediately `.read()` — write-mode opens and computed
 *  paths stay unmatched and fail safe. */
function fileSubstPaths(s: string): string[] {
  const out: string[] = [];
  const re = /(?:[$<]\(\s*(?:cat\s+|<\s*)([^\s)]+)|`\s*cat\s+([^\s`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const p = (m[1] ?? m[2] ?? "").replace(/^["']|["']$/g, "");
    if (p) out.push(p);
  }
  const openRe = /open\(\s*["']([^"']+)["']\s*\)\s*\.\s*read\s*\(/g;
  while ((m = openRe.exec(s))) {
    if (m[1]) out.push(m[1]);
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

/**
 * Expand `$VAR` / `${VAR}` references against the collected assignments,
 * repeatedly until nothing more resolves.
 *
 * A single pass is not enough: the common shape is a URL held in one variable
 * whose value references another —
 *
 *   REGION=eu-west-1
 *   URL="https://svc.$REGION.amazonaws.com/x"
 *   curl "$URL"
 *
 * — where one pass yields `https://svc.$REGION.amazonaws.com/x`, which is not a
 * parseable host, so the whole fingerprint came back null and the user was
 * re-asked on every call.
 *
 * Unresolvable references are deliberately left as-is rather than blanked; the
 * caller treats a residual `$` as "no host", so an unknown variable fails safe
 * to a re-ask instead of inventing a host that can never match again.
 *
 * MAX_PASSES bounds `A=$B; B=$A` and self-reference; the loop also stops early
 * as soon as a pass changes nothing.
 */
const MAX_EXPAND_PASSES = 8;

function expandLiteral(token: string, varValue: Map<string, string>): string {
  let out = token;
  for (let pass = 0; pass < MAX_EXPAND_PASSES; pass++) {
    const next = out.replace(VAR_REF_RE, (whole, braced, bare) => {
      const v = varValue.get(braced ?? bare);
      return v !== undefined ? v : whole;
    });
    if (next === out) return out;
    out = next;
  }
  return out;
}

/**
 * Find curl/wget's target URL.
 *
 * Each candidate token is EXPANDED before the http(s) test, because the target
 * is very often held in a shell variable (`URL="https://…"; curl "$URL"`) and a
 * bare `$URL` token never matches a literal-URL pattern. Without expanding
 * first, those calls resolved no host at all — measured at 77% of denied
 * credential-bearing network calls (2026-08-20).
 *
 * A token whose expansion still contains `$` is skipped rather than returned:
 * a half-expanded host is not a real host, and keying an approval on one
 * produces a pair that can never legitimately match again. Two live prod
 * approvals were stored against `bedrock-runtime.$r.amazonaws.com` before this.
 */
function extractUrl(argv: string[], varValue: Map<string, string>): string | null {
  const resolve = (t: string): string | null => {
    const e = expandLiteral(t, varValue);
    // Note: a residual `$` is NOT rejected here. It is only fatal when it
    // lands in the HOSTNAME — `hostOf` makes that call. An unresolved variable
    // in the path or query (`.../model/$MID/converse`, a `for MID in …` loop
    // variable) leaves the host perfectly well-defined, and rejecting those
    // cost real fingerprints.
    return /^https?:\/\//.test(e) ? e : null;
  };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--url" && i + 1 < argv.length) return resolve(argv[i + 1]);
    if (t === "-u" || t === "--user") { i++; continue; }
    const hit = resolve(t);
    if (hit) return hit;
  }
  return null;
}

function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    // An unexpanded variable in the HOSTNAME is refused, because such a key is
    // host-family consent by the back door: an approval stored against
    // `bedt${n}.aisandbox.dev.ckotech.internal` matches every value of `n`, and
    // `bedrock-runtime.$r.amazonaws.com` matches every AWS region. Both were
    // live in jaid-approvals. The locked design is "target = EXACT host, never
    // host-family" (reaffirmed 2026-08-20: approving bedt4 must not imply
    // bedt5), so a host we cannot pin is not a target we can consent to.
    //
    // Cost, accepted deliberately: a loop over hosts whose variable cannot be
    // resolved now yields no fingerprint and re-asks each time. That is the
    // safe direction — a re-ask, never a wildcard allow.
    //
    // A `$` elsewhere in the URL (path, query) is fine and deliberately
    // allowed: `.../model/$MID/converse` leaves the host fully determined.
    if (h.includes("$")) return null;
    return h;
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
        } else if (!/\$\(|`/.test(rhs)) {
          // Store the literal RHS. Plain `$VAR` / `${VAR}` references are
          // ALLOWED here — expandLiteral resolves them on a later pass, which
          // is what makes `REGION=…; URL="https://svc.$REGION…"; curl "$URL"`
          // resolve a host at all. Command substitution (`$(…)` / backticks)
          // stays excluded: its value is a command's OUTPUT, not a literal, so
          // recording it as one would be wrong — and the credential branches
          // above have already claimed the substitution cases that matter.
          varValue.set(name, rhs);
          // Sensitivity is only meaningful for a FULLY literal value; a string
          // still containing `$` is a template, not a secret, and hashing it
          // would key on the template text rather than the credential.
          if (!/[$`]/.test(rhs) && isSensitiveEnvVar(name, rhs)) {
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
      // A bare token may itself carry a substitution, e.g. `"$(cat p)"` —
      // including the URL itself: `curl "https://h/api?key=$(cat P)"`.
      for (const p of fileSubstPaths(t)) out.push({ kind: "file", id: p });
      // …or reference a credential-assigned variable in the URL query
      // (`KEY=$(cat P); curl "https://h/x?key=$KEY"`). Previously only
      // header/body args resolved var refs, so a credential smuggled via
      // the query string produced a principal-less pair (phase 3 gap).
      out.push(...sourcesFromValue(t, varSource));
    }
  }
  return out;
}

function dedupeSort(sources: CredentialSource[]): CredentialSource[] {
  const seen = new Map<string, CredentialSource>();
  for (const s of sources) seen.set(sourceKey(s), s);
  return [...seen.values()].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
}

// ---- sinks v2: aws CLI -----------------------------------------------------

/** Global aws-CLI flags whose value is the NEXT token — skipped when
 *  looking for the positional service/operation. */
const AWS_VALUE_FLAGS = new Set([
  "--profile", "--region", "--endpoint-url", "--output", "--query",
  "--cli-connect-timeout", "--cli-read-timeout", "--color", "--ca-bundle",
]);

/** (principal, target) of an `aws <service> <op>` segment, sinks v2.
 *
 *  Principal = the ambient AWS identity, resolved syntactically:
 *  `profile:<name>` from --profile (or an AWS_PROFILE assignment in the
 *  command), else `env:default`. Target = `<service>:<region>` — region
 *  from --region, else an AWS_REGION/AWS_DEFAULT_REGION assignment, else
 *  "default" — plus the bucket for S3 (`s3:<region>:<bucket>`): bucket is
 *  the blast-radius unit there. Other services deliberately get NO
 *  per-resource component — per-resource splintering is the re-ask
 *  disease this feature treats. */
function awsAccess(
  argv: string[],
  varValue: Map<string, string>,
): NetworkAccess | null {
  let profile: string | null = null;
  let region: string | null = null;
  let service: string | null = null;
  let bucket: string | null = null;

  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--profile" && i + 1 < argv.length) { profile = expandLiteral(argv[++i], varValue); continue; }
    if (t === "--region" && i + 1 < argv.length) { region = expandLiteral(argv[++i], varValue); continue; }
    if (t === "--bucket" && i + 1 < argv.length) { bucket = expandLiteral(argv[++i], varValue); continue; }
    if (AWS_VALUE_FLAGS.has(t)) { i++; continue; }
    if (t.startsWith("-")) continue;
    if (service === null) { service = t.toLowerCase(); continue; }
    // s3 URIs anywhere in the args pin the bucket.
    const e = expandLiteral(t, varValue);
    const s3m = /^s3:\/\/([^/\s]+)/.exec(e);
    if (s3m && !bucket) bucket = s3m[1];
  }
  if (!service) return null;

  profile = profile ?? varValue.get("AWS_PROFILE") ?? null;
  region = region ?? varValue.get("AWS_REGION") ?? varValue.get("AWS_DEFAULT_REGION") ?? null;

  // An unresolved `$` in any identity component is refused for the same
  // reason hostOf refuses `$` hostnames: a template is not a target.
  const dirty = (v: string | null) => v !== null && /[$`]/.test(v);
  if (dirty(profile) || dirty(region) || dirty(bucket) || /[$`]/.test(service)) return null;

  const isS3 = service === "s3" || service === "s3api";
  const target = isS3 && bucket
    ? `s3:${region ?? "default"}:${bucket}`
    : `${service}:${region ?? "default"}`;
  const principal: CredentialSource = {
    kind: "aws",
    id: profile ? `profile:${profile}` : "env:default",
  };
  return { verb: "aws", host: target, principals: [principal] };
}

// ---- sinks v2: inline HTTP (python -c / node -e / ruby -e) -----------------

const INLINE_INTERPRETERS = new Set(["python", "python3", "node", "ruby"]);
const INLINE_CODE_FLAGS = new Set(["-c", "-e"]);
const HTTPS_LITERAL_RE = /https?:\/\/[^\s"'`\\)>,;]+/g;

/** First pinnable HTTPS-literal host inside an interpreter one-liner's
 *  program text. Literal extraction only — the program is never parsed;
 *  a host we cannot see fails safe to the legacy fingerprint (re-ask). */
function inlineHttpAccess(
  argv: string[],
  upstreamCatPaths: string[],
  varSource: Map<string, CredentialSource>,
): NetworkAccess | null {
  let program: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    if (INLINE_CODE_FLAGS.has(argv[i]) && i + 1 < argv.length) { program = argv[i + 1]; break; }
  }
  if (!program) return null;

  let host: string | null = null;
  let m: RegExpExecArray | null;
  HTTPS_LITERAL_RE.lastIndex = 0;
  while ((m = HTTPS_LITERAL_RE.exec(program))) {
    const h = hostOf(m[0]);
    // hostOf refuses `$`-contaminated hostnames, but interpreter string
    // templates use other markers — a Python f-string `https://{host}/x`
    // parses to hostname "{host}". Only a plain DNS-charset hostname is
    // a literal we can pin; anything else fails safe to the legacy path.
    if (h && /^[a-z0-9.-]+$/.test(h)) { host = h; break; }
  }
  if (!host) return null;

  const principals: CredentialSource[] = [];
  for (const p of upstreamCatPaths) principals.push({ kind: "file", id: p });
  for (const p of fileSubstPaths(program)) principals.push({ kind: "file", id: p });
  principals.push(...sourcesFromValue(program, varSource));
  return { verb: "inline-http", host, principals: dedupeSort(principals) };
}

export interface AnalyzeOpts {
  /** DREDD_CONSENT_SINKS_V2_ENABLED — aws CLI + inline-HTTP sinks. Off
   *  (default) is byte-identical to the curl-only analysis. */
  sinksV2?: boolean;
}

export function analyzeCommand(command: string, opts: AnalyzeOpts = {}): CommandFlow {
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
        const url = extractUrl(argv, varValue);
        // extractUrl already expanded and rejected anything with a residual
        // `$`, so `url` is a fully-resolved literal by this point.
        const host = url ? hostOf(url) : null;
        network.push({ verb: "curl", host, principals: dedupeSort(principals) });
      } else if (opts.sinksV2 && verb === "aws") {
        const a = awsAccess(argv, varValue);
        if (a) network.push(a);
      } else if (opts.sinksV2 && INLINE_INTERPRETERS.has(verb)) {
        const a = inlineHttpAccess(argv, upstreamCatPaths, varSource);
        if (a) network.push(a);
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
  shape:
    | { verb: "curl"; host: string; principals: string[] }
    /** Sinks v2. ADDITIVE verbs only — the curl shape above is
     *  byte-identical with the flag on or off, so every pre-existing
     *  curl approval keeps matching (no CREDENTIAL_FP_VERSION bump). */
    | { verb: "aws" | "inline-http"; host: string; principals: string[] }
    | { verb: "ssh" | "scp" | "rsync"; host: string; cmd: string };
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
export function fingerprintNetwork(
  command: string,
  opts: AnalyzeOpts = {},
): NetworkFingerprint | null {
  const { network } = analyzeCommand(command, opts);
  const access =
    network.find((n) => n.host && n.principals.length > 0) ??
    network.find((n) => n.host) ??
    null;
  if (access && access.host) {
    const principals = access.principals.map(sourceKey);
    const shape = { verb: access.verb, host: access.host, principals };
    const summary =
      access.verb === "aws"
        ? `aws ${access.host} as ${principals.join(", ") || "env:default"}`
        : principals.length
          ? `${access.verb} to ${access.host} with credential ${principals.join(", ")}`
          : `${access.verb} to ${access.host} (no credential)`;
    return finalizeNetworkFingerprint(shape, summary);
  }

  // No curl/wget egress — try remote-exec verbs (ssh/scp/rsync). These pin
  // (verb, exact host, full command) so a user's approval to run a specific
  // thing on a specific host is exempt from the intent-drift backstop, while a
  // hijack to a different host OR a different remote command yields a different
  // fingerprint and is re-checked.
  return fingerprintRemoteExec(command);
}

function finalizeNetworkFingerprint(
  shape: NetworkFingerprint["shape"],
  summary: string,
): NetworkFingerprint {
  const fingerprintJson = stableStringify({ tool: "Bash", shape });
  return {
    shape,
    summary,
    fingerprintJson,
    hash: createHash("sha256").update(fingerprintJson).digest("hex"),
  };
}

// ---- remote-exec (ssh / scp / rsync) host pinning --------------------------

const REMOTE_EXEC_VERBS = new Set(["ssh", "scp", "rsync"]);

/** Single-letter ssh options whose VALUE is the following SEPARATE token (so
 *  the first positional after them is the host, not the value). Attached forms
 *  like `-p22` / `-oFoo=bar` carry their value in the same token. */
const SSH_VALUE_FLAGS = new Set("BbcDEeFIiJLlmOopQRSWw".split(""));

function normHost(h: string): string | null {
  const x = h.trim().toLowerCase().replace(/\.$/, "");
  return x.length ? x : null;
}

/** `[user@]host` → host (drop any `user@` prefix). */
function stripUser(token: string): string {
  return token.includes("@") ? token.slice(token.lastIndexOf("@") + 1) : token;
}

/** Host of an scp/rsync remote spec: `[user@]host:path`, `host::module`, or
 *  `rsync://[user@]host/…`. Returns null for a local path or a flag value. */
function remoteSpecHost(token: string): string | null {
  const url = /^(?:rsync|ssh|scp):\/\/(?:[^@/]+@)?([^/:]+)/i.exec(token);
  if (url) return normHost(url[1]);
  const m = /^(?:[^@:/\s]+@)?([A-Za-z0-9._-]+):(?!\/\/)/.exec(token);
  return m ? normHost(m[1]) : null;
}

/** The remote target host of an ssh/scp/rsync argv, or null. ssh: the first
 *  positional after the options. scp/rsync: the first `host:path` spec. */
function remoteHost(verb: string, argv: string[], varValue: Map<string, string>): string | null {
  if (verb === "ssh") {
    for (let i = 1; i < argv.length; i++) {
      const t = argv[i];
      if (t.startsWith("-")) {
        if (t.length === 2 && SSH_VALUE_FLAGS.has(t[1])) i++; // skip a separate value token
        continue;
      }
      return normHost(stripUser(expandLiteral(t, varValue)));
    }
    return null;
  }
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("-")) continue;
    const h = remoteSpecHost(expandLiteral(t, varValue));
    if (h) return h;
  }
  return null;
}

/** Host-pinned fingerprint for an ssh/scp/rsync command — (verb, host, hash of
 *  the full command). Only the EXACT approved command to the EXACT host is
 *  drift-exempt; a different host or remote command re-hashes → re-checked.
 *  Returns null when no remote host resolves (caller falls back to the generic
 *  Bash fingerprint — unchanged behaviour). */
function fingerprintRemoteExec(command: string): NetworkFingerprint | null {
  const statements = tokenize(command);
  const { varValue } = collectAssignments(statements);
  for (const stmt of statements) {
    for (const seg of stmt) {
      let k = 0;
      while (k < seg.length && ASSIGN_RE.test(seg[k]) && !/[$`]/.test(seg[k])) k++;
      const argv = seg.slice(k);
      if (argv.length === 0) continue;
      const verb = argv[0];
      if (!REMOTE_EXEC_VERBS.has(verb)) continue;
      const host = remoteHost(verb, argv, varValue);
      if (!host) continue;
      const shape = { verb: verb as "ssh" | "scp" | "rsync", host, cmd: hashValue(argv.join(" ")) };
      return finalizeNetworkFingerprint(shape, `${verb} to ${host}`);
    }
  }
  return null;
}
