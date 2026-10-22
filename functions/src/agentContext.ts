import * as admin from "firebase-admin";
import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { createWorkspaceAccount, mutateWorkspaceTransaction } from "./pockets";
import { storedDateValue, zonedDateKey } from "./http";
import {
  AgentToolError,
  localDayRange,
  NameMaps,
  parseLocalDate,
  safeTool,
  signedAmount,
  toLeanTransaction
} from "./agentTools";
import {
  billingLookbackStart,
  budgetBreakdownQueries,
  buildBudgetStatus,
  cardBillingByAccount,
  computeNetWorth,
  previousPeriod,
  resolvePeriod,
  summarize,
  SummaryBudget,
  SummaryOptions,
  SummaryTransaction
} from "./agentQueries";
import { buildLegacyCategoryBudgetsPatch, parseLegacyCategoryBudgetCurrency } from "./legacyCategoryBudgets";
import { cosineSimilarity, EMBEDDINGS_COLLECTION, isEmbeddable, queryEmbeddingInput, toVectorArray } from "./embeddings";

// The chat agent's tools as plain definitions built from (db, context), with no
// Genkit or Gemini dependency, so they can run against the Firestore emulator in
// tests. index.ts registers them with `ai.defineTool`.

export interface AgentToolContext {
  workspaceId: string;
  userId: string;
  timeZone: string;
  /** Primary currency for consolidated amounts (the dashboard's: users.currency). */
  primaryCurrency: string;
  /** Clock for relative periods and default dates (fixed in tests). */
  now?: () => Date;
  /** Query embedder for semanticSearchTransactions (Gemini in production). */
  embedQuery?: (input: string) => Promise<number[]>;
  /**
   * Whether the user's last message answers a confirmation request
   * (`userConfirmedPendingAction`). Without it, `confirmed: true` on destructive
   * tools only returns the summary. Defaults to false.
   */
  confirmationGranted?: boolean;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  /** Validates the input and returns `{ error }` instead of throwing (safeTool). */
  run: (input: unknown) => Promise<unknown>;
}

/** Same source and fallback as the dashboard (settingsStore: `users.currency || 'COP'`). */
export function resolvePrimaryCurrency(userData: admin.firestore.DocumentData | null | undefined): string {
  return typeof userData?.currency === "string" && userData.currency ? userData.currency : "COP";
}

export function buildAgentTools(db: admin.firestore.Firestore, ctx: AgentToolContext): AgentToolDefinition[] {
  const { workspaceId, userId, timeZone, primaryCurrency } = ctx;
  const clock = ctx.now ?? (() => new Date());
  const isConfirmed = (confirmed: boolean | undefined) => confirmed === true && ctx.confirmationGranted === true;
  const awaitingConfirmation = (confirmed: boolean | undefined, ask: string) => confirmed === true
    ? "Aún no hay confirmación del usuario: muestra este resumen y pídele que confirme explícitamente en su próximo mensaje. No digas que la acción se realizó."
    : ask;
  const tools: AgentToolDefinition[] = [];
  const define = <S extends z.ZodTypeAny>(name: string, description: string, inputSchema: S, fn: (input: z.output<S>) => Promise<unknown>) => {
    tools.push({ name, description, inputSchema, run: safeTool(name, inputSchema, fn) });
  };

  // Workspace accounts (names and card billing days), loaded once per request and
  // invalidated by createAccount.
  let accountsPromise: Promise<admin.firestore.QueryDocumentSnapshot[]> | null = null;
  const loadAccounts = (): Promise<admin.firestore.QueryDocumentSnapshot[]> => {
    accountsPromise ??= db.collection('accounts').where('workspaceId', '==', workspaceId).get()
      .then(snapshot => snapshot.docs);
    return accountsPromise;
  };
  const loadCardBilling = async () =>
    cardBillingByAccount((await loadAccounts()).map(docSnap => ({ ...docSnap.data(), id: docSnap.id })));

  // Account and category names, loaded once per request (invalidated by createAccount).
  let namesPromise: Promise<NameMaps> | null = null;
  const loadNames = (): Promise<NameMaps> => {
    namesPromise ??= (async () => {
      const [accounts, workspaceCategories, globalCategories] = await Promise.all([
        loadAccounts(),
        db.collection('categories').where('workspaceId', '==', workspaceId).get(),
        db.collection('categories').where('workspaceId', '==', null).get()
      ]);
      const categories = new Map<string, string>();
      [...globalCategories.docs, ...workspaceCategories.docs].forEach(docSnap => {
        categories.set(docSnap.id, docSnap.data().name || 'Sin nombre');
      });
      return {
        accounts: new Map(accounts.map(docSnap => [docSnap.id, String(docSnap.data().name || 'Sin nombre')])),
        categories
      };
    })();
    return namesPromise;
  };
  const lean = async (docs: { id: string; data: admin.firestore.DocumentData }[]) => {
    const names = await loadNames();
    return docs.map(({ id, data }) => toLeanTransaction(id, data, names, timeZone));
  };
  // Fresh read: settings may change during the chat (saveCategoryBudgets, the app).
  const loadWorkspace = async () => (await db.collection('workspaces').doc(workspaceId).get()).data() ?? {};
  const ratesOf = (ws: admin.firestore.DocumentData) => (ws.exchangeRates ?? {}) as Record<string, number>;

  const movementTypes = ['income', 'expense', 'transfer', 'loan', 'loan_payment'] as const;
  const dateParam = (what: string) => z.string().optional()
    .describe(`${what} en formato YYYY-MM-DD (día local del usuario, inclusivo). Resuelve "hoy", "ayer", "este mes"... con el CONTEXTO ACTUAL.`);
  const confirmedParam = z.boolean().optional()
    .describe('Solo true si el usuario confirmó explícitamente esta acción en su último mensaje. Sin confirmación, la herramienta devuelve un resumen para pedirla.');

  define(
    'listAccounts',
    `Obtiene las cuentas del workspace con saldo, moneda, tipo y saldo convertido a ${primaryCurrency} (balanceInPrimary), más totals.netWorth: el patrimonio neto calculado igual que el panel de control (incluye cupo disponible de tarjetas, bolsillos y cuentas puente). Úsalo para saldos, cupos y "¿cuál es mi patrimonio neto?".`,
    z.object({}),
    async () => {
      const [snapshot, ws] = await Promise.all([
        db.collection('accounts').where('workspaceId', '==', workspaceId).get(),
        loadWorkspace()
      ]);
      const byId = new Map(snapshot.docs.map(docSnap => [docSnap.id, docSnap.data()]));
      const accounts = snapshot.docs.map(docSnap => {
        const data = docSnap.data();
        const balance = Number(data.balance) || 0;
        const account: Record<string, unknown> & { id: string; balance: number } = { id: docSnap.id, name: data.name, type: data.type, balance, currency: data.currency };
        if (data.type === 'credit') {
          const limit = Number(data.limit) || 0;
          Object.assign(account, {
            limit,
            availableCredit: limit + balance,
            statementClosingDay: data.statementClosingDay ?? null,
            paymentDueDay: data.paymentDueDay ?? null
          });
        }
        if (data.parentAccountId) account.pocketOf = byId.get(data.parentAccountId)?.name ?? data.parentAccountId;
        if (data.mirror) account.bridge = true;
        return account;
      });
      return computeNetWorth(accounts, primaryCurrency, ratesOf(ws));
    }
  );

  define(
    'createAccount',
    'Crea una nueva cuenta bancaria, de ahorros, tarjeta de crédito o efectivo, o un bolsillo dentro de una cuenta bancaria.',
    z.object({
      name: z.string().trim().min(1).describe('El nombre de la cuenta (ej. "Banco Principal")'),
      type: z.enum(['checking', 'savings', 'credit', 'cash']).describe('El tipo de cuenta'),
      balance: z.number().describe('El saldo inicial de la cuenta (en tarjetas de crédito, negativo si ya hay deuda)'),
      limit: z.number().min(0).optional().describe('El límite de crédito en caso de tarjetas de crédito (0 por defecto)'),
      currency: z.string().trim().length(3).describe('Código de moneda de 3 caracteres (ej. "COP", "USD", "EUR")'),
      statementClosingDay: z.number().int().min(1).max(31).optional().describe('Día mensual de corte de la tarjeta (1-31)'),
      paymentDueDay: z.number().int().min(1).max(31).optional().describe('Día mensual límite de pago de la tarjeta (1-31)'),
      parentAccountId: z.string().min(1).optional().describe('ID de una cuenta bancaria para crear un bolsillo de ahorros'),
    }),
    async ({ name, type, balance, limit, currency, statementClosingDay, paymentDueDay, parentAccountId }) => {
      const created = await createWorkspaceAccount(db, {
        workspaceId,
        userId,
        name,
        type,
        balance: Number(balance),
        limit,
        currency,
        statementClosingDay,
        paymentDueDay,
        parentAccountId
      });
      namesPromise = null;
      accountsPromise = null;
      const { id, type: createdType, balance: createdBalance, currency: createdCurrency } = created as Record<string, unknown>;
      return { success: true, id, name: created.name, type: createdType, balance: createdBalance, currency: createdCurrency };
    }
  );

  define(
    'listTransactions',
    'Lista transacciones del workspace (más recientes primero), con filtros opcionales por cuenta, tipo y rango de fechas. Con accountId incluye también las transferencias que llegan a esa cuenta. Los montos conservan su signo (gastos negativos).',
    z.object({
      accountId: z.string().min(1).optional().describe('Filtrar por el ID de una cuenta (origen o destino de transferencias)'),
      type: z.enum(movementTypes).optional().describe('Filtrar por tipo (ingreso, egreso, transferencia, préstamo dado o pago de préstamo recibido)'),
      startDate: dateParam('Fecha inicial'),
      endDate: dateParam('Fecha final'),
      limit: z.number().optional().describe('Límite de resultados a retornar (por defecto 30, máximo 100)'),
    }),
    async ({ accountId, type, startDate, endDate, limit }) => {
      const cappedLimit = Math.min(Math.max(Math.floor(limit ?? 30), 1), 100);
      const range = localDayRange(startDate, endDate, timeZone);
      const transactions = db.collection('transactions');
      const bounded = (queryRef: admin.firestore.Query) => {
        if (range.start) queryRef = queryRef.where('date', '>=', Timestamp.fromDate(range.start));
        if (range.endExclusive) queryRef = queryRef.where('date', '<', Timestamp.fromDate(range.endExclusive));
        return queryRef.orderBy('date', 'desc').limit(cappedLimit).get();
      };

      let outgoing: admin.firestore.Query = transactions.where('workspaceId', '==', workspaceId);
      if (accountId) outgoing = outgoing.where('accountId', '==', accountId);
      if (type) outgoing = outgoing.where('type', '==', type);
      const queries = [bounded(outgoing)];
      // Only transfers carry toAccountId, so incoming rows matter unless another type is requested.
      if (accountId && (!type || type === 'transfer')) {
        queries.push(bounded(transactions.where('workspaceId', '==', workspaceId).where('toAccountId', '==', accountId)));
      }

      const rows = new Map<string, admin.firestore.DocumentData>();
      (await Promise.all(queries)).forEach(snapshot => snapshot.forEach(docSnap => rows.set(docSnap.id, docSnap.data())));
      const sorted = [...rows.entries()]
        .sort(([, a], [, b]) => (b.date?.toMillis?.() ?? 0) - (a.date?.toMillis?.() ?? 0))
        .slice(0, cappedLimit);
      return {
        period: { start: startDate ?? null, end: endDate ?? null },
        count: sorted.length,
        mayHaveMore: sorted.length === cappedLimit,
        transactions: await lean(sorted.map(([id, data]) => ({ id, data })))
      };
    }
  );

  define(
    'createTransaction',
    'Registra un movimiento de dinero (ingreso, gasto, transferencia interna entre cuentas, préstamo dado a alguien o pago de préstamo recibido). Actualiza automáticamente el saldo de las cuentas. Usa el id de cuenta exacto que devuelve listAccounts. Los bolsillos y las cuentas que tienen bolsillos solo admiten ingresos, gastos y transferencias: los préstamos (loan, loan_payment) deben registrarse en otra cuenta.',
    z.object({
      accountId: z.string().min(1).describe('El ID de la cuenta de origen'),
      amount: z.number().describe('El monto en valor absoluto (siempre positivo). El servidor aplica el signo según el tipo.'),
      description: z.string().trim().min(1).describe('La descripción detallada de la transacción'),
      categoryId: z.string().optional().describe('El ID de la categoría (vacío para transferencias y préstamos)'),
      type: z.enum(movementTypes).describe('El tipo de movimiento'),
      toAccountId: z.string().optional().describe('El ID de la cuenta destino (requerido únicamente para transferencias)'),
      date: dateParam('Fecha del movimiento (por defecto hoy)'),
      installments: z.number().int().min(1).max(60).optional().describe('Número de cuotas (1-60) para una compra en tarjeta de crédito'),
    }),
    async ({ accountId, amount, description, categoryId, type, toAccountId, date, installments }) => {
      if (toAccountId && type !== 'transfer') {
        throw new AgentToolError("La cuenta destino solo se permite para transferencias.");
      }
      const signed = signedAmount(amount, type);
      const movementDate = date ? parseLocalDate(date, timeZone) : clock();
      const accountSnap = await db.collection('accounts').doc(accountId).get();
      const account = accountSnap.data();
      if (!accountSnap.exists || account?.workspaceId !== workspaceId) {
        throw new AgentToolError("La cuenta origen no existe en el workspace activo. Usa listAccounts para obtener el ID correcto.");
      }
      if (type === 'expense' && account?.mirror) {
        throw new AgentToolError("Esa es una cuenta puente (gasto compartido). Registra los gastos compartidos desde la app para que se reflejen también en el otro workspace.");
      }
      const { id } = await mutateWorkspaceTransaction(db, {
        kind: 'created',
        userId,
        workspaceId,
        movement: {
          accountId,
          amount: signed,
          description,
          categoryId,
          type,
          toAccountId: toAccountId || null,
          date: movementDate,
          installments
        }
      });
      return {
        success: true,
        id,
        amount: signed,
        date: zonedDateKey(movementDate, timeZone),
        message: "Transacción agregada y saldos actualizados."
      };
    }
  );

  define(
    'deleteTransaction',
    'Elimina una transacción existente y revierte automáticamente su impacto en los saldos. Sin confirmed: true solo devuelve un resumen para pedir confirmación. El transactionId debe ser el id exacto que devolvió listTransactions o semanticSearchTransactions en esta conversación; si no lo tienes, búscalo primero (nunca inventes ids).',
    z.object({
      transactionId: z.string().min(1).describe('El ID de la transacción a eliminar'),
      confirmed: confirmedParam,
    }),
    async ({ transactionId, confirmed }) => {
      const docSnap = await db.collection('transactions').doc(transactionId).get();
      const data = docSnap.data();
      if (!docSnap.exists || !data || data.workspaceId !== workspaceId) {
        throw new AgentToolError("La transacción no existe en el workspace activo. Búscala con listTransactions (o semanticSearchTransactions) y usa el id exacto que devuelve.");
      }
      if (!isConfirmed(confirmed)) {
        const [summary] = await lean([{ id: docSnap.id, data }]);
        return {
          needsConfirmation: true,
          summary,
          message: awaitingConfirmation(confirmed, "Muestra este resumen y pide confirmación explícita antes de eliminar.")
        };
      }
      await mutateWorkspaceTransaction(db, { kind: 'deleted', transactionId, userId, workspaceId });
      return { success: true, message: "Transacción eliminada y saldos restaurados." };
    }
  );

  define(
    'listCategories',
    'Obtiene las categorías de gastos e ingresos configuradas en el workspace.',
    z.object({}),
    async () => {
      // Same scope as the frontend: categories of the active workspace only.
      const snapshot = await db.collection('categories').where('workspaceId', '==', workspaceId).get();
      return snapshot.docs.map(docSnap => ({ id: docSnap.id, name: docSnap.data().name, type: docSnap.data().type }));
    }
  );

  define(
    'listGoals',
    'Obtiene la lista de todos los objetivos o metas de ahorro del workspace.',
    z.object({}),
    async () => {
      const snapshot = await db.collection('goals').where('workspaceId', '==', workspaceId).get();
      return snapshot.docs.map(docSnap => {
        const data = docSnap.data();
        const targetDate = data.targetDate?.toDate ? data.targetDate.toDate() : null;
        return {
          id: docSnap.id,
          name: data.name,
          targetAmount: data.targetAmount,
          currentAmount: data.currentAmount,
          currency: data.currency,
          targetDate: targetDate ? zonedDateKey(targetDate, timeZone) : null
        };
      });
    }
  );

  define(
    'createGoal',
    'Crea un nuevo objetivo o meta de ahorro (por ejemplo: "Comprar carro" o "Vacaciones").',
    z.object({
      name: z.string().trim().min(1).describe('El nombre descriptivo de la meta'),
      targetAmount: z.number().positive().describe('Monto objetivo de ahorro (positivo)'),
      currentAmount: z.number().min(0).optional().describe('Monto inicial ya ahorrado (por defecto 0)'),
      currency: z.string().trim().length(3).describe('Código de moneda de 3 caracteres (ej. "COP", "USD")'),
      targetDate: z.string().describe('Fecha estimada de cumplimiento en formato YYYY-MM-DD (día local del usuario)'),
    }),
    async ({ name, targetAmount, currentAmount, currency, targetDate }) => {
      const parsedDate = parseLocalDate(targetDate, timeZone);
      const newGoalRef = db.collection('goals').doc();
      const newGoal = {
        workspaceId,
        userId,
        name,
        targetAmount: Number(targetAmount),
        currentAmount: Number(currentAmount || 0),
        currency: currency.toUpperCase(),
        targetDate: Timestamp.fromDate(parsedDate),
        createdAt: FieldValue.serverTimestamp()
      };
      await newGoalRef.set(newGoal);
      return {
        success: true,
        id: newGoalRef.id,
        name,
        targetAmount: newGoal.targetAmount,
        currentAmount: newGoal.currentAmount,
        currency: newGoal.currency,
        targetDate: zonedDateKey(parsedDate, timeZone)
      };
    }
  );

  define(
    'updateGoalAmount',
    'Actualiza el monto ahorrado acumulado de una meta (envía el nuevo total, no el aporte).',
    z.object({
      goalId: z.string().min(1).describe('El ID del objetivo/meta de ahorro'),
      currentAmount: z.number().min(0).describe('El nuevo saldo acumulado de la meta'),
    }),
    async ({ goalId, currentAmount }) => {
      const goalRef = db.collection('goals').doc(goalId);
      const goalDoc = await goalRef.get();
      if (!goalDoc.exists || goalDoc.data()?.workspaceId !== workspaceId) {
        throw new AgentToolError("La meta de ahorro no existe en el workspace activo.");
      }
      await goalRef.update({ currentAmount: Number(currentAmount) });
      return { success: true, message: `Meta de ahorro actualizada a ${currentAmount}.` };
    }
  );

  define(
    'semanticSearchTransactions',
    'Busca transacciones por significado (embeddings). Útil para preguntas libres como "¿Cuándo fue la última vez que compré ropa?" o "¿Cuánto gasté en el regalo?". No sirve para totales de un periodo.',
    z.object({
      query: z.string().trim().min(1).describe('El término o concepto semántico a buscar'),
      limit: z.number().optional().describe('Cantidad máxima de resultados (por defecto 5, máximo 20)'),
    }),
    async ({ query: queryText, limit }) => {
      let ranked: { id: string; similarity: number }[];
      try {
        if (!ctx.embedQuery) throw new Error("No query embedder configured.");
        const queryVector = await ctx.embedQuery(queryEmbeddingInput(queryText));
        // 3072 dims exceed Firestore's 2048-dim vector limit (values and indexes), so rank in memory over
        // this workspace's server-only embeddings (only the vector field is read).
        const snapshot = await db.collection(EMBEDDINGS_COLLECTION)
          .where('workspaceId', '==', workspaceId)
          .select('embedding')
          .get();
        ranked = [];
        snapshot.forEach(docSnap => {
          const vector = toVectorArray(docSnap.get('embedding'));
          if (vector && vector.length === queryVector.length) {
            ranked.push({ id: docSnap.id, similarity: cosineSimilarity(queryVector, vector) });
          }
        });
      } catch (err) {
        console.error("Error en búsqueda semántica:", err);
        throw new AgentToolError("No se pudo completar la búsqueda semántica. Intenta con listTransactions y un rango de fechas.");
      }
      ranked.sort((a, b) => b.similarity - a.similarity);

      const max = Math.min(Math.max(Math.trunc(limit || 5), 1), 20);
      const top = ranked.slice(0, max * 2); // headroom for deleted/mirror rows
      if (top.length === 0) return { matches: [] };
      const snapshots = await db.getAll(...top.map(match => db.collection('transactions').doc(match.id)));
      const kept: { id: string; data: admin.firestore.DocumentData; similarity: number }[] = [];
      snapshots.forEach((docSnap, index) => {
        const data = docSnap.data();
        if (!data || data.workspaceId !== workspaceId || !isEmbeddable(data) || kept.length >= max) return;
        kept.push({ id: docSnap.id, data, similarity: top[index].similarity });
      });
      const rows = await lean(kept);
      return {
        matches: rows.map((row, index) => ({ ...row, similarity: Math.round(kept[index].similarity * 1000) / 1000 }))
      };
    }
  );

  // One range query plus older installment purchases whose later shares may fall
  // inside the range, and expenses of the two previous months whose card statements may
  // be paid inside it; aggregation itself is pure (agentQueries.ts).
  const loadSummaryRows = async (start: Date, endExclusive: Date): Promise<SummaryTransaction[]> => {
    const transactions = db.collection('transactions').where('workspaceId', '==', workspaceId);
    const [inRange, installmentPurchases, recentExpenses] = await Promise.all([
      transactions
        .where('date', '>=', Timestamp.fromDate(start))
        .where('date', '<', Timestamp.fromDate(endExclusive))
        .orderBy('date', 'desc')
        .get(),
      transactions.where('type', '==', 'expense').where('installments', '>', 1).get(),
      transactions
        .where('type', '==', 'expense')
        .where('date', '>=', Timestamp.fromDate(billingLookbackStart(start, timeZone)))
        .where('date', '<', Timestamp.fromDate(start))
        .orderBy('date', 'desc')
        .get()
    ]);
    return toSummaryRows([...inRange.docs, ...installmentPurchases.docs, ...recentExpenses.docs]);
  };
  const toSummaryRows = (docs: admin.firestore.QueryDocumentSnapshot[]): SummaryTransaction[] => {
    const rows = new Map<string, SummaryTransaction>();
    docs.forEach(docSnap => {
      const data = docSnap.data();
      rows.set(docSnap.id, {
        ...data,
        id: docSnap.id,
        type: String(data.type ?? ''),
        amount: Number(data.amount) || 0,
        date: storedDateValue(data.date, timeZone)
      });
    });
    return [...rows.values()];
  };

  // Budgets for summarize's byBudget: one budgets query; then only what budgetBreakdownQueries asks
  // for: all-time transactions of active event budgets and assigned income of archived ones
  // (budgetId in, chunks of 30), and the workspace's transfers when an active event budget links accounts.
  const loadBudgetBreakdown = async (): Promise<NonNullable<SummaryOptions['budgetBreakdown']>> => {
    const snapshot = await db.collection('budgets').where('workspaceId', '==', workspaceId).get();
    const budgets: SummaryBudget[] = snapshot.docs.map(docSnap => ({ ...docSnap.data(), id: docSnap.id }));
    const plan = budgetBreakdownQueries(budgets);
    if (plan.eventIds.length === 0 && plan.archivedEventIds.length === 0) return { budgets };
    const transactions = db.collection('transactions').where('workspaceId', '==', workspaceId);
    const chunksOf = (ids: string[]) =>
      Array.from({ length: Math.ceil(ids.length / 30) }, (_, index) => ids.slice(index * 30, index * 30 + 30));
    const snapshots = await Promise.all([
      ...chunksOf(plan.eventIds).map(chunk => transactions.where('budgetId', 'in', chunk).get()),
      ...chunksOf(plan.archivedEventIds).map(chunk => transactions.where('type', '==', 'income').where('budgetId', 'in', chunk).get()),
      ...(plan.transfers ? [transactions.where('type', '==', 'transfer').get()] : [])
    ]);
    return { budgets, extraRows: toSummaryRows(snapshots.flatMap(result => result.docs)) };
  };

  define(
    'getFinancialSummary',
    `Resumen financiero de un periodo con la misma lógica del panel de control: ingresos, gastos, neto y tasa de ahorro en la moneda principal (${primaryCurrency}), convertidos con las tasas del workspace, cuotas repartidas por mes (las compras con tarjeta de crédito con día de corte y de pago cuentan en el mes en que se paga su extracto) y sin transferencias ni préstamos. Úsalo SIEMPRE para totales, resúmenes, "¿cuánto gasté…?", gastos por categoría/cuenta/mes/día, comparaciones con el periodo anterior y promedios mensuales (lastCompleteMonths). Define el periodo con preset, con startDate/endDate o con lastCompleteMonths (solo una forma; por defecto el mes en curso). La salida trae period {start, end, label}, totals, groups, topExpenses, comparison y notes. totals es TODO el dinero que entró y salió, sin importar el presupuesto. byBudget (solo para meses calendario completos y sin filtro de cuenta/categoría) separa por presupuesto: monthlyIncome es el ingreso sin el asignado a otros presupuestos (fondos de ese presupuesto), monthlyExpense es el gasto sin el de presupuestos que se pagan con sus propios fondos, y budgets trae por presupuesto funds (fondos), spent (gastado) y available (disponible); funds y available en null sin incomplete significan que el presupuesto no recibió fondos en el periodo (solo tiene gasto); con incomplete, un null significa que falta una tasa de cambio. Fondos negativos significan que salió más plata de la que entró a ese presupuesto.`,
    z.object({
      preset: z.enum(['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_year', 'last_year']).optional()
        .describe('Periodo relativo en la zona horaria del usuario (semanas de lunes a domingo; meses y años calendario completos).'),
      startDate: dateParam('Fecha inicial del periodo personalizado'),
      endDate: dateParam('Fecha final del periodo personalizado (por defecto hoy)'),
      lastCompleteMonths: z.number().int().min(1).max(12).optional()
        .describe('Últimos N meses calendario COMPLETOS, sin el mes en curso. Devuelve averages y monthlyAverageExpenses por grupo; úsalo para promedios y presupuestos.'),
      groupBy: z.enum(['category', 'account', 'month', 'day', 'none']).optional().describe('Agrupación de los resultados (por defecto none).'),
      type: z.enum(['expense', 'income', 'all']).optional().describe('Solo gastos, solo ingresos o ambos (por defecto all).'),
      accountId: z.string().optional().describe('Filtra por el ID de una cuenta (de listAccounts).'),
      categoryId: z.string().optional().describe('Filtra por el ID de una categoría (de listCategories).'),
      compareWithPrevious: z.boolean().optional().describe('Compara con el periodo anterior (mes/año/semana anterior o rango previo de igual duración).'),
      topN: z.number().int().min(0).max(20).optional().describe('Cantidad de gastos más grandes a devolver (por defecto 5, máximo 20).'),
    }),
    async (input) => {
      const now = clock();
      const period = resolvePeriod(input, now, timeZone);
      const start = input.compareWithPrevious ? previousPeriod(period, timeZone).startInstant : period.startInstant;
      const [rows, names, ws, cardBilling, budgetBreakdown] = await Promise.all([
        loadSummaryRows(start, period.endExclusive),
        loadNames(),
        loadWorkspace(),
        loadCardBilling(),
        // byBudget is workspace-wide, so it is skipped for account/category filters.
        input.accountId || input.categoryId ? undefined : loadBudgetBreakdown()
      ]);
      return summarize(rows, {
        ...input,
        period,
        now,
        timeZone,
        primaryCurrency,
        exchangeRates: ratesOf(ws),
        names,
        cardBilling,
        budgetBreakdown
      });
    }
  );

  define(
    'getWorkspaceSettings',
    'Configuración financiera del workspace: moneda principal, tasas de cambio, límite de gasto mensual, ingreso declarado y reparto 50/30/20, asignaciones a metas y presupuestos por categoría con el gasto real del mes en curso (gastado, restante y % usado). Úsalo para preguntas de presupuestos, límites, tasas o "¿cómo voy este mes?".',
    z.object({}),
    async () => {
      const now = clock();
      const period = resolvePeriod({ preset: 'this_month' }, now, timeZone);
      const [ws, goalsSnap, rows, names, cardBilling] = await Promise.all([
        loadWorkspace(),
        db.collection('goals').where('workspaceId', '==', workspaceId).get(),
        loadSummaryRows(period.startInstant, period.endExclusive),
        loadNames(),
        loadCardBilling()
      ]);
      const categoryBudgetCurrency = parseLegacyCategoryBudgetCurrency(ws);
      const rates = ratesOf(ws);
      const month = summarize(rows, {
        period, now, timeZone, primaryCurrency, exchangeRates: rates, names, cardBilling,
        groupBy: 'category', topN: 0
      });
      const defaultBudgetRows = rows.filter(row =>
        row.type !== 'expense' || !row.budgetId || row.budgetId === 'default-monthly'
      );
      const defaultBudgetMonth = summarize(defaultBudgetRows, {
        period, now, timeZone, primaryCurrency, exchangeRates: rates, names, cardBilling,
        groupBy: 'category', topN: 0
      });
      const budgets = buildBudgetStatus({
        categoryBudgets: (ws.categoryBudgets ?? {}) as Record<string, number>,
        expenseLimit: ws.expenseLimit,
        summary: defaultBudgetMonth,
        names
      });
      const budgetIncome = Number(ws.budgetIncome) || 0;
      // Defaults as in src/stores/goalsStore.ts loadBudgetSettings.
      const split = {
        needs: ws.budgetNeedsPercent !== undefined ? Number(ws.budgetNeedsPercent) : 50,
        wants: ws.budgetWantsPercent !== undefined ? Number(ws.budgetWantsPercent) : 30,
        savings: ws.budgetSavingsPercent !== undefined ? Number(ws.budgetSavingsPercent) : 20
      };
      const goalNames = new Map(goalsSnap.docs.map(docSnap => [docSnap.id, String(docSnap.data().name || 'Meta')]));
      return {
        currency: primaryCurrency,
        categoryBudgetCurrency,
        exchangeRates: rates,
        budgetIncome,
        budgetSplit: Object.fromEntries(Object.entries(split).map(([key, percent]) => [
          key, { percent, amount: Math.round(budgetIncome * percent) / 100 }
        ])),
        goalAllocations: Object.entries((ws.budgetAllocations ?? {}) as Record<string, number>).map(([goalId, amount]) => ({
          goalId, goalName: goalNames.get(goalId) ?? 'Meta desconocida', amount: Number(amount) || 0
        })),
        currentMonth: {
          period: month.period,
          totals: month.totals,
          expenseLimit: budgets.expenseLimit,
          categoryBudgets: budgets.categories,
          categoryBudgetTotals: budgets.totals
        },
        notes: month.notes
      };
    }
  );

  define(
    'saveCategoryBudgets',
    `Guarda únicamente los límites mensuales heredados por categoría del workspace. Si categoryBudgetCurrency está confirmada en el workspace, currency debe coincidir con ella. Sin confirmed: true solo valida y devuelve un resumen para pedir confirmación.`,
    z.object({
      currency: z.string().optional().describe('Código de moneda de los límites; cuando categoryBudgetCurrency está confirmada en el workspace, debe coincidir con ella.'),
      budgets: z.array(z.object({
        categoryId: z.string().min(1).describe('El ID de la categoría (obtenido de listCategories o getFinancialSummary con groupBy category)'),
        monthlyLimit: z.number().min(0).describe('Límite mensual de gasto para esta categoría (0 para eliminar el presupuesto)'),
      })).describe('Lista de presupuestos por categoría a guardar'),
      confirmed: confirmedParam,
    }),
    async ({ currency, budgets, confirmed }) => {
      const wsRef = db.collection('workspaces').doc(workspaceId);
      const ws = await loadWorkspace();
      const confirmedCurrency = parseLegacyCategoryBudgetCurrency(ws);
      if (confirmedCurrency !== null || currency !== undefined) {
        buildLegacyCategoryBudgetsPatch(
          (ws.categoryBudgets ?? {}) as Record<string, number>,
          budgets,
          confirmedCurrency,
          currency ?? confirmedCurrency ?? ''
        );
      }
      if (budgets.length === 0) return { success: true, savedBudgets: 0, message: "No había presupuestos para guardar." };

      // Every category must belong to the active workspace.
      const categoryIds = [...new Set(budgets.map(b => b.categoryId))];
      const categoryDocs = await db.getAll(...categoryIds.map(id => db.collection('categories').doc(id)));
      const unknown = categoryDocs
        .filter(docSnap => !docSnap.exists || docSnap.data()?.workspaceId !== workspaceId)
        .map(docSnap => docSnap.id);
      if (unknown.length > 0) {
        throw new AgentToolError(`Categorías no encontradas en el workspace activo: ${unknown.join(', ')}.`);
      }

      const effectiveCurrency = confirmedCurrency ?? primaryCurrency;
      // Last entry wins when the model repeats a category (duplicate field paths are rejected).
      const limits = new Map(budgets.map(b => [b.categoryId, Number(b.monthlyLimit)]));
      if (!isConfirmed(confirmed)) {
        const categoryNames = new Map(categoryDocs.map(docSnap => [docSnap.id, docSnap.data()?.name || 'Sin nombre']));
        return {
          needsConfirmation: true,
          summary: [...limits].map(([categoryId, monthlyLimit]) => ({
            categoryName: categoryNames.get(categoryId),
            monthlyLimit,
            currency: effectiveCurrency
          })),
          message: awaitingConfirmation(confirmed, "Muestra esta propuesta y pide confirmación explícita antes de guardar.")
        };
      }

      // Field-level writes leave other categories' budgets (edited concurrently from the app) untouched.
      const fieldUpdates: unknown[] = [];
      limits.forEach((limit, categoryId) => {
        fieldUpdates.push(
          new FieldPath('categoryBudgets', categoryId),
          Number.isFinite(limit) && limit > 0 ? limit : FieldValue.delete()
        );
      });
      const [firstField, firstValue, ...rest] = fieldUpdates;
      await wsRef.update(firstField as FieldPath, firstValue, ...rest);
      return { success: true, savedBudgets: limits.size, currency: effectiveCurrency, message: "Presupuestos guardados en el workspace activo." };
    }
  );

  return tools;
}
