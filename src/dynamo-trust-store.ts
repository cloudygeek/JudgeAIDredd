/**
 * DynamoDB-backed TrustStore. One row per ownerSub on the shared jaid-byot
 * table: pk = USER#<ownerSub>, sk = TRUST. No KMS (no secret stored).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { TrustStore, TrustRecord } from "./trust-store.js";

export interface DynamoTrustStoreOptions {
  tableName: string;
  region: string;
  /** Override for tests. */
  client?: DynamoDBDocumentClient;
}

const pk = (ownerSub: string) => `USER#${ownerSub}`;
const SK = "TRUST";

function itemToRecord(item: Record<string, any>): TrustRecord {
  return {
    ownerSub: item.ownerSub,
    enabled: !!item.enabled,
    setBy: item.setBy,
    setByEmail: item.setByEmail ?? null,
    setAt: item.setAt,
    note: item.note ?? null,
  };
}

export class DynamoTrustStore implements TrustStore {
  private readonly tableName: string;
  private readonly doc: DynamoDBDocumentClient;
  constructor(opts: DynamoTrustStoreOptions) {
    this.tableName = opts.tableName;
    this.doc = opts.client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: opts.region }), {
        marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
      });
  }
  async get(ownerSub: string): Promise<TrustRecord | null> {
    const out = await this.doc.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: pk(ownerSub), sk: SK },
    }));
    return out.Item ? itemToRecord(out.Item) : null;
  }
  async put(record: TrustRecord): Promise<void> {
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
}
