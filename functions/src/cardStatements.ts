import {
  CardBilling,
  cardBillingOf,
  ImputationBasis,
  installmentCountOf,
  paymentMonthIndex,
  prorateInstallmentCents,
  storedDateValue,
  zonedDateKey
} from "./http";

// Port of src/lib/cardStatements.ts: ledger of one credit card for the "Pagos" budget basis.
// Every charge on the card (expense installments, transfers out, other debits) belongs to the
// statement paid in its payment month. Every credit (transfers in, refunds, cashback) pays
// statements oldest first, in date order, and counts in the month it was made. What is still
// unpaid of a statement counts in its payment month. So money paid early, like a transfer in
// October for the statement due in November, counts in October and not again in November.
// Months are local calendar months in the given time zone (the server clock runs in UTC).

export interface CardLedgerTransaction {
  type: string;
  amount: number;
  /** Date, Firestore Timestamp or legacy date-only string (see storedDateValue). */
  date: unknown;
  installments?: number | null;
  accountId?: string | null;
  toAccountId?: string | null;
}

export interface CardLedgerAccount {
  id: string;
  balance?: number | null;
}

export interface CardStatementLedger {
  /** Share of the statement paid in `paymentBucket` that counts in `targetBucket` (buckets are year * 12 + month). */
  weight: (paymentBucket: number, targetBucket: number) => number;
  /** Still unpaid of every statement paid up to `paymentBucket`, overdue ones included. */
  pendingThrough: (paymentBucket: number) => number;
}

const cents = (value: number) => Math.round(value * 100);

/** Local calendar day (0-based month) of `date` in `timeZone`. */
function localDay(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const [year, month, day] = zonedDateKey(date, timeZone).split("-").map(Number);
  return { year, month: month - 1, day };
}

interface Statement {
  totalCents: number;
  remainingCents: number;
  paidByMonth: Map<number, number>;
}

export function buildCardStatementLedger(
  account: CardLedgerAccount,
  billing: CardBilling,
  transactions: readonly CardLedgerTransaction[],
  timeZone: string
): CardStatementLedger {
  const statements = new Map<number, Statement>();
  const credits: { bucket: number; time: number; cents: number }[] = [];
  let ledgerDeltaCents = 0;

  const charge = (bucket: number, amountCents: number) => {
    if (amountCents <= 0) return;
    const statement = statements.get(bucket) ?? { totalCents: 0, remainingCents: 0, paidByMonth: new Map() };
    statement.totalCents += amountCents;
    statement.remainingCents += amountCents;
    statements.set(bucket, statement);
  };
  const monthBucket = (date: Date) => {
    const local = localDay(date, timeZone);
    return local.year * 12 + local.month;
  };
  const paymentBucket = (date: Date) => {
    const local = localDay(date, timeZone);
    return paymentMonthIndex(local.year, local.month, local.day, billing);
  };

  for (const transaction of transactions) {
    const date = storedDateValue(transaction.date, timeZone);
    if (Number.isNaN(date.getTime()) || !Number.isFinite(transaction.amount)) continue;
    const amountCents = Math.abs(cents(transaction.amount));
    const fromCard = transaction.accountId === account.id;
    const toCard = transaction.type === "transfer" && transaction.toAccountId === account.id;
    if (!fromCard && !toCard) continue;

    if (transaction.type === "transfer") {
      if (fromCard && toCard) continue;
      if (fromCard) {
        ledgerDeltaCents -= amountCents;
        charge(paymentBucket(date), amountCents);
      } else {
        ledgerDeltaCents += amountCents;
        credits.push({ bucket: monthBucket(date), time: date.getTime(), cents: amountCents });
      }
    } else if (transaction.amount < 0 || transaction.type === "expense") {
      ledgerDeltaCents -= amountCents;
      const first = paymentBucket(date);
      const installments = installmentCountOf(transaction.installments);
      for (let index = 0; index < installments; index++) {
        charge(first + index, cents(prorateInstallmentCents(transaction.amount, installments, index)));
      }
    } else {
      ledgerDeltaCents += amountCents;
      credits.push({ bucket: monthBucket(date), time: date.getTime(), cents: amountCents });
    }
  }

  // Debt or credit the card already had before its first recorded movement.
  const balanceCents = cents(Number(account.balance ?? 0));
  const openingCents = Number.isFinite(balanceCents) ? balanceCents - ledgerDeltaCents : 0;
  const buckets = [...statements.keys()];
  const earliest = buckets.length > 0 ? Math.min(...buckets) : 0;
  if (openingCents < 0) charge(earliest - 1, -openingCents);
  else if (openingCents > 0) credits.push({ bucket: earliest - 1, time: -Infinity, cents: openingCents });

  const ordered = [...statements.entries()].sort(([a], [b]) => a - b).map(([, statement]) => statement);
  credits.sort((a, b) => a.time - b.time);
  let next = 0;
  for (const credit of credits) {
    let left = credit.cents;
    while (left > 0 && next < ordered.length) {
      const statement = ordered[next];
      const applied = Math.min(left, statement.remainingCents);
      if (applied > 0) {
        statement.remainingCents -= applied;
        statement.paidByMonth.set(credit.bucket, (statement.paidByMonth.get(credit.bucket) ?? 0) + applied);
        left -= applied;
      }
      if (statement.remainingCents === 0) next++;
    }
  }

  return {
    weight: (paymentBucket, targetBucket) => {
      const statement = statements.get(paymentBucket);
      if (!statement || statement.totalCents === 0) return paymentBucket === targetBucket ? 1 : 0;
      const paid = statement.paidByMonth.get(targetBucket) ?? 0;
      const unpaid = paymentBucket === targetBucket ? statement.remainingCents : 0;
      return (paid + unpaid) / statement.totalCents;
    },
    pendingThrough: paymentBucket => {
      let pendingCents = 0;
      for (const [bucket, statement] of statements) {
        if (bucket <= paymentBucket) pendingCents += statement.remainingCents;
      }
      return pendingCents / 100;
    }
  };
}

/**
 * Billing days by account id for the workspace's regular credit cards (see cardBillingOf),
 * tagged with the imputation basis when it is not the default "payment". With `ledgerInput`
 * (every transaction touching the cards, whole history, and the local time zone) the payment
 * basis also applies the payments made to each card, as the app does (port of
 * createCardBillingLookup); without it, every statement counts whole in its payment month.
 */
export function cardBillingByAccount(
  accounts: { id: string; [key: string]: unknown }[],
  basis: ImputationBasis = "payment",
  ledgerInput?: { transactions: readonly CardLedgerTransaction[]; timeZone: string }
): Map<string, CardBilling> {
  const billing = new Map<string, CardBilling>();
  for (const account of accounts) {
    const days = cardBillingOf(account);
    if (!days) continue;
    if (basis !== "payment") billing.set(account.id, { ...days, basis });
    else if (ledgerInput) {
      const ledgerAccount = { id: account.id, balance: account.balance as number | null | undefined };
      billing.set(account.id, { ...days, ledger: buildCardStatementLedger(ledgerAccount, days, ledgerInput.transactions, ledgerInput.timeZone) });
    } else billing.set(account.id, days);
  }
  return billing;
}
