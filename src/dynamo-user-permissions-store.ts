/**
 * DynamoDB-backed UserPermissionsStore.
 *
 * One row per (ownerSub, projectRoot) in `jaid-user-permissions`. TTL
 * is refreshed on every upsert so the row lives 90d past last touch.
 *
 * Item shape:
 *   pk          = USER#<ownerSub>
 *   sk          = PROJECT#<projectRootHash16>
 *   hash        = sha256 of canonical {allow,deny,ask}
 *   allow       = list<string>
 *   deny        = list<string>
 *   ask         = list<string>
 *   projectRoot = the un-hashed cwd (operator-facing debugging only —
 *                 the index key is the hash, this is a value)
 *   ownerSub    = duplicated as an attribute for cross-table joins
 *   updatedAt   = ISO-8601
 *   ttl         = epoch-seconds, 90d from updatedAt
 *
 * See terraform/jaid-user-permissions.tf for the table itself.
 */

import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  type UserPermissionsInput,
  type UserPermissionsSnapshot,
  type UserPermissionsStore,
  projectRootKey,
} from "./user-permissions-store.js";

const TTL_SEC_90D = 90 * 24 * 60 * 60;

export interface DynamoUserPermissionsStoreOptions {
  tableName: string;
  region: string;
  /** Override for tests. */
  client?: DynamoDBDocumentClient;
}

function pk(ownerSub: string): string {
  return `USER#${ownerSub}`;
}

function sk(projectRoot: string): string {
  return `PROJECT#${projectRootKey(projectRoot)}`;
}

function itemToSnapshot(item: Record<string, any>): UserPermissionsSnapshot {
  return {
    ownerSub: item.ownerSub,
    projectRoot: item.projectRoot,
    hash: item.hash,
    allow: Array.isArray(item.allow) ? item.allow : [],
    deny: Array.isArray(item.deny) ? item.deny : [],
    ask: Array.isArray(item.ask) ? item.ask : [],
    updatedAt: item.updatedAt,
  };
}

export class DynamoUserPermissionsStore implements UserPermissionsStore {
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(opts: DynamoUserPermissionsStoreOptions) {
    this.tableName = opts.tableName;
    this.client =
      opts.client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: opts.region }), {
        marshallOptions: {
          removeUndefinedValues: true,
          convertClassInstanceToMap: false,
        },
      });
  }

  async get(ownerSub: string, projectRoot: string): Promise<UserPermissionsSnapshot | null> {
    const r = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: pk(ownerSub), sk: sk(projectRoot) },
      }),
    );
    if (!r.Item) return null;
    return itemToSnapshot(r.Item);
  }

  async upsert(input: UserPermissionsInput): Promise<UserPermissionsSnapshot> {
    const updatedAt = new Date().toISOString();
    const ttl = Math.floor(Date.now() / 1000) + TTL_SEC_90D;
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: pk(input.ownerSub),
          sk: sk(input.projectRoot),
          ownerSub: input.ownerSub,
          projectRoot: input.projectRoot,
          hash: input.hash,
          allow: input.allow,
          deny: input.deny,
          ask: input.ask,
          updatedAt,
          ttl,
        },
      }),
    );
    return { ...input, updatedAt };
  }
}
