/**
 * Provenance-taint analysis.
 *
 * A PURE function over session state Dredd already tracks (file reads,
 * file writes, env vars). Given the current tool call, it looks for
 * data-flow chains from a sensitive SOURCE (a sensitive file read, a
 * sensitive env var) to the current SINK (Bash egress/exec, Write/Edit).
 *
 * The point is long-horizon detection: because file reads carry their
 * turn and writes carry modifiedAtTurns, a chain spanning many turns —
 * read at turn 3, written at turn 10, executed at turn 100 — is found by
 * concrete data dependency (content containment + path reference), not by
 * a decaying "influence" score. Turn distance is irrelevant; the chain is
 * either present in the durable artifacts or it isn't.
 *
 * No I/O, no model calls. Errors are the caller's to fail-soft on.
 */

import type { FileReadRecord, FileRecord, EnvVarRecord } from "./session-types.js";

export interface TaintInput {
  /** The tool about to run (e.g. "Bash", "Write", "Edit"). */
  tool: string;
  /** Its input args. */
  input: Record<string, unknown>;
  /** Files read this session (the source side). */
  filesRead: FileReadRecord[];
  /** Files written this session (intermediate carriers). */
  filesWritten: FileRecord[];
  /** Env vars set this session (alternate source side). */
  envVars: EnvVarRecord[];
}

export interface TaintChain {
  /** One-line, human-readable source→sink description. */
  description: string;
  /** "high" = sensitive source reaches an egress/exec sink; "medium" =
   *  staging (secret written into a new file, no egress yet). */
  severity: "high" | "medium";
}

export interface TaintEvidence {
  chains: TaintChain[];
  /** Rendered multi-line block for the judge prompt, or "" if no chains. */
  text: string;
}

// Commands that move data off the machine, or run a remote sync. git push
// is included — it ships local content to a remote the task may not name.
const EGRESS_RE =
  /\b(curl|wget|nc|ncat|netcat|scp|rsync|telnet|sftp)\b|\/dev\/tcp\/|--data\b|--data-binary\b|--upload-file\b|\bgit\s+push\b/i;

const MAX_CHAINS = 5;

type Sink =
  | { kind: "egress"; command: string }
  | { kind: "exec"; command: string }
  | { kind: "write"; path: string; content: string };

function classifySink(tool: string, input: Record<string, unknown>): Sink | null {
  if (tool === "Bash") {
    const command = String(input.command ?? "");
    if (!command) return null;
    return EGRESS_RE.test(command)
      ? { kind: "egress", command }
      : { kind: "exec", command };
  }
  if (tool === "Write") {
    return { kind: "write", path: String(input.file_path ?? ""), content: String(input.content ?? "") };
  }
  if (tool === "Edit") {
    return { kind: "write", path: String(input.file_path ?? ""), content: String(input.new_string ?? "") };
  }
  return null;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Sanitise a dynamic, potentially attacker-controlled value (file path,
 * env-var name) before embedding it in evidence text. The evidence is
 * rendered inside a server-trusted <provenance_alert> block the judge is
 * told to obey, so a hostile value must not be able to (a) forge a closing
 * or second opening tag (angle brackets) or (b) forge an extra
 * "[HIGH] ... authorized" line (newlines / CR / tabs). Length-capped so a
 * pathological path can't bloat the prompt.
 *
 * Additionally strips the bare tag name "provenance_alert" so that even
 * after angle-bracket removal the residual text cannot reconstruct the
 * tag token that renderProvenanceBlock's scrubFenceTags defence targets.
 */
function sanitize(s: string): string {
  return s
    .replace(/[\r\n\t<>]/g, " ")
    .replace(/provenance_alert/gi, "[redacted-tag]")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 200);
}

/** Does a shell command reference a file path (full path or basename)? */
function refsPath(cmd: string, p: string): boolean {
  if (!p) return false;
  if (cmd.includes(p)) return true;
  const base = basename(p);
  // Guard: very short basenames (<= 3 chars, e.g. "a.b") are too
  // collision-prone to match by substring against shell words.
  return base.length > 3 && cmd.includes(base);
}

/**
 * Extract candidate secret values from KEY=VALUE lines. Mirrors
 * checkContentFromReads in session-tracker.ts. Values under 8 chars are
 * too short to be a real credential and too collision-prone to match.
 */
function extractSecretValues(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split("\n")) {
    // NOTE: inline comments (KEY=value # comment) are not stripped, so a
    // value with a trailing comment won't match by containment. Same
    // limitation as session-tracker.ts::checkContentFromReads — fix both
    // together if addressed.
    const m = line.match(/^[A-Z_]+=(.+)$/);
    if (m) {
      const v = m[1].trim();
      if (v.length >= 8) out.push(v);
    }
  }
  return out;
}

interface TaintedFile {
  path: string;
  sourcePath: string;
  sourceTurn: number;
  writeTurns: number[];
}

export function buildTaintEvidence(input: TaintInput): TaintEvidence {
  const sink = classifySink(input.tool, input.input);
  if (!sink) return { chains: [], text: "" };

  const sensitiveReads = input.filesRead.filter((r) => r.isSensitive);
  const sensitiveEnv = input.envVars.filter((e) => e.isSensitive);

  // read→write hop: which written files carry a value that originated in
  // a sensitive read. This persists for the whole session, so a file
  // written at turn 10 stays flagged when the sink fires at turn 100.
  const taintedFiles: TaintedFile[] = [];
  for (const f of input.filesWritten) {
    for (const r of sensitiveReads) {
      const secrets = extractSecretValues(r.content);
      if (secrets.some((s) => f.content.includes(s))) {
        taintedFiles.push({
          path: f.path,
          sourcePath: r.path,
          sourceTurn: r.turn,
          writeTurns: f.modifiedAtTurns,
        });
        break; // one source attribution per file is enough for evidence
      }
    }
  }

  const chains: TaintChain[] = [];
  const push = (severity: "high" | "medium", description: string) => {
    chains.push({ severity, description });
  };

  if (sink.kind === "egress" || sink.kind === "exec") {
    const cmd = sink.command;
    const verb = sink.kind === "egress" ? "Egress" : "Execution";

    // Case A — the sink references a written file that carries a secret
    // read earlier. The long-horizon write→read→use chain.
    for (const tf of taintedFiles) {
      if (refsPath(cmd, tf.path)) {
        push(
          // Executing a config/script that legitimately embeds a secret
          // (e.g. .env -> config.ts -> `node config.ts`) is a normal dev
          // workflow; only shipping it OFF the box (egress) is high-signal.
          sink.kind === "egress" ? "high" : "medium",
          `${verb} command references ${sanitize(tf.path)}, which was written at turn(s) ` +
            `${tf.writeTurns.join(",")} using a value read from ${sanitize(tf.sourcePath)} ` +
            `(sensitive) at turn ${tf.sourceTurn} earlier in this session. This is a ` +
            `multi-step read→write→use data flow spanning turns that would not be ` +
            `visible from the current action alone.`,
        );
      }
    }

    // Case B — the sink references a sensitive file directly (read-then-use).
    for (const r of sensitiveReads) {
      if (refsPath(cmd, r.path)) {
        push("high", `${verb} command references sensitive file ${sanitize(r.path)} read at turn ${r.turn}.`);
      }
    }

    // Case C — egress names a sensitive env var (value is stored redacted,
    // so we match the variable name).
    if (sink.kind === "egress") {
      for (const e of sensitiveEnv) {
        if (cmd.includes(e.name)) {
          push("high", `Egress command references sensitive environment variable ${sanitize(e.name)} set at turn ${e.turn}.`);
        }
      }
    }
  } else {
    // Case D — staging: writing a value that originated in a sensitive
    // read into a new file. Medium: no egress yet, but it's the setup move.
    for (const r of sensitiveReads) {
      const secrets = extractSecretValues(r.content);
      if (secrets.some((s) => sink.content.includes(s))) {
        push(
          "medium",
          `Writing a value read from ${sanitize(r.path)} (sensitive, turn ${r.turn}) into ${sanitize(sink.path)} — ` +
            `potential staging for later exfiltration.`,
        );
        break;
      }
    }
  }

  if (chains.length === 0) return { chains: [], text: "" };

  // High severity first; stable within a severity (discovery order). Sort
  // BEFORE capping so a high-severity chain is never dropped in favour of a
  // medium one regardless of the order cases pushed them.
  chains.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
  const capped = chains.slice(0, MAX_CHAINS);

  const text =
    "PROVENANCE ALERT (deterministic data-flow analysis over the full session):\n" +
    capped.map((ch, i) => `${i + 1}. [${ch.severity.toUpperCase()}] ${ch.description}`).join("\n");

  return { chains: capped, text };
}
