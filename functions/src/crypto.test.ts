import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiKeyDecryptError,
  decryptApiKey,
  encryptApiKey,
  getEncryptionSecret,
  LEGACY_HARDCODED_SECRET,
  MissingEncryptionSecretError
} from "./crypto";

const SECRET = "test-only-secret-0123456789abcdef";
const API_KEY = "AIzaSyTestOnlyKey_1234567890";

test("getEncryptionSecret fails closed when the env var is missing or blank", () => {
  assert.throws(() => getEncryptionSecret({}), MissingEncryptionSecretError);
  assert.throws(() => getEncryptionSecret({ ENCRYPTION_SECRET: "   " }), MissingEncryptionSecretError);
  assert.equal(getEncryptionSecret({ ENCRYPTION_SECRET: SECRET }), SECRET);
});

test("encrypt/decrypt round-trips with the configured secret", () => {
  const { encryptedData, iv } = encryptApiKey(API_KEY, SECRET);
  assert.notEqual(encryptedData, API_KEY);
  assert.deepEqual(decryptApiKey(encryptedData, iv, SECRET), { apiKey: API_KEY, needsMigration: false });
});

test("ciphertexts from the legacy hardcoded secret still decrypt and are flagged for migration", () => {
  const legacy = encryptApiKey(API_KEY, LEGACY_HARDCODED_SECRET);
  assert.deepEqual(decryptApiKey(legacy.encryptedData, legacy.iv, SECRET), { apiKey: API_KEY, needsMigration: true });
});

test("ciphertexts from an unknown secret are rejected", () => {
  const foreign = encryptApiKey(API_KEY, "some-other-secret-not-configured");
  assert.throws(() => decryptApiKey(foreign.encryptedData, foreign.iv, SECRET), ApiKeyDecryptError);
});

test("malformed stored data is rejected", () => {
  assert.throws(() => decryptApiKey("zz", "not-hex", SECRET), ApiKeyDecryptError);
});
