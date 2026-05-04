/**
 * DynamoDB-backed ApiKeyStore.
 *
 * Source-of-truth persistence for API key metadata. Designed to sit behind
 * `CachedApiKeyStore` — this class issues a GetItem for every validation,
 * so running it un-cached would add a Dynamo round-trip to every single
 * hook call. The cache is what keeps the hot path fast.
 *
 * Item shape (single table `jaid-api-keys`):
 *
 *   pk          = APIKEY#<sha256-hex>
 *   sk          = META
 *   hashedKey   = <sha256-hex>           — duplicated from pk for clarity
 *   keyPreview  = "jaid_live_Abcd...wxyz"
 *   ownerSub    = OIDC sub claim         — STABLE owner identifier
 *   ownerEmail  = OIDC email claim       — display convenience
 *   description = "user-supplied label"
 *   keyType     = "user" | "service" | "benchmark"
 *   createdAt   = ISO-8601
 *   lastUsedAt  = ISO-8601 or null
 *   revokedAt?  = ISO-8601               — absent means active
 *   revokedBy?  = OIDC sub               — absent means active
 *   gsi1pk      = "USER#<ownerSub>"      — SET on active keys, REMOVED on revoke
 *   gsi1sk      = "APIKEY#<createdAt>"   — SET on active keys, REMOVED on revoke
 *   ttl?        = <epoch-seconds>        — SET on revoke, 90d out
 *
 * GSI1 is only present on active keys, so `listByOwner` Query returns active
 * keys only, no filter expression needed. Revoked keys stay in the table
 * (for forensics) until their TTL lapses.
 *
 * Injection-resistance invariants (DO NOT BREAK):
 *   - No PartiQL. All DynamoDB operations use the parameterised
 *     DocumentClient commands — values are bound via ExpressionAttributeValues,
 *     never string-concatenated.
 *   - Partition / sort keys are derived server-side from `hashKey(plaintext)`
 *     and fixed literals. User-supplied fields (description, ownerSub,
 *     ownerEmail) land in values only, never in key positions or expression
 *     strings.
 *   - UpdateExpression attribute names are authored in code via
 *     ExpressionAttributeNames; only the VALUES come from runtime state.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  type ApiKeyStore,
  type GenerateKeyInput,
  type GeneratedKey,
  type KeyRecord,
  type ValidatedKey,
  hashKey,
  keyPreview,
  looksLikeJaidKey,
  mintPlaintext,
} from "./api-key-store.js";

export interface DynamoApiKeyStoreOptions {
  tableName: string;
  region: string;
  /** Override for tests. */
  client?: DynamoDBDocumentClient;
  /** TTL in seconds for revoked keys; default 90 days. */
  revokedTtlSeconds?: number;
}

const REVOKED_TTL_DEFAULT = 90 * 24 * 60 * 60;
const GSI_NAME = "gsi1";

function pk(hash: string): string {
  return `APIKEY#${hash}`;
}

function userPk(sub: string): string {
  return `USER#${sub}`;
}

function createdAtSk(createdAt: string): string {
  return `APIKEY#${createdAt}`;
}

function nowEpochSec(): number {
  return Math.floor(Date.now() / 1000);
}

function itemToRecord(item: Record<string, any>): KeyRecord {
  return {
    hashedKey: item.hashedKey,
    keyPreview: item.keyPreview,
    ownerSub: item.ownerSub,
    ownerEmail: item.ownerEmail ?? null,
    description: item.description ?? "",
    keyType: item.keyType ?? "user",
    createdAt: item.createdAt,
    lastUsedAt: item.lastUsedAt ?? null,
    revokedAt: item.revokedAt ?? null,
    revokedBy: item.revokedBy ?? null,
  };
}

export class DynamoApiKeyStore implements ApiKeyStore {
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;
  private readonly revokedTtlSeconds: number;

  constructor(opts: DynamoApiKeyStoreOptions) {
    this.tableName = opts.tableName;
    this.revokedTtlSeconds = opts.revokedTtlSeconds ?? REVOKED_TTL_DEFAULT;
    this.client =
      opts.client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: opts.region }), {
        marshallOptions: {
          removeUndefinedValues: true,
          convertClassInstanceToMap: false,
        },
      });
  }

  async generateKey(input: GenerateKeyInput): Promise<GeneratedKey> {
    const plaintext = mintPlaintext();
    const hashedKey = hashKey(plaintext);
    const createdAt = new Date().toISOString();
    const keyType = input.keyType ?? "user";

    // ConditionExpression guards against the astronomically-unlikely case
    // where two `mintPlaintext()` calls collide — in which case the second
    // caller bubbles a retryable error. Also guards against a key being
    // "re-generated" over an existing record in any future bug.
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: pk(hashedKey),
          sk: "META",
          hashedKey,
          keyPreview: keyPreview(plaintext),
          ownerSub: input.ownerSub,
          ownerEmail: input.ownerEmail,
          description: input.description,
          keyType,
          createdAt,
          lastUsedAt: null,
          gsi1pk: userPk(input.ownerSub),
          gsi1sk: createdAtSk(createdAt),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );

    return {
      plaintext,
      hashedKey,
      keyPreview: keyPreview(plaintext),
      ownerSub: input.ownerSub,
      ownerEmail: input.ownerEmail,
      description: input.description,
      keyType,
      createdAt,
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
    };
  }

  async validateKey(plaintext: string): Promise<ValidatedKey | null> {
    if (!looksLikeJaidKey(plaintext)) return null;
    const hashedKey = hashKey(plaintext);
    const r = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: pk(hashedKey), sk: "META" },
      }),
    );
    if (!r.Item || r.Item.revokedAt) return null;

    // Best-effort lastUsedAt bump. We don't await or throw on error — a
    // validation should not fail because the stat update failed. Not
    // wrapped in try/await so it does not leak a rejection on the next
    // tick; we attach a swallow-handler.
    this.client
      .send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: pk(hashedKey), sk: "META" },
          UpdateExpression: "SET lastUsedAt = :t",
          ExpressionAttributeValues: { ":t": new Date().toISOString() },
        }),
      )
      .catch(() => {
        /* swallow — telemetry bump, not correctness-critical */
      });

    return {
      hashedKey: r.Item.hashedKey,
      ownerSub: r.Item.ownerSub,
      ownerEmail: r.Item.ownerEmail ?? null,
      keyType: r.Item.keyType ?? "user",
    };
  }

  async listByOwner(ownerSub: string, limit = 50): Promise<KeyRecord[]> {
    // GSI1 holds active keys only (revoked ones have gsi1pk/sk removed on
    // revoke), so Query against USER#<sub> returns exactly the user's
    // active keys without a FilterExpression.
    const r = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI_NAME,
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": userPk(ownerSub) },
        ScanIndexForward: false, // newest first
        Limit: limit,
      }),
    );
    return (r.Items ?? []).map(itemToRecord);
  }

  async revokeKey(hashedKey: string, revokedBy: string): Promise<boolean> {
    const revokedAt = new Date().toISOString();
    const ttl = nowEpochSec() + this.revokedTtlSeconds;

    // Atomic soft-delete:
    //   - SET revokedAt, revokedBy, ttl
    //   - REMOVE gsi1pk, gsi1sk so the key drops off listByOwner immediately
    //   - Condition: exists and not already revoked
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: pk(hashedKey), sk: "META" },
          UpdateExpression:
            "SET revokedAt = :ra, revokedBy = :rb, #ttl = :ttl REMOVE gsi1pk, gsi1sk",
          ConditionExpression:
            "attribute_exists(pk) AND attribute_not_exists(revokedAt)",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: {
            ":ra": revokedAt,
            ":rb": revokedBy,
            ":ttl": ttl,
          },
        }),
      );
      return true;
    } catch (err: any) {
      // Condition failure = already revoked or missing. Return false;
      // any other error propagates.
      if (err?.name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  }

  async loadKey(hashedKey: string): Promise<KeyRecord | null> {
    const r = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: pk(hashedKey), sk: "META" },
      }),
    );
    return r.Item ? itemToRecord(r.Item) : null;
  }
}
