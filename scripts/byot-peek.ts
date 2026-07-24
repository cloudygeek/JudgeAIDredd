// scripts/byot-peek.ts
//
// Decrypt a stored BYOT (Bring-Your-Own-Token) Bedrock key for testing.
// Reuses the exact prod store + crypto so it can't drift from the hot path.
//
// Usage:
//   BYOT_KMS_KEY_ID=<key-arn> npx tsx scripts/byot-peek.ts <ownerSub>
//   npx tsx scripts/byot-peek.ts --list          # list configured owners (no token)
//
// Env (defaults match src/server-core.ts):
//   DYNAMO_BYOT_TABLE_NAME  (default jaid-byot)
//   DYNAMO_REGION           (default eu-west-1)   — table + KMS key region
//   BYOT_KMS_KEY_ID         (required to decrypt; the stack SSE KMS key)
//
// Needs kms:Decrypt on that key and dynamodb:GetItem/Scan on the table.
// The KMS encryption context is bound to ownerSub — a row can only be
// decrypted under its own owner, so passing the wrong ownerSub fails.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoByotStore } from "../src/dynamo-byot-store.js";
import { KmsByotCrypto } from "../src/byot/byot-crypto.js";

const TABLE = process.env.DYNAMO_BYOT_TABLE_NAME ?? "jaid-byot";
const REGION = process.env.DYNAMO_REGION ?? "eu-west-1";

async function list(): Promise<void> {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const out = await doc.send(new ScanCommand({ TableName: TABLE }));
  const rows = out.Items ?? [];
  if (rows.length === 0) {
    console.log(`(no BYOT configs in ${TABLE} @ ${REGION})`);
    return;
  }
  for (const r of rows) {
    const owner = String(r.pk).replace(/^USER#/, "");
    console.log(`${owner}\tregion=${r.region}\tlast4=${r.last4}\tstatus=${r.status}`);
  }
}

async function peek(ownerSub: string): Promise<void> {
  const keyId = process.env.BYOT_KMS_KEY_ID;
  if (!keyId) {
    throw new Error("BYOT_KMS_KEY_ID is required to decrypt (the stack SSE KMS key ARN)");
  }
  const store = new DynamoByotStore({ tableName: TABLE, region: REGION });
  const crypto = new KmsByotCrypto({ keyId, region: REGION });

  const r = await store.get(ownerSub);
  if (!r) throw new Error(`no BYOT config for ownerSub=${ownerSub} in ${TABLE} @ ${REGION}`);

  console.error(
    `region=${r.region} last4=${r.last4} status=${r.status} ` +
      `provider=${r.provider} updatedAt=${r.updatedAt}`,
  );
  const token = await crypto.decrypt(r.ciphertext, { ownerSub });
  // token to stdout only, metadata to stderr — so `... | pbcopy` gets just the key
  console.log(token);
}

const arg = process.argv[2];
if (!arg || arg === "--help" || arg === "-h") {
  console.error("usage: npx tsx scripts/byot-peek.ts <ownerSub> | --list");
  process.exit(arg ? 0 : 1);
}

await (arg === "--list" ? list() : peek(arg)).catch((err) => {
  console.error(`error: ${err?.message ?? err}`);
  process.exit(1);
});
