// src/byot/types.ts
/**
 * Credential identity passed to bedrock-client per call. `default` =
 * the platform Fargate task role (module-level singleton client).
 * `bearer` = a user-supplied Amazon Bedrock API key bound to a region.
 *
 * Extensible: a future `assume-role` variant slots in here and
 * bedrock-client learns to build a client from it — no call-site churn.
 */
export type BedrockAuth =
  | { kind: "default" }
  | {
      kind: "bearer";
      token: string;
      region: string;
      /** When true, bedrock-client throws on auth failure instead of
       *  falling back to the platform role. Used by the capability
       *  probe so a broken token surfaces instead of being masked. */
      noFallback?: boolean;
    };

export type ByotProvider = "bedrock-bearer";

export type ByotConfigStatus =
  | "active"
  | "validation-failed"
  | "runtime-fallback"
  | "error";

/** Stored row (ciphertext is opaque to the store — crypto lives elsewhere). */
export interface ByotConfigRecord {
  ownerSub: string;
  provider: ByotProvider;
  region: string;
  ciphertext: string;
  last4: string;
  status: ByotConfigStatus;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string | null;
  lastFallbackAt?: string | null;
  lastFallbackReason?: string | null;
}

/** Non-sensitive projection returned by the dashboard GET — never the token. */
export interface ByotConfigStatusView {
  configured: boolean;
  provider?: ByotProvider;
  region?: string;
  last4?: string;
  status?: ByotConfigStatus;
  createdAt?: string;
  updatedAt?: string;
  lastValidatedAt?: string | null;
  lastFallbackAt?: string | null;
  lastFallbackReason?: string | null;
}
