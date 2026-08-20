/**
 * Regression: a pasted screenshot must not 500 `POST /intent`.
 *
 * THE BUG
 * -------
 * DynamoDB enforces a hard 400KB per-item limit. `prompt` is capped
 * (MAX_PROMPT_BYTES) but the `images` array on a TurnIntent was written
 * straight through. A single pasted screenshot is ~330KB of base64, i.e.
 * ~100% of the item budget on its own, so `registerIntent` blew up:
 *
 *   [ERROR] POST /intent: ValidationException: Item size has exceeded
 *     the maximum allowed size
 *     at async DynamoSessionStore.registerIntent (dynamo-session-store.ts:1488)
 *
 * Measured on prod session d72f9c44 (2026-08-20):
 *   TURN#0005  prompt=58 chars  images=1  imageBytes=342,464
 *   TURN#0006  prompt=39 chars  images=1  imageBytes=326,940
 *
 * Three write sites carry images and all three need the cap:
 *   1. META  `originalIntent` — first prompt of a session (kills META creation)
 *   2. TURN# `images`         — every subsequent prompt
 *   3. INTENT# `images`       — IntentEntry rows via appendToHistory /
 *                               setActiveIntents (also carry a 1024-d embedding)
 *
 * THE INVARIANTS
 * --------------
 *   A. Stored images are capped to MAX_TURN_IMAGE_BYTES total. Over budget,
 *      `data` is cleared but `mediaType` and the BLOCK COUNT survive, so
 *      readers that count images or branch on shape keep working. Dropping
 *      the stored bytes does not weaken the judge: it already saw the live
 *      image in the request body.
 *   B. A persistence failure in registerIntent DEGRADES rather than 500s.
 *      A dropped intent is far worse than a dropped turn row — every later
 *      tool call would be judged against a stale goal, which is exactly the
 *      spurious-approval-prompt problem this workstream exists to remove.
 *
 * Run: npx tsx hooks/tests/test_dynamo_image_cap.ts
 * Exits non-zero on any failure.
 */

// ESM hoists static imports above top-level statements, so OLLAMA_HOST
// must be set here and every module that (transitively) loads
// ollama-client must be pulled in via `await import(...)` inside main().
const STUB_PORT = 17311;
process.env.OLLAMA_HOST = `http://127.0.0.1:${STUB_PORT}`;

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ImageBlock } from "../../src/session-types.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const ok = (cond: boolean, m: string) => (cond ? pass(m) : fail(m));
/** Clip a value for failure messages — these fixtures are 300KB strings. */
const preview = (v: unknown): string => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length <= 60 ? s : `${s.slice(0, 57)}…(${s.length}B)`;
};
const eq = <T>(a: T, b: T, m: string) =>
  a === b ? pass(m) : fail(`${m} (expected ${preview(b)}, got ${preview(a)})`);
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

// ---------------------------------------------------------------------------
// Fixtures — base64 payloads sized like the real prod screenshots.
// ---------------------------------------------------------------------------
const b64 = (bytes: number): string => "A".repeat(bytes);
/** The two screenshot payloads measured on prod session d72f9c44 (TURN#0005 / #0006). */
const BIG_IMAGE: ImageBlock = { mediaType: "image/png", data: b64(342_464) };
const BIG_IMAGE_2: ImageBlock = { mediaType: "image/jpeg", data: b64(326_940) };
/** One turn, both screenshots pasted — 669KB, comfortably past the 400KB item limit. */
const SCREENSHOTS: ImageBlock[] = [BIG_IMAGE, BIG_IMAGE_2];
const SMALL_IMAGE: ImageBlock = { mediaType: "image/jpeg", data: b64(4_000) };
const MID_IMAGE = (n: number): ImageBlock => ({ mediaType: "image/png", data: b64(n) });

// ---------------------------------------------------------------------------
// Stub embedder (Ollama-compatible). 8-dim deterministic vectors.
// ---------------------------------------------------------------------------
function startStub(): Promise<{ close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          const inputs: string[] = Array.isArray(parsed.input) ? parsed.input : [String(parsed.input ?? "")];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            embeddings: inputs.map((t) => [t.length % 7, 1, 0, 0, 0, 0, 0, 0]),
            model: parsed.model ?? "stub",
          }));
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
      });
    });
    srv.listen(STUB_PORT, "127.0.0.1", () => resolve({ close: () => srv.close() }));
  });
}

// ---------------------------------------------------------------------------
// Fake DynamoDBDocumentClient that enforces the REAL 400KB item limit —
// the whole point of the test is that the store stays under it.
// ---------------------------------------------------------------------------
const DYNAMO_MAX_ITEM_BYTES = 400 * 1024;

function itemBytes(item: Record<string, any>): number {
  return Buffer.byteLength(JSON.stringify(item));
}

class FakeDoc {
  items = new Map<string, Record<string, any>>();
  /** Every item that was successfully written, newest last. */
  writes: Record<string, any>[] = [];

  private k(pkv: string, skv: string): string { return `${pkv}|${skv}`; }

  get(pkv: string, skv: string): Record<string, any> | undefined {
    return this.items.get(this.k(pkv, skv));
  }

  private enforceSize(item: Record<string, any>): void {
    const size = itemBytes(item);
    if (size > DYNAMO_MAX_ITEM_BYTES) {
      const err = new Error(
        `Item size has exceeded the maximum allowed size (${size} > ${DYNAMO_MAX_ITEM_BYTES}) on sk=${item.sk}`,
      );
      err.name = "ValidationException";
      throw err;
    }
  }

  async send(cmd: any): Promise<any> {
    const name: string = cmd?.constructor?.name ?? "";
    const input = cmd?.input ?? {};

    if (name.startsWith("Get")) {
      return { Item: this.get(input.Key.pk, input.Key.sk) };
    }

    if (name.startsWith("Put")) {
      const item = { ...input.Item };
      this.enforceSize(item);
      this.items.set(this.k(item.pk, item.sk), item);
      this.writes.push(item);
      return {};
    }

    if (name.startsWith("Update")) {
      // Crude but faithful for this store: every SET clause the store
      // emits is `#attr = :attr`, so replay the names/values maps.
      const key = this.k(input.Key.pk, input.Key.sk);
      const current = this.items.get(key) ?? { pk: input.Key.pk, sk: input.Key.sk };
      const next: Record<string, any> = { ...current };
      const names: Record<string, string> = input.ExpressionAttributeNames ?? {};
      const values: Record<string, any> = input.ExpressionAttributeValues ?? {};
      for (const attr of Object.values(names)) {
        if (attr === "version") continue;
        const v = values[`:${attr}`];
        if (v !== undefined) next[attr] = v;
      }
      next.version = ((current.version as number | undefined) ?? 0) + 1;
      this.enforceSize(next);
      this.items.set(key, next);
      this.writes.push(next);
      return {};
    }

    if (name.startsWith("Query")) {
      const vals: Record<string, any> = input.ExpressionAttributeValues ?? {};
      const wantPk = vals[":pk"];
      const prefix = vals[":prefix"] ?? "";
      const Items = [...this.items.values()]
        .filter((it) => it.pk === wantPk && String(it.sk).startsWith(prefix))
        .sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
      return { Items };
    }

    if (name.startsWith("Delete")) {
      this.items.delete(this.k(input.Key.pk, input.Key.sk));
      return {};
    }

    return {};
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const stub = await startStub();
  try {
    const marshal: any = await import("../../src/dynamo-session-marshal.js");
    const { DynamoSessionStore } = await import("../../src/dynamo-session-store.js");

    // =====================================================================
    section("capImages — pure helper");

    const hasCap = typeof marshal.capImages === "function";
    ok(hasCap, "capImages is exported from dynamo-session-marshal");
    const hasBytes = typeof marshal.imageBytes === "function";
    ok(hasBytes, "imageBytes is exported from dynamo-session-marshal");
    const LIMIT: number = marshal.MAX_TURN_IMAGE_BYTES;
    ok(typeof LIMIT === "number" && LIMIT > 0 && LIMIT <= 200_000,
      `MAX_TURN_IMAGE_BYTES exported and in a sane range (got ${LIMIT})`);

    if (hasCap && hasBytes) {
      const capImages = marshal.capImages as (i?: ImageBlock[]) => ImageBlock[] | undefined;
      const imageBytes = marshal.imageBytes as (i?: ImageBlock[]) => number;

      eq(capImages(undefined), undefined, "undefined images → undefined");
      ok(Array.isArray(capImages([])) && capImages([])!.length === 0, "empty array → empty array");

      const small = capImages([SMALL_IMAGE])!;
      eq(small.length, 1, "under-budget image: count preserved");
      eq(small[0].data, SMALL_IMAGE.data, "under-budget image: data preserved verbatim");
      eq(small[0].mediaType, "image/jpeg", "under-budget image: mediaType preserved");

      const big = capImages([BIG_IMAGE])!;
      eq(big.length, 1, "over-budget image: block count preserved (not dropped)");
      eq(big[0].mediaType, "image/png", "over-budget image: mediaType preserved");
      eq(big[0].data, "", "over-budget image: data cleared");

      const three = capImages([MID_IMAGE(60_000), MID_IMAGE(60_000), MID_IMAGE(60_000)])!;
      eq(three.length, 3, "3 mid images: all 3 blocks survive");
      ok(three.every((i) => i.mediaType === "image/png"), "3 mid images: every mediaType survives");
      ok(imageBytes(three) <= LIMIT, `3 mid images: total bytes ≤ limit (got ${imageBytes(three)})`);
      ok(three[0].data.length > 0, "3 mid images: first block keeps its data (budget spent in order)");
      eq(three[2].data, "", "3 mid images: last block over budget → data cleared");

      // Input must not be mutated — the same array is handed to the
      // interceptor/judge after the store call in some paths.
      const original: ImageBlock[] = [{ ...BIG_IMAGE }];
      capImages(original);
      ok(original[0].data.length > 0, "capImages does not mutate its input");

      // Idempotent: re-capping an already-capped array is a no-op.
      const once = capImages([BIG_IMAGE, SMALL_IMAGE])!;
      const twice = capImages(once)!;
      eq(JSON.stringify(twice), JSON.stringify(once), "capImages is idempotent");
    }

    // =====================================================================
    section("registerIntent — first prompt writes originalIntent onto META");

    {
      const fake = new FakeDoc();
      const store = new DynamoSessionStore({
        tableName: "t", region: "eu-west-1", embeddingModel: "nomic-embed-text",
        client: fake as any,
      });

      let threw: Error | null = null;
      try {
        await store.registerIntent("sess-meta", "what does this screenshot show?", false, SCREENSHOTS);
      } catch (err) { threw = err as Error; }
      ok(threw === null, `first prompt + 669KB of screenshots does not throw (${threw?.name}: ${threw?.message ?? "ok"})`);

      const meta = fake.get("SESSION#sess-meta", "META");
      ok(!!meta, "META row was written");
      if (meta) {
        ok(itemBytes(meta) < DYNAMO_MAX_ITEM_BYTES, `META item under 400KB (got ${itemBytes(meta)})`);
        const imgs = meta.originalIntent?.images as ImageBlock[] | undefined;
        eq(imgs?.length, 2, "META originalIntent keeps the image block count");
        eq(imgs?.[0]?.mediaType, "image/png", "META originalIntent keeps mediaType (block 0)");
        eq(imgs?.[1]?.mediaType, "image/jpeg", "META originalIntent keeps mediaType (block 1)");
        eq(imgs?.[0]?.data, "", "META originalIntent image data cleared (block 0)");
        eq(imgs?.[1]?.data, "", "META originalIntent image data cleared (block 1)");
      }
    }

    // =====================================================================
    section("registerIntent — subsequent turn writes TURN# rows");

    {
      const fake = new FakeDoc();
      const store = new DynamoSessionStore({
        tableName: "t", region: "eu-west-1", embeddingModel: "nomic-embed-text",
        client: fake as any,
      });
      await store.registerIntent("sess-turn", "fix the failing test", false);

      let threw: Error | null = null;
      try {
        await store.registerIntent("sess-turn", "here is the error", false, SCREENSHOTS);
      } catch (err) { threw = err as Error; }
      ok(threw === null, `turn 1 + 669KB of screenshots does not throw (${threw?.name}: ${threw?.message ?? "ok"})`);

      const turn = fake.get("SESSION#sess-turn", "TURN#0001");
      ok(!!turn, "TURN#0001 row was written");
      if (turn) {
        ok(itemBytes(turn) < DYNAMO_MAX_ITEM_BYTES, `TURN#0001 item under 400KB (got ${itemBytes(turn)})`);
        const imgs = turn.images as ImageBlock[] | undefined;
        eq(imgs?.length, 2, "TURN#0001 keeps the image block count");
        eq(imgs?.[0]?.mediaType, "image/png", "TURN#0001 keeps mediaType (block 0)");
        eq(imgs?.[1]?.mediaType, "image/jpeg", "TURN#0001 keeps mediaType (block 1)");
        eq(imgs?.[0]?.data, "", "TURN#0001 image data cleared (block 0)");
        eq(imgs?.[1]?.data, "", "TURN#0001 image data cleared (block 1)");
      }

      // A small image must survive intact — the cap must not be a blanket strip.
      await store.registerIntent("sess-turn", "and this thumbnail", false, [SMALL_IMAGE]);
      const turn2 = fake.get("SESSION#sess-turn", "TURN#0002");
      eq((turn2?.images as ImageBlock[] | undefined)?.[0]?.data, SMALL_IMAGE.data,
        "small image on a later turn is stored verbatim");
    }

    // =====================================================================
    section("appendToHistory — INTENT# rows also carry images");

    {
      const fake = new FakeDoc();
      const store = new DynamoSessionStore({
        tableName: "t", region: "eu-west-1", embeddingModel: "nomic-embed-text",
        client: fake as any,
      });
      const registeredAt = Date.now();
      let threw: Error | null = null;
      try {
        await store.appendToHistory("sess-entry", {
          id: "entry-1",
          prompt: "what does this show?",
          contextual: "what does this show?",
          embedding: new Array(1024).fill(0.01),
          registeredAt,
          kind: "new-task",
          resolved: false,
          images: SCREENSHOTS,
        });
      } catch (err) { threw = err as Error; }
      ok(threw === null, `INTENT# row + 669KB of screenshots does not throw (${threw?.name}: ${threw?.message ?? "ok"})`);

      const row = fake.writes.find((w) => String(w.sk).startsWith("INTENT#"));
      ok(!!row, "INTENT# row was written");
      if (row) {
        ok(itemBytes(row) < DYNAMO_MAX_ITEM_BYTES, `INTENT# item under 400KB (got ${itemBytes(row)})`);
        const imgs = row.images as ImageBlock[] | undefined;
        eq(imgs?.length, 2, "INTENT# row keeps the image block count");
        eq(imgs?.[0]?.data, "", "INTENT# row image data cleared (block 0)");
        eq(imgs?.[1]?.data, "", "INTENT# row image data cleared (block 1)");
      }
    }

    // =====================================================================
    section("registerIntentOrDegrade — a persistence failure must not 500");

    {
      const handlers: any = await import("../../src/handlers/intent.js");
      const hasWrapper = typeof handlers.registerIntentOrDegrade === "function";
      ok(hasWrapper, "registerIntentOrDegrade is exported from handlers/intent");

      if (hasWrapper) {
        const wrap = handlers.registerIntentOrDegrade as (...a: any[]) => Promise<any>;

        // Happy path: result passes straight through.
        const goodStore = {
          registerIntent: async () => ({
            isOriginal: false, turnNumber: 7, driftFromOriginal: 0.42, driftFromPrevious: 0.1,
          }),
        };
        const good = await wrap(goodStore, "s", "prompt", false, undefined, false, false, true);
        eq(good.degraded, false, "success → degraded false");
        eq(good.turnNumber, 7, "success → backend turnNumber passes through");
        eq(good.driftFromOriginal, 0.42, "success → backend drift passes through");

        // Failure path: the exact prod error.
        const boom = () => {
          const e = new Error("Item size has exceeded the maximum allowed size");
          e.name = "ValidationException";
          throw e;
        };
        const badStore = { registerIntent: async () => boom() };

        const errs: string[] = [];
        const realErr = console.error;
        console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
        let degraded: any;
        let rethrew: Error | null = null;
        try {
          degraded = await wrap(badStore, "sess-boom", "prompt", false, undefined, false, false, true);
        } catch (err) { rethrew = err as Error; } finally { console.error = realErr; }

        ok(rethrew === null, `persistence failure does not propagate (${rethrew?.message ?? "ok"})`);
        if (degraded) {
          eq(degraded.degraded, true, "failure → degraded true");
          eq(degraded.driftFromOriginal, null, "failure → driftFromOriginal null (no stale drift)");
          eq(degraded.driftFromPrevious, null, "failure → driftFromPrevious null");
          eq(degraded.turnNumber, -1, "failure → turnNumber -1 (unknown, not a real turn)");
          eq(degraded.isOriginal, false, "failure + session already registered → isOriginal false");
        }
        ok(errs.some((l) => l.includes("ValidationException") || l.includes("Item size")),
          "failure is logged to console.error with the underlying cause");

        // A session the interceptor has NOT seen must report isOriginal so
        // the handler re-anchors the judge instead of leaving it goal-less.
        const errs2: string[] = [];
        const realErr2 = console.error;
        console.error = (...a: unknown[]) => { errs2.push(a.map(String).join(" ")); };
        let fresh: any;
        try {
          fresh = await wrap(badStore, "sess-fresh", "prompt", false, undefined, false, false, false);
        } finally { console.error = realErr2; }
        eq(fresh?.isOriginal, true, "failure + session NOT yet registered → isOriginal true (re-anchor the judge)");
      }
    }
  } finally {
    stub.close();
  }

  console.log(
    `\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off}  (${PASS} passed, ${FAIL} failed)\n`,
  );
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${c.red}HARNESS ERROR${c.off}: ${err?.stack ?? err}`);
  process.exit(1);
});
