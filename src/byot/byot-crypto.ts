// src/byot/byot-crypto.ts
import {
  KMSClient,
  EncryptCommand,
  DecryptCommand,
} from "@aws-sdk/client-kms";

/** Encryption context binds a ciphertext to its owner: a blob encrypted
 *  for user A cannot be decrypted in the context of user B. */
export type EncryptionContext = { ownerSub: string };

export interface ByotCrypto {
  encrypt(plaintext: string, ctx: EncryptionContext): Promise<string>;
  decrypt(ciphertext: string, ctx: EncryptionContext): Promise<string>;
}

export interface KmsByotCryptoOptions {
  keyId: string;
  region: string;
  /** Override for tests. */
  client?: KMSClient;
}

/** Direct KMS Encrypt/Decrypt. A bearer token is well under the 4 KB KMS
 *  limit, so no envelope/data-key machinery is needed. */
export class KmsByotCrypto implements ByotCrypto {
  private readonly keyId: string;
  private readonly client: KMSClient;
  constructor(opts: KmsByotCryptoOptions) {
    this.keyId = opts.keyId;
    this.client = opts.client ?? new KMSClient({ region: opts.region });
  }
  async encrypt(plaintext: string, ctx: EncryptionContext): Promise<string> {
    const out = await this.client.send(new EncryptCommand({
      KeyId: this.keyId,
      Plaintext: new TextEncoder().encode(plaintext),
      EncryptionContext: { ownerSub: ctx.ownerSub },
    }));
    return Buffer.from(out.CiphertextBlob as Uint8Array).toString("base64");
  }
  async decrypt(ciphertext: string, ctx: EncryptionContext): Promise<string> {
    const out = await this.client.send(new DecryptCommand({
      CiphertextBlob: Buffer.from(ciphertext, "base64"),
      EncryptionContext: { ownerSub: ctx.ownerSub },
    }));
    return new TextDecoder().decode(out.Plaintext as Uint8Array);
  }
}

/** Dev/test crypto: base64 with the encryption context prefixed so a
 *  context mismatch fails the same way KMS would. NOT secure — only used
 *  when no KMS key is configured (local STORE_BACKEND=memory). */
export class FakeByotCrypto implements ByotCrypto {
  async encrypt(plaintext: string, ctx: EncryptionContext): Promise<string> {
    return Buffer.from(`${ctx.ownerSub}::${plaintext}`).toString("base64");
  }
  async decrypt(ciphertext: string, ctx: EncryptionContext): Promise<string> {
    const decoded = Buffer.from(ciphertext, "base64").toString("utf8");
    const sep = decoded.indexOf("::");
    const owner = decoded.slice(0, sep);
    if (owner !== ctx.ownerSub) throw new Error("encryption context mismatch");
    return decoded.slice(sep + 2);
  }
}
