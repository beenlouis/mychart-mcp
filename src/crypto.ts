/**
 * Envelope encryption for the Epic refresh token via Cloud KMS.
 *
 * This token is the long-lived key to a child's medical record. It never
 * touches Firestore in plaintext, and it never appears in a log line. KMS
 * means the ciphertext in Firestore is useless on its own: reading the
 * database is not enough, an attacker also needs the KMS decrypt permission.
 */
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { config } from "./config.js";

const kms = new KeyManagementServiceClient();

export async function encryptSecret(plaintext: string): Promise<string> {
  const [r] = await kms.encrypt({
    name: config.gcp.kmsKeyName,
    plaintext: Buffer.from(plaintext, "utf8"),
  });
  if (!r.ciphertext) throw new Error("KMS returned no ciphertext");
  return Buffer.from(r.ciphertext as Uint8Array).toString("base64");
}

export async function decryptSecret(ciphertextB64: string): Promise<string> {
  const [r] = await kms.decrypt({
    name: config.gcp.kmsKeyName,
    ciphertext: Buffer.from(ciphertextB64, "base64"),
  });
  if (!r.plaintext) throw new Error("KMS returned no plaintext");
  return Buffer.from(r.plaintext as Uint8Array).toString("utf8");
}
