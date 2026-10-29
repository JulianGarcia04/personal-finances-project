import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Runs from lib/, so it reads the TypeScript sources that emails, notes and the
// assistant's prompt come from.
const src = join(__dirname, "../src");

test("emails, notes and the assistant call the product Lynor Finanzas, never Vault", () => {
  for (const file of readdirSync(src, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    assert.doesNotMatch(readFileSync(join(src, file), "utf8"), /\b(Vault|VAULT)\b/, file);
  }
});
