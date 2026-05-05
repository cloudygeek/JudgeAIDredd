/**
 * Sensitive-env-var detection. Stand-alone module so both InMemorySessionStore
 * and DynamoSessionStore can call it without creating a circular import
 * with server-core.ts (which imports the stores).
 *
 * Two heuristics, OR-combined:
 *
 *  1. NAME suggests credential. Extended over the original
 *     KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|API regex to catch URL-style
 *     vars (DATABASE_URL, MONGO_URI, REDIS_URL, SMTP_URL, WEBHOOK_URL,
 *     CONNECTION_STRING, DSN…) that frequently embed user:password@host.
 *     Plus AUTH/PRIVATE/PASSWD/SMTP/WEBHOOK families.
 *
 *  2. VALUE looks like a credential regardless of name. Catches secrets
 *     that landed in unconventionally-named vars.
 *
 * False-positive cost is "we redact a non-secret value", which is annoying
 * for debugging but not a security regression. Worth it.
 */
export function isSensitiveEnvVar(name: string, value: string): boolean {
  // 1. Name-based check.
  if (/KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API|AUTH|PRIVATE|DSN|URL|URI|CONNECTION|DATABASE|SMTP|WEBHOOK/i.test(name)) {
    return true;
  }
  // 2. Value-shape checks (only on strings of meaningful length).
  if (typeof value !== "string" || value.length < 8) return false;
  // URL with embedded user:password@host
  if (/^[a-z][a-z0-9+\-.]*:\/\/[^/\s]+:[^@\s]+@/i.test(value)) return true;
  // JWT shape (header.payload.signature where each segment is base64url)
  if (/^eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(value)) return true;
  // AWS access key family (AKIA, ASIA, etc. + 16 alnum chars)
  if (/^A(?:KIA|SIA|GPA|IDA|ROA|IPA|NPA|NVA)[0-9A-Z]{16}$/.test(value)) return true;
  // GitHub PAT (ghp_, gho_, ghu_, ghs_, ghr_)
  if (/^gh[pousr]_[A-Za-z0-9]{30,}$/.test(value)) return true;
  // Stripe keys
  if (/^sk_(?:live|test)_[A-Za-z0-9]{20,}$/.test(value)) return true;
  // Anthropic API keys
  if (/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(value)) return true;
  return false;
}
