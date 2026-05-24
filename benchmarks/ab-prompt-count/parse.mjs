// parse.mjs — count tool calls and outcomes per run.
//
// Reads a stream-json transcript and emits CSV rows: one per tool_use, with
// the matched tool_result's error state and a permission-denied heuristic.
// Also prints a summary block to stderr.
//
// Usage: node parse.mjs <transcript.jsonl> [--csv-out path.csv] [--label foo]

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
let transcriptPath = null;
let csvOutPath = null;
let label = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--csv-out") csvOutPath = args[++i];
  else if (args[i] === "--label") label = args[++i];
  else if (!transcriptPath) transcriptPath = args[i];
}
if (!transcriptPath) {
  console.error("usage: node parse.mjs <transcript.jsonl> [--csv-out path] [--label foo]");
  process.exit(2);
}

const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);

const calls = new Map(); // tool_use_id -> { tool, input }
const rows = [];
let resultEvent = null;
let initEvent = null;

for (const line of lines) {
  let evt;
  try { evt = JSON.parse(line); } catch { continue; }

  if (evt.type === "system" && evt.subtype === "init") {
    initEvent = evt;
    continue;
  }

  if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block?.type !== "tool_use") continue;
      calls.set(block.id, {
        id: block.id,
        tool: block.name,
        input: JSON.stringify(block.input ?? {}).slice(0, 240),
      });
    }
    continue;
  }

  if (evt.type === "user" && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block?.type !== "tool_result") continue;
      const call = calls.get(block.tool_use_id);
      if (!call) continue;
      const content = block.content;
      const flat = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map(r => r?.text ?? JSON.stringify(r)).join("\n")
          : JSON.stringify(content ?? "");
      const isError = block.is_error === true;
      const denialPattern =
        /(permission|denied|not allowed|user.*decline|requires? approval|do you want to proceed|judge ai dredd)/i;
      const looksDenied = isError && denialPattern.test(flat);
      rows.push({
        ...call,
        is_error: isError,
        prompted_or_denied: looksDenied,
        result_snippet: flat.slice(0, 200).replace(/\s+/g, " "),
      });
      calls.delete(block.tool_use_id);
    }
    continue;
  }

  if (evt.type === "result") {
    resultEvent = evt;
  }
}

const total = rows.length;
const denied = rows.filter(r => r.prompted_or_denied).length;
const errored_other = rows.filter(r => r.is_error && !r.prompted_or_denied).length;
const ok = total - denied - errored_other;
const permissionDenialsField = (resultEvent?.permission_denials ?? []).length;

const summary = {
  label: label ?? transcriptPath,
  session_id: initEvent?.session_id ?? null,
  num_turns: resultEvent?.num_turns ?? null,
  duration_ms: resultEvent?.duration_ms ?? null,
  is_error: resultEvent?.is_error ?? null,
  stop_reason: resultEvent?.stop_reason ?? null,
  tool_calls: total,
  ran_ok: ok,
  prompted_or_denied: denied,
  errored_other,
  permission_denials_field: permissionDenialsField,
};

console.error(JSON.stringify(summary, null, 2));

const csvLines = [];
csvLines.push("tool,is_error,prompted_or_denied,input,result_snippet");
const quote = s => `"${String(s).replace(/"/g, '""')}"`;
for (const r of rows) {
  csvLines.push([
    quote(r.tool),
    r.is_error,
    r.prompted_or_denied,
    quote(r.input),
    quote(r.result_snippet),
  ].join(","));
}
const csv = csvLines.join("\n") + "\n";

if (csvOutPath) {
  writeFileSync(csvOutPath, csv);
} else {
  process.stdout.write(csv);
}

// Also write a summary JSON next to the CSV if requested.
if (csvOutPath) {
  writeFileSync(csvOutPath.replace(/\.csv$/, ".summary.json"), JSON.stringify(summary, null, 2));
}
