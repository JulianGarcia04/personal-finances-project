import { test } from "node:test";
import assert from "node:assert/strict";
import { cardBillingByAccount as reExported } from "./agentQueries";
import { buildCardStatementLedger, cardBillingByAccount, CardLedgerTransaction } from "./cardStatements";
import { CardBilling, cardBillingOf, expenseAmountForMonth } from "./http";

// Port of src/lib/cardStatements.test.ts with the same expected values. Every movement is at
// noon UTC and the ledger runs in UTC, so no date straddles midnight.
const UTC = "UTC";

// Closing 15, due 4: a purchase on 3-oct is on the statement closed 15-oct, paid 4-nov.
const card = (balance: number) => ({ id: "nu", type: "credit", statementClosingDay: 15, paymentDueDay: 4, balance });
const BILLING: CardBilling = { statementClosingDay: 15, paymentDueDay: 4 };
const expense = (day: string, amount: number, installments = 1) =>
  ({ type: "expense", amount: -amount, date: new Date(`${day}T12:00:00Z`), installments, accountId: "nu" });
const payment = (day: string, amount: number) =>
  ({ type: "transfer", amount, date: new Date(`${day}T12:00:00Z`), accountId: "savings", toAccountId: "nu" });
const OCT = [2026, 9] as const;
const NOV = [2026, 10] as const;
const DEC = [2026, 11] as const;

// Server counterpart of createCardBillingLookup(accounts, "payment", { transactions }): the
// card's billing days with its statement ledger attached.
const paymentsView = (transactions: CardLedgerTransaction[], balance: number) => {
  const account = card(balance);
  const days = cardBillingOf(account) as CardBilling;
  const billing: CardBilling = { ...days, ledger: buildCardStatementLedger(account, days, transactions, UTC) };
  return (tx: ReturnType<typeof expense>, [year, month]: readonly [number, number]) =>
    expenseAmountForMonth(tx, year, month, UTC, billing);
};

test("an early payment counts in the month it was paid, not again in the due month", () => {
  const purchase = expense("2026-10-03", 1000);
  const amountIn = paymentsView([purchase, payment("2026-10-04", 1000)], 0);
  assert.equal(amountIn(purchase, OCT), 1000);
  assert.equal(amountIn(purchase, NOV), 0);
});

test("a payment funded by a pocket settles the statement once, like a payment from its bank", () => {
  const purchase = expense("2026-10-03", 1000);
  const fromPocket = { ...payment("2026-10-04", 1000), accountId: "savings-pocket" };
  const amountIn = paymentsView([purchase, fromPocket], 0);
  assert.equal(amountIn(purchase, OCT), 1000);
  assert.equal(amountIn(purchase, NOV), 0);
  const ledger = buildCardStatementLedger(card(0), BILLING, [purchase, fromPocket], UTC);
  assert.equal(ledger.pendingThrough(2026 * 12 + 10), 0);
});

test("the unpaid rest of a statement stays in its payment month", () => {
  const purchase = expense("2026-10-03", 1000);
  const amountIn = paymentsView([purchase, payment("2026-10-20", 400)], -600);
  assert.equal(amountIn(purchase, OCT), 400);
  assert.equal(amountIn(purchase, NOV), 600);
});

test("without payments the payment view keeps the statement payment month", () => {
  const purchase = expense("2026-10-03", 1000);
  const amountIn = paymentsView([purchase], -1000);
  assert.equal(amountIn(purchase, OCT), 0);
  assert.equal(amountIn(purchase, NOV), 1000);
});

test("payments settle the oldest statement first", () => {
  const september = expense("2026-09-10", 300); // statement paid 4-oct
  const october = expense("2026-10-03", 1000); // statement paid 4-nov
  const amountIn = paymentsView([september, october, payment("2026-10-01", 500)], -800);
  assert.equal(amountIn(september, OCT), 300);
  assert.equal(amountIn(october, OCT), 200);
  assert.equal(amountIn(october, NOV), 800);
});

test("charges that are not expenses share the statement with expenses", () => {
  const purchase = expense("2026-10-03", 1000);
  const lent = { type: "transfer", amount: 1000, date: new Date("2026-10-05T12:00:00Z"), accountId: "nu", toAccountId: "receivable" };
  const amountIn = paymentsView([purchase, lent, payment("2026-10-20", 1000)], -1000);
  assert.equal(amountIn(purchase, OCT), 500);
  assert.equal(amountIn(purchase, NOV), 500);
});

test("each installment follows the payments of its own statement", () => {
  const purchase = expense("2026-10-03", 300, 3); // 100 on the statements paid in nov, dec and jan
  const amountIn = paymentsView([purchase, payment("2026-10-20", 100)], -200);
  assert.equal(amountIn(purchase, OCT), 100);
  assert.equal(amountIn(purchase, NOV), 0);
  assert.equal(amountIn(purchase, DEC), 100);
});

test("debt from before the first movement is paid before recorded statements", () => {
  const purchase = expense("2026-10-03", 1000);
  // Balance -1500 with 1000 recorded charges and a 500 payment: 1000 of debt existed already.
  const amountIn = paymentsView([purchase, payment("2026-10-20", 500)], -1500);
  assert.equal(amountIn(purchase, OCT), 0);
  assert.equal(amountIn(purchase, NOV), 1000);
});

test("the consumption basis ignores payments", () => {
  const purchase = expense("2026-10-03", 1000);
  const ledger = buildCardStatementLedger(card(0), BILLING, [purchase, payment("2026-10-04", 1000)], UTC);
  const billing: CardBilling = { ...BILLING, basis: "consumption", ledger };
  assert.equal(expenseAmountForMonth(purchase, OCT[0], OCT[1], UTC, billing), 1000);
  assert.equal(expenseAmountForMonth(purchase, NOV[0], NOV[1], UTC, billing), 0);
});

const ledgerFor = (transactions: CardLedgerTransaction[], balance: number) =>
  buildCardStatementLedger(card(balance), BILLING, transactions, UTC);
const bucket = (year: number, month: number) => year * 12 + month;

test("pendingThrough is what is still unpaid of the statements due up to that month", () => {
  const october = expense("2026-10-03", 1000); // due 4-nov
  const november = expense("2026-10-20", 300); // due 4-dec
  const ledger = ledgerFor([october, november, payment("2026-10-04", 600)], -700);
  assert.equal(ledger.pendingThrough(bucket(2026, 10)), 400);
  assert.equal(ledger.pendingThrough(bucket(2026, 11)), 700);
});

test("pendingThrough is zero for a statement paid early and counts card charges that are not expenses", () => {
  const purchase = expense("2026-10-03", 1000);
  const lent = { type: "transfer", amount: 500, date: new Date("2026-10-05T12:00:00Z"), accountId: "nu", toAccountId: "receivable" };
  assert.equal(ledgerFor([purchase, lent, payment("2026-10-16", 1500)], 0).pendingThrough(bucket(2026, 10)), 0);
  assert.equal(ledgerFor([purchase, lent], -1500).pendingThrough(bucket(2026, 10)), 1500);
});

// Server-only rule: statement and payment months are the local calendar days in the given time zone.
test("the ledger reads purchase and payment days in the given time zone", () => {
  // 16-oct 03:00 UTC is still 15-oct (the closing day) in Bogotá: statement paid 4-nov, not 4-dec.
  const purchase = { ...expense("2026-10-03", 1000), date: new Date("2026-10-16T03:00:00Z") };
  // 1-nov 03:00 UTC is still 31-oct in Bogotá: the payment counts in October.
  const paid = { ...payment("2026-10-04", 1000), date: new Date("2026-11-01T03:00:00Z") };
  const account = card(0);
  const billing: CardBilling = { ...BILLING, ledger: buildCardStatementLedger(account, BILLING, [purchase, paid], "America/Bogota") };
  assert.equal(expenseAmountForMonth(purchase, OCT[0], OCT[1], "America/Bogota", billing), 1000);
  assert.equal(expenseAmountForMonth(purchase, NOV[0], NOV[1], "America/Bogota", billing), 0);
  assert.equal(expenseAmountForMonth(purchase, DEC[0], DEC[1], "America/Bogota", billing), 0);
});

// --- Card movements other than purchases and bank payments (frontend values, same ledger rules) ---

test("a refund or cashback on the card pays the oldest statement and counts in the month it was made", () => {
  const purchase = expense("2026-10-03", 1000);
  const refund = { type: "income", amount: 200, date: new Date("2026-10-10T12:00:00Z"), accountId: "nu" };
  const amountIn = paymentsView([purchase, refund], -800);
  assert.equal(amountIn(purchase, OCT), 200);
  assert.equal(amountIn(purchase, NOV), 800);
  assert.equal(ledgerFor([purchase, refund], -800).pendingThrough(bucket(2026, 10)), 800);
});

test("a loan repayment received on the card pays its statements like a payment", () => {
  const purchase = expense("2026-10-03", 1000);
  const repaid = { type: "loan_payment", amount: 1000, date: new Date("2026-10-20T12:00:00Z"), accountId: "nu" };
  const amountIn = paymentsView([purchase, repaid], 0);
  assert.equal(amountIn(purchase, OCT), 1000);
  assert.equal(amountIn(purchase, NOV), 0);
});

test("a loan drawn on the card is a charge that shares its statement with the purchases", () => {
  const purchase = expense("2026-10-03", 1000);
  const lent = { type: "loan", amount: -500, date: new Date("2026-10-05T12:00:00Z"), accountId: "nu" };
  const movements = [purchase, lent, payment("2026-10-20", 750)];
  const amountIn = paymentsView(movements, -750);
  assert.equal(amountIn(purchase, OCT), 500);
  assert.equal(amountIn(purchase, NOV), 500);
  assert.equal(ledgerFor(movements, -750).pendingThrough(bucket(2026, 10)), 750);
});

test("credit the card already had before its first movement pays the first statement", () => {
  const purchase = expense("2026-10-03", 1000);
  // Balance -700 after a 1000 purchase: the card held 300 of credit before it.
  const amountIn = paymentsView([purchase], -700);
  assert.equal(amountIn(purchase, OCT), 300);
  assert.equal(amountIn(purchase, NOV), 700);
  assert.equal(ledgerFor([purchase], -700).pendingThrough(bucket(2026, 10)), 700);
});

test("a transfer from the card to itself moves nothing", () => {
  const purchase = expense("2026-10-03", 1000);
  const itself = { type: "transfer", amount: 500, date: new Date("2026-10-05T12:00:00Z"), accountId: "nu", toAccountId: "nu" };
  const amountIn = paymentsView([purchase, itself], -1000);
  assert.equal(amountIn(purchase, OCT), 0);
  assert.equal(amountIn(purchase, NOV), 1000);
  assert.equal(ledgerFor([purchase, itself], -1000).pendingThrough(bucket(2026, 10)), 1000);
});

// Server-only rule (as in http.ts expenseAmountForMonth): only a positive integer is an installment
// count; anything else, a numeric string included, is one installment.
test("an installment count that is not a positive integer charges the whole purchase on one statement", () => {
  for (const installments of [2.5, 0, -1, null, "3"]) {
    const purchase = { ...expense("2026-10-03", 1000), installments } as unknown as ReturnType<typeof expense>;
    const amountIn = paymentsView([purchase], -1000);
    assert.deepEqual([amountIn(purchase, OCT), amountIn(purchase, NOV), amountIn(purchase, DEC)], [0, 1000, 0], String(installments));
    assert.equal(ledgerFor([purchase], -1000).pendingThrough(bucket(2026, 11)), 1000, String(installments));
  }
});

// Seeded random cards (like the frontend/server parity probe): every purchase is counted exactly
// once across the months, and what is left unpaid is the card's debt.
test("on random cards each purchase adds up to its amount over the months and the unpaid rest is the card debt", () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)];
  const randomDate = () => new Date(Date.UTC(2025 + Math.floor(random() * 2), Math.floor(random() * 12), 1 + Math.floor(random() * 28), Math.floor(random() * 24)));
  const randomAmount = () => Math.round((random() * 2_000_000 + 1) * 100) / 100;
  for (let card = 0; card < 300; card++) {
    const billing: CardBilling = { statementClosingDay: 1 + Math.floor(random() * 31), paymentDueDay: 1 + Math.floor(random() * 31) };
    const balance = random() < 0.3 ? 0 : -Math.round(random() * 3_000_000) + (random() < 0.2 ? 5_000_000 : 0);
    const movements: CardLedgerTransaction[] = Array.from({ length: 2 + Math.floor(random() * 25) }, () => {
      const kind = pick(["expense", "expense", "expense", "in", "out", "income", "loan_payment", "loan"] as const);
      const date = randomDate();
      if (kind === "expense") return { type: "expense", amount: -randomAmount(), date, installments: pick([1, 1, 3, 6, 12]), accountId: "nu" };
      if (kind === "in") return { type: "transfer", amount: randomAmount(), date, accountId: "bank", toAccountId: "nu" };
      if (kind === "out") return { type: "transfer", amount: randomAmount(), date, accountId: "nu", toAccountId: "bank" };
      if (kind === "loan") return { type: "loan", amount: -randomAmount(), date, accountId: "nu" };
      return { type: kind, amount: randomAmount() / 10, date, accountId: "nu" };
    });
    const ledger = buildCardStatementLedger({ id: "nu", balance }, billing, movements, UTC);
    const withLedger: CardBilling = { ...billing, ledger };
    for (const movement of movements) {
      if (movement.type !== "expense") continue;
      let counted = 0;
      let months = 0;
      for (let target = 2024 * 12; target < 2028 * 12; target++) {
        const share = expenseAmountForMonth(movement, Math.floor(target / 12), target % 12, UTC, withLedger);
        if (share !== 0) months++;
        counted += share;
      }
      // Each month's share is rounded to the cent.
      assert.ok(Math.abs(counted - Math.abs(movement.amount)) <= 0.005 * months + 1e-6, `card ${card}: ${counted} vs ${movement.amount}`);
    }
    assert.equal(ledger.pendingThrough(2100 * 12), Math.max(0, -balance), `card ${card}`);
  }
});

test("cardBillingByAccount lives with the ledger and agentQueries re-exports the same function", () => {
  assert.equal(reExported, cardBillingByAccount);
});
