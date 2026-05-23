/**
 * DynamoDB-backed ApprovalStore.
 *
 * Persists user-granted approvals so the "learning" survives container
 * replacement, restart, and cross-session re-use. Sits behind
 * `CachedApprovalStore` — every PreToolUse asks "do we have an approval
 * for this fingerprint?", which would otherwise round-trip to Dynamo.
 *
 * Item shape (single table `jaid-approvals`):
 *
 *   pk           = APPROVAL#<ownerSub>#<projectRootHash16>
 *   sk           = FP#<fingerprintHash>
 *
 *   ownerSub     = OIDC sub claim
 *   ownerEmail   = OIDC email (display only)
 *   projectRoot  = absolute path of the Claude working directory
 *   tool         = "Bash" | "Edit" | "WebFetch" | "mcp__…"
 *   fingerprintHash
 *   fingerprintJson  = canonical JSON of the fingerprint shape
 *   summary      = human-readable description (no secrets)
 *
 *   grantedAt    = ISO-8601
 *   lastUsedAt   = ISO-8601               — refreshed on every hit
 *   useCount     = N                       — incremented on every hit
 *   expiresAt    = ISO-8601               — lastUsedAt + 30d
 *
 *   intentSnapshot  = user prompt at grant time (for the dashboard)
 *   goalEmbedding   = number[]              — drift-distance backstop
 *
 *   revokedAt?   = ISO-8601               — absent means active
 *   revokedBy?   = OIDC sub
 *
 *   gsi1pk       = USER#<ownerSub>        — present on active rows only
 *   gsi1sk       = APPROVAL#<grantedAt>#<fingerprintHash>
 *   ttl          = <epoch-seconds>         — same instant as expiresAt
 *
 * GSI1 is the cheap dashboard listing path (Query by USER#<sub>,
 * newest-first via ScanIndexForward=false). Revoked rows have GSI1
 * keys REMOVED so they drop out of the listing without a
 * FilterExpression — same pattern as jaid-api-keys.
 *
 * Injection-resistance invariants (do not break):
 *   - No PartiQL. Parameterised DocumentClient commands throughout.
 *   - ownerSub and fingerprintHash are derived (clerk-issued / sha256);
 *     projectRoot is sha256-truncated before it lands in the pk so a
 *     pathological path can't malform a key.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";

import {
  type ApprovalStore,
  type ApprovalRecord,
  type ApprovalScope,
  type RecordApprovalInput,
  APPROVAL_TTL_MS,
} from "./approval-store.js";

export interface DynamoApprovalStoreOptions {
  tableName: string;
  region: string;
  /** Override for tests. */
  client?: DynamoDBDocumentClient;
}

const GSI_NAME = "gsi1";

function projectRootHash(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

function pk(scope: ApprovalScope): string {
  return `APPROVAL#${scope.ownerSub}#${projectRootHash(scope.projectRoot)}`;
}

function sk(fingerprintHash: string): string {
  return `FP#${fingerprintHash}`;
}

function userGsiPk(sub: string): string {
  return `USER#${sub}`;
}

function userGsiSk(grantedAt: string, fingerprintHash: string): string {
  return `APPROVAL#${grantedAt}#${fingerprintHash}`;
}

function nowEpochSec(): number {
  return Math.floor(Date.now() / 1000);
}

function ttlEpochFor(expiresAt: string): number {
  return Math.floor(new Date(expiresAt).getTime() / 1000);
}

function itemToRecord(item: Record<string, any>): ApprovalRecord {
  return {
    fingerprintHash: item.fingerprintHash,
    summary: item.summary ?? "",
    fingerprintJson: item.fingerprintJson ?? "",
    tool: item.tool,
    ownerSub: item.ownerSub,
    ownerEmail: item.ownerEmail ?? null,
    projectRoot: item.projectRoot,
    grantedAt: item.grantedAt,
    lastUsedAt: item.lastUsedAt,
    useCount: item.useCount ?? 0,
    expiresAt: item.expiresAt,
    intentSnapshot: item.intentSnapshot ?? "",
    goalEmbedding: Array.isArray(item.goalEmbedding) ? item.goalEmbedding : [],
    inputEmbedding: Array.isArray(item.inputEmbedding) ? item.inputEmbedding : [],
    // Default missing source to "explicit" — only the Dredd-ask-accept
    // path recorded approvals before Phase 9, so all legacy rows are
    // explicit by construction.
    source: item.source === "tacit" ? "tacit" : "explicit",
    revokedAt: item.revokedAt ?? null,
    revokedBy: item.revokedBy ?? null,
  };
}

export class DynamoApprovalStore implements ApprovalStore {
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(opts: DynamoApprovalStoreOptions) {
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

  async recordApproval(input: RecordApprovalInput): Promise<ApprovalRecord> {
    const now = new Date();
    const grantedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
    const ttl = ttlEpochFor(expiresAt);

    // Idempotent upsert: if a record already exists (same scope +
    // fingerprint), refresh lastUsedAt/expiresAt/ttl, bump useCount,
    // restore GSI keys (in case it was revoked and re-granted).
    // ConditionExpression isn't used here — re-granting an actively
    // revoked approval should re-activate it.
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: pk(input.scope), sk: sk(input.fingerprintHash) },
        UpdateExpression:
          "SET ownerSub = :os, ownerEmail = :oe, projectRoot = :pr, " +
          "tool = :tool, fingerprintHash = :fh, fingerprintJson = :fj, " +
          "summary = :sum, " +
          "lastUsedAt = :now, expiresAt = :exp, #ttl = :ttl, " +
          "intentSnapshot = :is, goalEmbedding = :ge, inputEmbedding = :ie, " +
          "#src = :src, " +
          "gsi1pk = :gpk, gsi1sk = :gsk, " +
          "useCount = if_not_exists(useCount, :zero) + :one, " +
          "grantedAt = if_not_exists(grantedAt, :now) " +
          "REMOVE revokedAt, revokedBy",
        ExpressionAttributeNames: { "#ttl": "ttl", "#src": "source" },
        ExpressionAttributeValues: {
          ":os": input.scope.ownerSub,
          ":oe": input.ownerEmail,
          ":pr": input.scope.projectRoot,
          ":tool": input.tool,
          ":fh": input.fingerprintHash,
          ":fj": input.fingerprintJson,
          ":sum": input.summary,
          ":now": grantedAt,
          ":exp": expiresAt,
          ":ttl": ttl,
          ":is": input.intentSnapshot,
          ":ge": input.goalEmbedding,
          ":ie": input.inputEmbedding ?? [],
          ":src": input.source ?? "explicit",
          ":gpk": userGsiPk(input.scope.ownerSub),
          ":gsk": userGsiSk(grantedAt, input.fingerprintHash),
          ":zero": 0,
          ":one": 1,
        },
      }),
    );

    return {
      fingerprintHash: input.fingerprintHash,
      summary: input.summary,
      fingerprintJson: input.fingerprintJson,
      tool: input.tool,
      ownerSub: input.scope.ownerSub,
      ownerEmail: input.ownerEmail,
      projectRoot: input.scope.projectRoot,
      grantedAt,
      lastUsedAt: grantedAt,
      useCount: 1,
      expiresAt,
      intentSnapshot: input.intentSnapshot,
      goalEmbedding: input.goalEmbedding,
      inputEmbedding: input.inputEmbedding ?? [],
      source: input.source ?? "explicit",
      revokedAt: null,
      revokedBy: null,
    };
  }

  async lookup(scope: ApprovalScope, fingerprintHash: string): Promise<ApprovalRecord | null> {
    const r = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: pk(scope), sk: sk(fingerprintHash) },
      }),
    );
    if (!r.Item) return null;
    if (r.Item.revokedAt) return null;
    if (new Date(r.Item.expiresAt).getTime() < Date.now()) return null;
    return itemToRecord(r.Item);
  }

  async touchLastUsed(scope: ApprovalScope, fingerprintHash: string): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
    const ttl = ttlEpochFor(expiresAt);
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: pk(scope), sk: sk(fingerprintHash) },
          UpdateExpression:
            "SET lastUsedAt = :now, expiresAt = :exp, #ttl = :ttl, " +
            "useCount = if_not_exists(useCount, :zero) + :one",
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(revokedAt)",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: {
            ":now": now.toISOString(),
            ":exp": expiresAt,
            ":ttl": ttl,
            ":zero": 0,
            ":one": 1,
          },
        }),
      );
    } catch (err: any) {
      // Race with revoke / already-expired — silently skip.
      if (err?.name === "ConditionalCheckFailedException") return;
      throw err;
    }
  }

  async listByOwner(ownerSub: string, limit = 200): Promise<ApprovalRecord[]> {
    const r = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI_NAME,
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": userGsiPk(ownerSub) },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (r.Items ?? []).map(itemToRecord);
  }

  async listAll(limit = 500): Promise<ApprovalRecord[]> {
    // Scan with active filter — same pattern as jaid-api-keys.listAll.
    // Approvals table is bounded by user count × project count ×
    // fingerprints, with 30d TTL, so practical cardinality stays small.
    const items: Record<string, any>[] = [];
    let cursor: Record<string, any> | undefined;
    do {
      const r = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: "attribute_not_exists(revokedAt)",
          Limit: 100,
          ExclusiveStartKey: cursor,
        }),
      );
      if (r.Items) items.push(...r.Items);
      cursor = r.LastEvaluatedKey;
      if (items.length >= limit) break;
    } while (cursor);
    items.sort((a, b) => String(b.grantedAt ?? "").localeCompare(String(a.grantedAt ?? "")));
    return items.slice(0, limit).map(itemToRecord);
  }

  async listForScope(scope: ApprovalScope, limit = 200): Promise<ApprovalRecord[]> {
    // Hot path for pattern-trust learning. pk encodes (ownerSub,
    // projectRoot) so a single Query returns every approval in scope.
    // Filter out revoked / expired in code — keeps the FilterExpression
    // off the read path so we get accurate Limit semantics.
    const r = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk(scope) },
        Limit: limit * 2, // headroom for revoked rows we'll filter out
      }),
    );
    const nowMs = Date.now();
    const live = (r.Items ?? [])
      .filter((it) => !it.revokedAt)
      .filter((it) => new Date(String(it.expiresAt ?? "")).getTime() >= nowMs)
      .sort((a, b) => String(b.grantedAt ?? "").localeCompare(String(a.grantedAt ?? "")))
      .slice(0, limit);
    return live.map(itemToRecord);
  }

  async revoke(scope: ApprovalScope, fingerprintHash: string, revokedBy: string): Promise<boolean> {
    const revokedAt = new Date().toISOString();
    // Keep revoked rows briefly for audit (1 day) then let DDB TTL them.
    const revokedTtl = nowEpochSec() + 24 * 60 * 60;
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: pk(scope), sk: sk(fingerprintHash) },
          UpdateExpression:
            "SET revokedAt = :ra, revokedBy = :rb, #ttl = :ttl REMOVE gsi1pk, gsi1sk",
          ConditionExpression:
            "attribute_exists(pk) AND attribute_not_exists(revokedAt)",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: {
            ":ra": revokedAt,
            ":rb": revokedBy,
            ":ttl": revokedTtl,
          },
        }),
      );
      return true;
    } catch (err: any) {
      if (err?.name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  }
}
