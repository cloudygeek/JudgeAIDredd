// src/dynamo-byot-store.ts
/**
 * DynamoDB-backed ByotStore. One row per ownerSub in `jaid-byot`.
 *   pk = USER#<ownerSub>, sk = BYOT
 * See terraform/jaid-byot.tf.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { ByotStore } from "./byot-store.js";
import type { ByotConfigRecord } from "./byot/types.js";

export interface DynamoByotStoreOptions {
  tableName: string;
  region: string;
  /** Override for tests. */
  client?: DynamoDBDocumentClient;
}

const pk = (ownerSub: string) => `USER#${ownerSub}`;
const SK = "BYOT";

function itemToRecord(item: Record<string, any>): ByotConfigRecord {
  return {
    ownerSub: item.ownerSub,
    provider: item.provider,
    region: item.region,
    ciphertext: item.ciphertext,
    last4: item.last4,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastValidatedAt: item.lastValidatedAt ?? null,
    lastFallbackAt: item.lastFallbackAt ?? null,
    lastFallbackReason: item.lastFallbackReason ?? null,
  };
}

export class DynamoByotStore implements ByotStore {
  private readonly tableName: string;
  private readonly doc: DynamoDBDocumentClient;
  constructor(opts: DynamoByotStoreOptions) {
    this.tableName = opts.tableName;
    this.doc = opts.client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: opts.region }), {
        marshallOptions: {
          removeUndefinedValues: true,
          convertClassInstanceToMap: false,
        },
      });
  }
  async get(ownerSub: string): Promise<ByotConfigRecord | null> {
    const out = await this.doc.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: pk(ownerSub), sk: SK },
    }));
    return out.Item ? itemToRecord(out.Item) : null;
  }
  async put(record: ByotConfigRecord): Promise<void> {
    await this.doc.send(new PutCommand({
      TableName: this.tableName,
      Item: { pk: pk(record.ownerSub), sk: SK, ...record },
    }));
  }
  async delete(ownerSub: string): Promise<void> {
    await this.doc.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { pk: pk(ownerSub), sk: SK },
    }));
  }
  async markRuntimeFallback(ownerSub: string, reason: string, at: string): Promise<void> {
    try {
      await this.doc.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: pk(ownerSub), sk: SK },
        // Only update an existing row — never resurrect a deleted config.
        ConditionExpression: "attribute_exists(pk)",
        UpdateExpression: "SET #s = :s, lastFallbackAt = :a, lastFallbackReason = :r, updatedAt = :a",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "runtime-fallback", ":a": at, ":r": reason },
      }));
    } catch (err: any) {
      // A deleted-in-the-meantime config (ConditionalCheckFailed) is fine
      // to swallow — there's nothing to flag.
      if (err?.name !== "ConditionalCheckFailedException") throw err;
    }
  }
}
