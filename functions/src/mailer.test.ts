import { test } from "node:test";
import assert from "node:assert/strict";
import { createGmailSender, resolveSmtpConfig, uniqueRecipients } from "./mailer";
import { renderBudgetAlertEmail } from "./templates/budgetAlert";

const baseAlert = {
  categoryName: "Mercado",
  workspaceName: "Casa",
  spent: 850_000,
  budget: 1_000_000,
  currency: "COP",
  monthLabel: "octubre de 2026"
};

test("resolveSmtpConfig returns null when credentials are missing", () => {
  assert.equal(resolveSmtpConfig({ user: "", pass: "secret" }), null);
  assert.equal(resolveSmtpConfig({ user: "a@gmail.com", pass: "  " }), null);
  assert.equal(resolveSmtpConfig({}), null);
});

test("resolveSmtpConfig defaults the sender to the SMTP user and honors ALERTS_FROM", () => {
  assert.deepEqual(resolveSmtpConfig({ user: " a@gmail.com ", pass: "app pass" }), {
    user: "a@gmail.com",
    pass: "app pass",
    from: "Vault <a@gmail.com>"
  });
  assert.equal(resolveSmtpConfig({ user: "a@gmail.com", pass: "x", from: "Alertas <b@gmail.com>" })?.from, "Alertas <b@gmail.com>");
});

test("uniqueRecipients trims, lowercases, dedupes and drops invalid addresses", () => {
  assert.deepEqual(
    uniqueRecipients([" Ana@Mail.com", "ana@mail.com", null, undefined, "", "not-an-email", "luis@mail.com"]),
    ["ana@mail.com", "luis@mail.com"]
  );
});

test("createGmailSender uses the Gmail service with the app password and the configured sender", async () => {
  const calls: { options?: unknown; mail?: Record<string, unknown> } = {};
  const send = createGmailSender({ user: "a@gmail.com", pass: "app-pass", from: "Vault <a@gmail.com>" }, (options) => {
    calls.options = options;
    return { sendMail: async (mail: Record<string, unknown>) => { calls.mail = mail; } };
  });
  await send({ to: ["x@mail.com", "y@mail.com"], subject: "S", html: "<p>H</p>", text: "T" });
  assert.deepEqual(calls.options, { service: "gmail", auth: { user: "a@gmail.com", pass: "app-pass" } });
  assert.deepEqual(calls.mail, { from: "Vault <a@gmail.com>", to: "x@mail.com, y@mail.com", subject: "S", html: "<p>H</p>", text: "T" });
});

test("budget alert email at 80% says the cap is near", () => {
  const email = renderBudgetAlertEmail({ ...baseAlert, threshold: 80 });
  assert.match(email.subject, /cerca del tope/);
  assert.match(email.subject, /Mercado/);
  assert.match(email.text, /Estás cerca del tope/);
  assert.match(email.text, /85 %/);
  assert.match(email.text, /Disponible: .*150\.000/);
  assert.match(email.html, /Estás cerca del tope/);
  assert.doesNotMatch(email.text, /ya alcanzaste/i);
});

test("budget alert email at 100% says the cap was reached and shows the overspend", () => {
  const email = renderBudgetAlertEmail({ ...baseAlert, threshold: 100, spent: 1_200_000 });
  assert.match(email.subject, /alcanzaste el tope/);
  assert.match(email.text, /Ya alcanzaste el tope/);
  assert.match(email.text, /120 %/);
  assert.match(email.text, /Disponible: .*0/);
  assert.match(email.text, /Te pasaste por: .*200\.000/);
  assert.doesNotMatch(email.text, /cerca del tope/);
});

test("budget alert email escapes user-provided names in HTML and strips newlines from the subject", () => {
  const email = renderBudgetAlertEmail({
    ...baseAlert,
    threshold: 80,
    categoryName: "<script>alert(\"x\")</script>\r\nBcc: evil@x.com",
    workspaceName: "Tom & Jerry's"
  });
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(email.html, /Tom &amp; Jerry&#39;s/);
  assert.doesNotMatch(email.subject, /[\r\n]/);
});

test("budget alert email falls back to plain numbers for an unknown currency code", () => {
  const email = renderBudgetAlertEmail({ ...baseAlert, threshold: 80, currency: "NOPE!" });
  assert.match(email.text, /850000(\.00)? NOPE!/);
});
