/**
 * Regression: a malformed image block must NOT crash the judge.
 *
 * The transcript SUMMARY ships images as `{ source: { media_type, data } }`, but
 * the server casts them straight to ImageBlock without mapping source.media_type
 * -> mediaType, so `img.mediaType` is undefined. bedrock-client did
 * `img.mediaType.replace("image/","")` -> TypeError "Cannot read properties of
 * undefined (reading 'replace')" -> caught by IntentJudge.evaluate as an INTERNAL
 * error -> fail-CLOSED (ask/deny). Before 0.1.514 it fail-soft (silent allow);
 * after, users see "a lot of failing closed" on any image-bearing session.
 *
 * imageToBedrockContent skips any image without a valid string mediaType+data.
 *
 * Run: npx tsx hooks/tests/test_bedrock_image_block.ts
 */

import { imageToBedrockContent } from "../../src/bedrock-client.js";
import { summaryImagesToBlocks } from "../../src/transcript-backfill.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
function check<T>(label: string, fn: () => T, ok: (v: T) => boolean): void {
  try { const v = fn(); ok(v) ? pass(label) : fail(`${label} (got ${JSON.stringify(v)})`); }
  catch (e: any) { fail(`${label} (threw: ${e?.message})`); }
}

console.log("\n--- imageToBedrockContent: valid images map, invalid ones skip ---");
check("valid png maps to format 'png' with Buffer bytes",
  () => imageToBedrockContent({ mediaType: "image/png", data: Buffer.from("hello").toString("base64") }),
  (v: any) => v?.image?.format === "png" && Buffer.isBuffer(v.image.source.bytes) && v.image.source.bytes.toString() === "hello");
check("valid jpeg maps to format 'jpeg'",
  () => imageToBedrockContent({ mediaType: "image/jpeg", data: "eA==" }), (v: any) => v?.image?.format === "jpeg");

check("undefined mediaType -> null (the bug case: summary {source:...})",
  () => imageToBedrockContent({ data: "eA==" } as any), (v) => v === null);
check("summary-shaped {source:{media_type,data}} -> null (no top-level mediaType)",
  () => imageToBedrockContent({ source: { media_type: "image/png", data: "eA==" } } as any), (v) => v === null);
check("undefined data -> null", () => imageToBedrockContent({ mediaType: "image/png" } as any), (v) => v === null);
check("empty data -> null", () => imageToBedrockContent({ mediaType: "image/png", data: "" } as any), (v) => v === null);
check("null -> null", () => imageToBedrockContent(null as any), (v) => v === null);
check("undefined -> null", () => imageToBedrockContent(undefined as any), (v) => v === null);

console.log("\n--- summaryImagesToBlocks: map summary {source:...} -> ImageBlock, drop placeholders ---");
const B64 = Buffer.from("img").toString("base64");
check("real summary image maps to ImageBlock (source.media_type -> mediaType)",
  () => summaryImagesToBlocks([{ source: { type: "base64", media_type: "image/png", data: B64 } }]),
  (v: any) => v.length === 1 && v[0].mediaType === "image/png" && v[0].data === B64);
check("missing media_type defaults to image/png",
  () => summaryImagesToBlocks([{ source: { type: "base64", data: B64 } }]),
  (v: any) => v.length === 1 && v[0].mediaType === "image/png");
check("count-only placeholder {source:null} is dropped",
  () => summaryImagesToBlocks([{ source: null }]), (v: any) => v.length === 0);
check("source without data is dropped",
  () => summaryImagesToBlocks([{ source: { type: "base64" } }]), (v: any) => v.length === 0);
check("already-flat {mediaType,data} passes through (idempotent)",
  () => summaryImagesToBlocks([{ mediaType: "image/jpeg", data: B64 }]),
  (v: any) => v.length === 1 && v[0].mediaType === "image/jpeg" && v[0].data === B64);
check("mixed real + placeholder keeps only the real one",
  () => summaryImagesToBlocks([{ source: { data: B64, media_type: "image/gif" } }, { source: null }]),
  (v: any) => v.length === 1 && v[0].mediaType === "image/gif");
check("non-array -> []", () => summaryImagesToBlocks(undefined), (v: any) => Array.isArray(v) && v.length === 0);
check("end-to-end: mapped summary image -> valid bedrock content block",
  () => imageToBedrockContent(summaryImagesToBlocks([{ source: { data: B64, media_type: "image/png" } }])[0] as any),
  (v: any) => v?.image?.format === "png");

console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off}  (${PASS} passed, ${FAIL} failed)\n`);
process.exit(FAIL === 0 ? 0 : 1);
