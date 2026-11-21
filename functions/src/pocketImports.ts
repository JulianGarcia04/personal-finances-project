// Must stay first: applies global function options before onCall below.
import './options'
import { reportError } from './errorReporting'
import { createHash } from 'node:crypto'
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { z } from 'zod'
import { AgentToolError, parseLocalDate } from './agentTools'
import { timeZoneForCountry } from './http'
import { roundMoney } from './money'

/** Maximum statement rows accepted per callable invocation. */
export const MAX_STATEMENT_ROWS = 1000
export const IMPORT_SERVER_ERROR = 'No se pudo importar el extracto. Intenta de nuevo más tarde.'

/** Client-generated idempotency key, reused by the client when retrying the same import. */
export const statementImportIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/)

/** Domain rejection whose Spanish message is safe to show to the client. */
export class ImportRejection extends Error {}

const rowSchema = z.object({
  date: z.string().min(1).refine(value => Number.isFinite(new Date(value).getTime())),
  description: z.string().min(1).refine(value => value.trim().length > 0),
  amount: z.number().finite().refine(value => value !== 0),
  categoryId: z.string(),
  type: z.enum(['income', 'expense', 'transfer']).optional(),
  counterpartyAccountId: z.string().optional()
}).strict().superRefine((row, context) => {
  if (row.type === 'transfer') {
    if (!row.counterpartyAccountId?.trim()) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['counterpartyAccountId'], message: 'La transferencia requiere una cuenta contraparte.' })
    }
    if (row.categoryId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['categoryId'], message: 'Las transferencias no admiten categoría.' })
    }
  } else if (row.counterpartyAccountId !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['counterpartyAccountId'], message: 'Solo las transferencias admiten una cuenta contraparte.' })
  }
})

export const pocketStatementRequestSchema = z.object({
  workspaceId: z.string().min(1),
  accountId: z.string().min(1),
  expectedCurrency: z.string().length(3),
  statementImportId: statementImportIdSchema,
  rows: z.array(rowSchema).min(1).max(MAX_STATEMENT_ROWS)
}).strict()

export type PocketStatementRequest = z.infer<typeof pocketStatementRequestSchema>

type PocketStatementResult = {
  accountId: string
  balance: number
  delta: number
  createdAt: string
  balances: Record<string, number>
  transactionIds: string[]
  replayed?: boolean
  transactions: Array<{
    id: string
    date: string
    amount: number
    type: 'income' | 'expense' | 'transfer'
    accountId: string
    toAccountId: string | null
    categoryId: string
    description: string
    currency: string
    createdAt: string
    userId?: string
    budgetId?: string
  }>
}

/** Durable receipt stored on the marker; live rows are re-read by id on replay. */
type StatementImportReceipt = Omit<PocketStatementResult, 'transactions' | 'replayed'>

/** Receipts written before row ids were stored may still carry the full row payloads. */
type StoredStatementImportReceipt = StatementImportReceipt & {
  transactions?: PocketStatementResult['transactions']
}

/**
 * Keeps only the ids and balances needed to replay an import, so a receipt stays far below
 * Firestore's 1 MiB document limit regardless of row count or description length.
 */
export function statementImportReceipt(result: PocketStatementResult): StatementImportReceipt {
  return {
    accountId: result.accountId,
    balance: result.balance,
    delta: result.delta,
    createdAt: result.createdAt,
    balances: result.balances,
    transactionIds: result.transactionIds
  }
}

/** Server-only marker document id; scoped by workspace so ids never collide across tenants. */
export function statementImportMarkerId(workspaceId: string, statementImportId: string): string {
  return `${workspaceId}_${statementImportId}`
}

/** Fingerprint of the import payload (excluding the key) to detect a key reused for another statement. */
export function statementRequestHash(request: PocketStatementRequest): string {
  const canonical = JSON.stringify([
    request.workspaceId,
    request.accountId,
    request.expectedCurrency,
    request.rows.map(row => [
      row.date,
      row.description,
      row.amount,
      row.categoryId,
      row.type ?? (row.amount > 0 ? 'income' : 'expense'),
      row.counterpartyAccountId ?? null
    ])
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

function legacyStatementRequestHash(request: PocketStatementRequest, timeZone: string): string {
  const canonical = JSON.stringify([
    request.workspaceId,
    request.accountId,
    request.expectedCurrency,
    request.rows.map(row => [
      statementRowDate(row.date, timeZone).toISOString(),
      row.description,
      row.amount,
      row.categoryId
    ])
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

const TRANSIENT_ABORTED = new Set<number | string>([10, 'aborted', 'ABORTED'])
const TRANSIENT_UNAVAILABLE = new Set<number | string>([
  4, 8, 14, 'deadline-exceeded', 'DEADLINE_EXCEEDED', 'resource-exhausted', 'RESOURCE_EXHAUSTED',
  'unavailable', 'UNAVAILABLE'
])
const FIRESTORE_INVALID_ARGUMENT = new Set<number | string>([3, 'invalid-argument', 'INVALID_ARGUMENT'])

/** Maps any failure from the import to a client-safe HttpsError. */
export function toImportHttpsError(error: unknown): HttpsError {
  if (error instanceof HttpsError) return error
  if (error instanceof ImportRejection) return new HttpsError('failed-precondition', error.message)
  if (error instanceof z.ZodError) return new HttpsError('invalid-argument', 'El extracto no tiene un formato válido.')
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'number' || typeof code === 'string') {
    if (TRANSIENT_ABORTED.has(code)) {
      return new HttpsError('aborted', 'La cuenta está recibiendo otros cambios. Intenta de nuevo.')
    }
    if (TRANSIENT_UNAVAILABLE.has(code)) {
      return new HttpsError('unavailable', 'El servicio no está disponible en este momento. Intenta de nuevo.')
    }
    if (FIRESTORE_INVALID_ARGUMENT.has(code)) {
      return new HttpsError('invalid-argument', 'El extracto excede el tamaño permitido o contiene datos inválidos.')
    }
  }
  return new HttpsError('internal', IMPORT_SERVER_ERROR)
}

type PreparedRow = z.infer<typeof rowSchema> & {
  effectiveType: 'income' | 'expense' | 'transfer'
  dateValue: Date
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Statement row date. The server clock runs in UTC, so a date-only value is that
 * calendar day at local noon in the user's time zone; timestamps keep the instant sent.
 */
export function statementRowDate(value: string, timeZone: string): Date {
  if (!DATE_ONLY.test(value)) return new Date(value)
  try {
    return parseLocalDate(value, timeZone)
  } catch (error) {
    if (error instanceof AgentToolError) throw new ImportRejection('Una fecha del extracto no es válida.')
    throw error
  }
}

function assertRegisteredChildren(
  parentId: string,
  parent: admin.firestore.DocumentData,
  children: admin.firestore.QuerySnapshot,
  workspaceId: string
): string[] {
  const registered: unknown = parent.childAccountIds === undefined ? [] : parent.childAccountIds
  const actual = children.docs.map(snapshot => snapshot.id).sort()
  if (!Array.isArray(registered) || registered.some(id => typeof id !== 'string') ||
      new Set(registered).size !== registered.length ||
      [...registered].sort().join('|') !== actual.join('|')) {
    throw new ImportRejection('El registro de bolsillos no coincide con las cuentas hijas existentes.')
  }
  for (const snapshot of children.docs) {
    const child = snapshot.data()
    if (child.parentAccountId !== parentId || child.workspaceId !== workspaceId ||
        child.currency !== parent.currency || child.type !== 'savings' ||
        (Array.isArray(child.childAccountIds) && child.childAccountIds.length > 0) ||
        typeof child.pocketActivity !== 'boolean') {
      throw new ImportRejection('El registro contiene un bolsillo inválido.')
    }
  }
  return actual
}

/** Imports a complete statement and the selected account balance atomically. */
export async function importWorkspacePocketStatement(
  db: admin.firestore.Firestore,
  input: PocketStatementRequest & { userId: string }
): Promise<PocketStatementResult> {
  const parsed = pocketStatementRequestSchema.parse({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    expectedCurrency: input.expectedCurrency,
    statementImportId: input.statementImportId,
    rows: input.rows
  })
  if (!input.userId) throw new ImportRejection('El usuario es obligatorio.')

  const { workspaceId, accountId, statementImportId } = parsed
  const requestHash = statementRequestHash(parsed)
  const markerRef = db.collection('statementImports').doc(statementImportMarkerId(workspaceId, statementImportId))
  const accountRef = db.collection('accounts').doc(accountId)
  const userRef = db.collection('users').doc(input.userId)
  const workspaceRef = db.collection('workspaces').doc(workspaceId)
  const transactionRefs = parsed.rows.map(() => db.collection('transactions').doc())
  const createdAt = Timestamp.now()

  return db.runTransaction(async transaction => {
    const [markerSnapshot, userSnapshot, workspaceSnapshot] = await Promise.all([
      transaction.get(markerRef),
      transaction.get(userRef),
      transaction.get(workspaceRef)
    ])
    const workspace = workspaceSnapshot.data()
    if (!userSnapshot.exists || userSnapshot.data()?.activeWorkspaceId !== workspaceId ||
        !workspaceSnapshot.exists || !Array.isArray(workspace?.members) ||
        !workspace.members.includes(input.userId)) {
      throw new ImportRejection('El usuario no pertenece al workspace activo.')
    }
    // The server-only receipt survives transaction deletion and account hierarchy changes.
    if (markerSnapshot.exists) {
      const marker = markerSnapshot.data()!
      const legacyCompatible = parsed.rows.every(row =>
        row.type === undefined ||
        (row.type === 'income' && row.amount > 0) ||
        (row.type === 'expense' && row.amount < 0)
      )
      const isLegacyPocketReceipt = legacyCompatible &&
        marker.requestHash === legacyStatementRequestHash(parsed, timeZoneForCountry(userSnapshot.data()?.country))
      if (marker.requestHash !== requestHash && !isLegacyPocketReceipt) {
        throw new ImportRejection('Este identificador de importación ya se usó con otro extracto.')
      }
      const { transactions: legacyTransactions, ...storedResult } = marker.result as StoredStatementImportReceipt
      const transactionIds = storedResult.transactionIds ?? (legacyTransactions ?? []).map(row => row.id)
      const accountIds = Object.keys(storedResult.balances ?? { [storedResult.accountId]: storedResult.balance })
      const [accountSnapshots, transactionSnapshots] = await Promise.all([
        Promise.all(accountIds.map(id => transaction.get(db.collection('accounts').doc(id)))),
        Promise.all(transactionIds.map(id => transaction.get(db.collection('transactions').doc(id))))
      ])
      const balances: Record<string, number> = {}
      accountSnapshots.forEach(snapshot => {
        const balance = Number(snapshot.data()?.balance)
        if (snapshot.exists && snapshot.data()?.workspaceId === workspaceId && Number.isFinite(balance)) {
          balances[snapshot.id] = balance
        }
      })
      const transactions = transactionSnapshots.flatMap(snapshot => {
        if (!snapshot.exists || snapshot.data()?.workspaceId !== workspaceId) return []
        const data = snapshot.data()!
        const asIso = (value: unknown, fallback: string) => {
          if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
            return (value as { toDate: () => Date }).toDate().toISOString()
          }
          const date = new Date(value as string | number | Date)
          return Number.isFinite(date.getTime()) ? date.toISOString() : fallback
        }
        return [{
          id: snapshot.id,
          date: asIso(data.date, storedResult.createdAt),
          amount: Number(data.amount),
          type: data.type,
          accountId: data.accountId,
          toAccountId: data.toAccountId ?? null,
          categoryId: data.categoryId ?? '',
          description: data.description ?? '',
          currency: data.currency ?? parsed.expectedCurrency,
          createdAt: asIso(data.createdAt, storedResult.createdAt),
          ...(typeof data.userId === 'string' ? { userId: data.userId } : {}),
          ...(typeof data.budgetId === 'string' ? { budgetId: data.budgetId } : {})
        }]
      })
      return {
        ...storedResult,
        balance: balances[storedResult.accountId] ?? storedResult.balance,
        balances,
        transactionIds,
        transactions,
        replayed: true
      }
    }
    const accountSnapshot = await transaction.get(accountRef)
    const timeZone = timeZoneForCountry(userSnapshot.data()?.country)
    const rows: PreparedRow[] = parsed.rows.map(row => ({
      ...row,
      effectiveType: row.type ?? (row.amount > 0 ? 'income' : 'expense'),
      dateValue: statementRowDate(row.date, timeZone)
    }))
    if (!accountSnapshot.exists) throw new ImportRejection('La cuenta seleccionada no existe.')

    const account = accountSnapshot.data()!
    const parentId = typeof account.parentAccountId === 'string' ? account.parentAccountId : null
    if (account.parentAccountId != null && !parentId) {
      throw new ImportRejection('La relación del bolsillo con su cuenta principal no es válida.')
    }
    const parentRef = parentId ? db.collection('accounts').doc(parentId) : null
    const selectedChildrenQuery = db.collection('accounts').where('parentAccountId', '==', accountId)
    const [parentSnapshot, selectedChildren] = await Promise.all([
      parentRef ? transaction.get(parentRef) : Promise.resolve(null),
      transaction.get(selectedChildrenQuery)
    ])
    const parent = parentSnapshot?.data()
    let parentChildren: admin.firestore.QuerySnapshot | null = null
    let parentChildIds: string[] = []
    if (parentId) {
      parentChildren = await transaction.get(
        db.collection('accounts').where('parentAccountId', '==', parentId)
      )
    }

    const selectedChildIds = assertRegisteredChildren(accountId, account, selectedChildren, workspaceId)
    if (parentId) {
      if (!parent || parent.workspaceId !== workspaceId || !['checking', 'savings'].includes(parent.type) ||
          parent.parentAccountId != null || parent.mirror != null || parent.currency !== account.currency ||
          account.type !== 'savings' || selectedChildren.size > 0 || !parentChildren) {
        throw new ImportRejection('La relación del bolsillo con su cuenta principal no es válida.')
      }
      parentChildIds = assertRegisteredChildren(parentId, parent, parentChildren, workspaceId)
      if (!parentChildIds.includes(accountId)) throw new ImportRejection('El bolsillo no está registrado en su cuenta principal.')
    }

    const pocketRelated = Boolean(parentId || selectedChildIds.length > 0)
    if (account.workspaceId !== workspaceId || account.mirror != null || account.currency !== parsed.expectedCurrency ||
        (pocketRelated
          ? !['checking', 'savings', 'cash'].includes(account.type)
          : !['checking', 'savings', 'cash', 'credit'].includes(account.type))) {
      throw new ImportRejection('La cuenta seleccionada no coincide con el workspace y la moneda esperados.')
    }
    if (pocketRelated && !parentId && !['checking', 'savings'].includes(account.type)) {
      throw new ImportRejection('La cuenta principal debe ser corriente o de ahorros.')
    }

    if (pocketRelated && rows.some(row => row.effectiveType === 'transfer')) {
      throw new ImportRejection('Las transferencias de cuentas con bolsillos deben registrarse desde el flujo de transferencias.')
    }

    const counterpartyIds = [...new Set(rows
      .filter(row => row.effectiveType === 'transfer')
      .map(row => row.counterpartyAccountId!.trim()))]
    const counterpartyRefs = counterpartyIds.map(id => db.collection('accounts').doc(id))
    const counterpartySnapshots = await Promise.all(counterpartyRefs.map(ref => transaction.get(ref)))
    const counterpartyMap = new Map<string, admin.firestore.DocumentData>()
    for (const [index, snapshot] of counterpartySnapshots.entries()) {
      if (!snapshot.exists) throw new ImportRejection('Una cuenta contraparte de transferencia ya no existe.')
      const counterparty = snapshot.data()!
      const counterpartyId = counterpartyIds[index]
      if (counterparty.workspaceId !== workspaceId || counterparty.currency !== account.currency ||
          counterparty.mirror != null || typeof counterparty.parentAccountId === 'string' ||
          (Array.isArray(counterparty.childAccountIds) && counterparty.childAccountIds.length > 0) ||
          counterpartyId === accountId ||
          !['checking', 'savings', 'cash', 'credit'].includes(counterparty.type)) {
        throw new ImportRejection('Las transferencias requieren una cuenta contraparte válida en la misma moneda y workspace.')
      }
      const children = await transaction.get(
        db.collection('accounts').where('parentAccountId', '==', counterpartyId)
      )
      if (assertRegisteredChildren(counterpartyId, counterparty, children, workspaceId).length > 0) {
        throw new ImportRejection('Las transferencias importadas no admiten cuentas contraparte con bolsillos.')
      }
      counterpartyMap.set(counterpartyId, counterparty)
    }

    const categoryIds = [...new Set(rows.map(row => row.categoryId).filter(Boolean))]
    const categorySnapshots = await Promise.all(categoryIds.map(categoryId =>
      transaction.get(db.collection('categories').doc(categoryId))
    ))

    const categories = new Map(categorySnapshots.map(snapshot => [snapshot.id, snapshot.data()]))
    for (const categoryId of categoryIds) {
      const category = categories.get(categoryId)
      if (!category || (category.workspaceId !== null && category.workspaceId !== workspaceId)) {
        throw new ImportRejection('Una categoría del extracto no pertenece al workspace activo.')
      }
    }

    const accountDeltas = new Map<string, number>([[accountId, 0]])
    for (const counterpartyId of counterpartyIds) accountDeltas.set(counterpartyId, 0)
    const transactionPayloads = rows.map((row, index) => {
      const id = transactionRefs[index].id
      if (row.effectiveType === 'transfer') {
        const counterpartyId = row.counterpartyAccountId!.trim()
        const amount = Math.abs(row.amount)
        const targetDelta = row.amount > 0 ? amount : -amount
        const sourceAccountId = row.amount > 0 ? counterpartyId : accountId
        const destinationAccountId = row.amount > 0 ? accountId : counterpartyId
        accountDeltas.set(accountId, (accountDeltas.get(accountId) ?? 0) + targetDelta)
        accountDeltas.set(counterpartyId, (accountDeltas.get(counterpartyId) ?? 0) - targetDelta)
        return {
          id,
          payload: {
            workspaceId,
            userId: input.userId,
            accountId: sourceAccountId,
            amount,
            description: row.description,
            categoryId: '',
            date: Timestamp.fromDate(row.dateValue),
            type: 'transfer' as const,
            toAccountId: destinationAccountId,
            currency: account.currency,
            statementImportId,
            createdAt
          },
          local: {
            id,
            date: row.dateValue.toISOString(),
            amount,
            type: 'transfer' as const,
            accountId: sourceAccountId,
            toAccountId: destinationAccountId,
            categoryId: ''
          }
        }
      }

      const signedAmount = row.effectiveType === 'expense' ? -Math.abs(row.amount) : Math.abs(row.amount)
      accountDeltas.set(accountId, (accountDeltas.get(accountId) ?? 0) + signedAmount)
      return {
        id,
        payload: {
          workspaceId,
          userId: input.userId,
          accountId,
          amount: signedAmount,
          description: row.description,
          categoryId: row.categoryId,
          date: Timestamp.fromDate(row.dateValue),
          type: row.effectiveType,
          toAccountId: null,
          currency: account.currency,
          statementImportId,
          createdAt
        },
        local: {
          id,
          date: row.dateValue.toISOString(),
          amount: signedAmount,
          type: row.effectiveType,
          accountId,
          toAccountId: null,
          categoryId: row.categoryId
        }
      }
    })

    const balances: Record<string, number> = {}
    const delta = roundMoney(accountDeltas.get(accountId) ?? 0)
    for (const [changedAccountId, accountDelta] of accountDeltas.entries()) {
      const source = changedAccountId === accountId ? account : counterpartyMap.get(changedAccountId)!
      const balance = Number(source.balance)
      const nextBalance = roundMoney(balance + accountDelta)
      if (!Number.isFinite(balance) || !Number.isFinite(nextBalance) || (pocketRelated && nextBalance < 0)) {
        throw new ImportRejection('El saldo disponible no puede ser negativo.')
      }
      balances[changedAccountId] = nextBalance
    }

    let linkedBudgetId: string | null = null
    if (!pocketRelated && typeof account.linkedBudgetId === 'string' && account.linkedBudgetId) {
      const budgetSnapshot = await transaction.get(db.collection('budgets').doc(account.linkedBudgetId))
      const budget = budgetSnapshot.exists ? budgetSnapshot.data() : null
      if (budget && budget.workspaceId === workspaceId && budget.archived === false) {
        linkedBudgetId = budgetSnapshot.id
      }
    }

    // Reads and validation are complete before any durable write begins.
    transactionPayloads.forEach(({ payload }, index) => {
      transaction.create(transactionRefs[index], {
        ...payload,
        ...(payload.type === 'transfer' || !linkedBudgetId ? {} : { budgetId: linkedBudgetId })
      })
    })
    for (const [changedAccountId, balance] of Object.entries(balances)) {
      transaction.update(db.collection('accounts').doc(changedAccountId), {
        balance,
        ...(parentId && changedAccountId === accountId ? { pocketActivity: true } : {})
      })
    }

    const result: PocketStatementResult = {
      accountId,
      balance: balances[accountId],
      delta,
      createdAt: createdAt.toDate().toISOString(),
      balances,
      transactionIds: transactionPayloads.map(({ id }) => id),
      transactions: transactionPayloads.map(({ local, payload }) => ({
        ...local,
        description: payload.description,
        currency: payload.currency,
        createdAt: createdAt.toDate().toISOString(),
        userId: payload.userId,
        ...(payload.type !== 'transfer' && linkedBudgetId ? { budgetId: linkedBudgetId } : {})
      }))
    }
    transaction.create(markerRef, {
      workspaceId,
      userId: input.userId,
      accountId,
      statementImportId,
      requestHash,
      result: statementImportReceipt(result),
      createdAt
    })
    return result
  })
}

export const importPocketStatement = onCall(async request => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'La autenticación es obligatoria.')
  const rows = (request.data as { rows?: unknown } | null)?.rows
  if (Array.isArray(rows) && rows.length > MAX_STATEMENT_ROWS) {
    throw new HttpsError('invalid-argument', `El extracto supera el máximo de ${MAX_STATEMENT_ROWS} movimientos por importación.`)
  }
  const parsed = pocketStatementRequestSchema.safeParse(request.data)
  if (!parsed.success) throw new HttpsError('invalid-argument', 'El extracto no tiene un formato válido.')
  try {
    return await importWorkspacePocketStatement(admin.firestore(), {
      ...parsed.data,
      userId: request.auth.uid
    })
  } catch (error) {
    if (!(error instanceof HttpsError) && !(error instanceof ImportRejection)) {
      logger.error('importPocketStatement failed', error)
      await reportError(error, { source: 'importPocketStatement', uid: request.auth.uid })
    }
    throw toImportHttpsError(error)
  }
})
