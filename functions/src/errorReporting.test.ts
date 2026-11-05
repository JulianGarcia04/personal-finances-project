import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createErrorReporter, errorReportingConfig, scrubError } from "./errorReporting";

// Runs from lib/, so it reads the TypeScript sources the reporter is wired into.
const source = (file: string) => readFileSync(join(__dirname, "../src", file), "utf8");

const configured = { POSTHOG_KEY: " phc_test ", POSTHOG_HOST: "https://eu.i.posthog.com/" };

test("error reporting stays off in the emulator and without a key or a host", () => {
  assert.deepEqual(errorReportingConfig(configured), { key: "phc_test", host: "https://eu.i.posthog.com" });
  assert.equal(errorReportingConfig({ ...configured, FUNCTIONS_EMULATOR: "true" }), null);
  assert.equal(errorReportingConfig({ ...configured, POSTHOG_KEY: "" }), null);
  assert.equal(errorReportingConfig({ POSTHOG_KEY: "phc_test" }), null);
});

test("reported errors lose every number in their message but keep the stack frames", () => {
  const original = new Error("Saldo insuficiente: 1.250.000 de 300,5");
  const scrubbed = scrubError(original);
  assert.equal(scrubbed.message, "Saldo insuficiente: # de #");
  assert.equal(scrubbed.name, "Error");
  const lines = (scrubbed.stack ?? "").split("\n");
  assert.equal(lines[0], "Error: Saldo insuficiente: # de #");
  assert.ok(lines.length > 1 && lines.slice(1).every((line) => /^\s+at /.test(line)));
  assert.equal(scrubError("timeout after 30000 ms").message, "timeout after # ms");
  assert.equal(
    scrubError(new Error("Fallo para ana.probe@example.com en https://x.test/p?q=secret#h")).message,
    "Fallo para [email] en https://x.test/p"
  );
});

test("errors go to PostHog with the caller's uid, or as the server without a person profile", async () => {
  const captured: unknown[][] = [];
  const report = createErrorReporter(configured, () => ({
    captureExceptionImmediate: async (...args: unknown[]) => { captured.push(args); }
  }));
  await report(new Error("fallo 42"), { source: "bridgeSettlement", uid: "uid-1" });
  await report(new Error("fallo"), { source: "parseStatement" });
  assert.equal((captured[0][0] as Error).message, "fallo #");
  assert.equal(captured[0][1], "uid-1");
  assert.deepEqual(captured[0][2], { function: "bridgeSettlement" });
  assert.equal(captured[1][1], "server");
  assert.deepEqual(captured[1][2], { function: "parseStatement", $process_person_profile: false });
});

test("reporting never fails the function and does nothing when not configured", async () => {
  let created = 0;
  const off = createErrorReporter({}, () => { created++; return { captureExceptionImmediate: async () => undefined }; });
  await off(new Error("x"), { source: "chatWithAgent" });
  assert.equal(created, 0);
  const failing = createErrorReporter(configured, () => ({
    captureExceptionImmediate: async () => { throw new Error("network down"); }
  }));
  await assert.doesNotReject(failing(new Error("x"), { source: "chatWithAgent" }));
});

test("HTTP endpoints, callables and triggers report unexpected errors before answering or retrying", () => {
  const index = source("index.ts");
  for (const endpoint of ["saveUserApiKey", "parseStatement", "chatWithAgent", "inviteToWorkspace"]) {
    assert.match(index, new RegExp(`await failRequest\\(res, error, "${endpoint}"\\)`), endpoint);
    assert.doesNotMatch(index, new RegExp(`sendError\\(res, error, "${endpoint}"\\)`), endpoint);
  }
  assert.match(index, /if \(!\(error instanceof HttpError\)\) await reportError\(error, \{ source: context \}\);\n\s+sendError\(res, error, context\);/);
  assert.match(index, /await reportError\(error, \{ source: "syncTransactionEmbedding" \}\);\n\s+throw error; \/\/ transient/);
  assert.match(index, /await reportError\(error, \{ source: "notifyBudgetThreshold" \}\);\n\s+throw error;/);
  assert.match(source("settlements.ts"), /await reportError\(error, \{ source: 'bridgeSettlement', uid: userId \}\)/);
  assert.match(source("pocketImports.ts"), /await reportError\(error, \{ source: 'importPocketStatement', uid: request\.auth\.uid \}\)/);
  assert.match(source("accountDeletion.ts"), /await reportError\(error, \{ source: 'deleteAccount', uid \}\)/);
});
