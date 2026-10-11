import * as crypto from "crypto";

// Encryption of user-provided Gemini API keys at rest (AES-256-CBC, key = sha256(secret)).

const ALGORITHM = "aes-256-cbc";

/**
 * Secret that was used as a hardcoded fallback when ENCRYPTION_SECRET was unset.
 * It exists ONLY so keys stored under it can still be decrypted and re-encrypted
 * with the real secret (lazy migration). Never use it to encrypt.
 */
export const LEGACY_HARDCODED_SECRET = "vault-local-dev-encryption-secret-key-32-chars-long";

export class MissingEncryptionSecretError extends Error {
  constructor() {
    super("ENCRYPTION_SECRET is not configured; refusing to encrypt or decrypt user API keys.");
    this.name = "MissingEncryptionSecretError";
  }
}

/** Stored ciphertext that no known secret can decrypt into a plausible API key. */
export class ApiKeyDecryptError extends Error {
  constructor() {
    super("Stored API key could not be decrypted with the configured or legacy secret.");
    this.name = "ApiKeyDecryptError";
  }
}

/** Returns the configured secret or throws: there is no silent fallback. */
export function getEncryptionSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env.ENCRYPTION_SECRET?.trim();
  if (!secret) throw new MissingEncryptionSecretError();
  return secret;
}

function deriveKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptApiKey(apiKey: string, secret: string): { encryptedData: string; iv: string } {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(secret), iv);
  const encryptedData = cipher.update(apiKey, "utf8", "hex") + cipher.final("hex");
  return { encryptedData, iv: iv.toString("hex") };
}

// CBC with the wrong key usually fails on padding, but can occasionally "succeed"
// with garbage; API keys are short printable ASCII, so anything else is a failure.
const PLAUSIBLE_API_KEY = /^[\x21-\x7e]{10,200}$/;

function tryDecrypt(encryptedData: string, ivHex: string, secret: string): string | null {
  try {
    const iv = Buffer.from(ivHex, "hex");
    if (iv.length !== 16) return null;
    const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(secret), iv);
    const plaintext = decipher.update(encryptedData, "hex", "utf8") + decipher.final("utf8");
    return PLAUSIBLE_API_KEY.test(plaintext) ? plaintext : null;
  } catch {
    return null;
  }
}

/**
 * Decrypts with the configured secret first; falls back to the legacy hardcoded
 * secret and flags the result so the caller re-encrypts it with the real secret.
 */
export function decryptApiKey(
  encryptedData: string,
  ivHex: string,
  secret: string
): { apiKey: string; needsMigration: boolean } {
  const current = tryDecrypt(encryptedData, ivHex, secret);
  if (current !== null) return { apiKey: current, needsMigration: false };
  if (secret !== LEGACY_HARDCODED_SECRET) {
    const legacy = tryDecrypt(encryptedData, ivHex, LEGACY_HARDCODED_SECRET);
    if (legacy !== null) return { apiKey: legacy, needsMigration: true };
  }
  throw new ApiKeyDecryptError();
}
