import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const PREFIX = "v1";

function encryptionKey() {
  const authSecret = process.env.AUTH_SECRET ?? "";
  if (authSecret.length < 32) throw new Error("AI diagnostic encryption is unavailable because AUTH_SECRET is invalid.");
  return Buffer.from(hkdfSync("sha256", authSecret, "ab-ignite-ai-debug", "payload-encryption-v1", 32));
}

export function encryptAiDebugPayload(value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [PREFIX, nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptAiDebugPayload(value: string): string {
  const [version, nonceValue, tagValue, ciphertextValue, extra] = value.split(":");
  if (version !== PREFIX || !nonceValue || !tagValue || ciphertextValue === undefined || extra !== undefined) {
    throw new Error("AI diagnostic payload is invalid or uses an unsupported version.");
  }
  const nonce = Buffer.from(nonceValue, "base64url");
  const tag = Buffer.from(tagValue, "base64url");
  const ciphertext = Buffer.from(ciphertextValue, "base64url");
  if (nonce.byteLength !== 12 || tag.byteLength !== 16) throw new Error("AI diagnostic payload is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
