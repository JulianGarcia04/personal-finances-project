// Must stay first: applies global function options before onCall below.
import './options'
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
  categoryId: z.string()
}).strict()

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
  transactions: Array<{ id: string; date: string; amount: number; type: 'income' | 'expense' }>
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
    request.rows.map(row => [row.date, row.description, row.amount, row.categoryId])
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

type PreparedRow = z.infer<typeof rowSchema> & { dateValue: Date }

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

function isRelated(data: admin.firestore.DocumentData): boolean {
  return typeof data.parentAccountId === 'string' ||
    (Array.isArray(data.childAccountIds) && data.childAccountIds.length > 0)
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

  const delta = roundMoney(parsed.rows.reduce((sum, row) => sum + row.amount, 0))
  if (!Number.isFinite(delta)) throw new ImportRejection('El total del extracto no es válido.')

  const { workspaceId, accountId, statementImportId } = parsed
  const requestHash = statementRequestHash(parsed)
  const markerRef = db.collection('statementImports').doc(statementImportMarkerId(workspaceId, statementImportId))
  const accountRef = db.collection('accounts').doc(accountId)
  const userRef = db.collection('users').doc(input.userId)
  const workspaceRef = db.collection('workspaces').doc(workspaceId)
  const transactionRefs = parsed.rows.map(() => db.collection('transactions').doc())
  const createdAt = Timestamp.now()

  return db.runTransaction(async transaction => {
    const [markerSnapshot, userSnapshot, workspaceSnapshot, accountSnapshot] = await Promise.all([
      transaction.get(markerRef),
      transaction.get(userRef),
      transaction.get(workspaceRef),
      transaction.get(accountRef)
    ])
    const workspace = workspaceSnapshot.data()
    if (!userSnapshot.exists || userSnapshot.data()?.activeWorkspaceId !== workspaceId ||
        !workspaceSnapshot.exists || !Array.isArray(workspace?.members) ||
        !workspace.members.includes(input.userId)) {
      throw new ImportRejection('El usuario no pertenece al workspace activo.')
    }
    // A retry of an already committed import replays its stored result without writing again.
    if (markerSnapshot.exists) {
      const marker = markerSnapshot.data()!
      if (marker.requestHash !== requestHash) {
        throw new ImportRejection('Este identificador de importación ya se usó con otro extracto.')
      }
      return marker.result as PocketStatementResult
    }
    const timeZone = timeZoneForCountry(userSnapshot.data()?.country)
    const rows: PreparedRow[] = parsed.rows.map(row => ({ ...row, dateValue: statementRowDate(row.date, timeZone) }))
    if (!accountSnapshot.exists) throw new ImportRejection('La cuenta seleccionada no existe.')

    const account = accountSnapshot.data()!
    const parentId = typeof account.parentAccountId === 'string' ? account.parentAccountId : null
    const parentRef = parentId ? db.collection('accounts').doc(parentId) : null
    const selectedChildrenQuery = db.collection('accounts').where('parentAccountId', '==', accountId)
    const [parentSnapshot, selectedChildren] = await Promise.all([
      parentRef ? transaction.get(parentRef) : Promise.resolve(null),
      transaction.get(selectedChildrenQuery)
    ])
    const parent = parentSnapshot?.data()
    let parentChildren: admin.firestore.QuerySnapshot | null = null
    if (parentId) {
      parentChildren = await transaction.get(
        db.collection('accounts').where('parentAccountId', '==', parentId)
      )
    }

    const categoryIds = [...new Set(rows.map(row => row.categoryId).filter(Boolean))]
    const categorySnapshots = await Promise.all(categoryIds.map(categoryId =>
      transaction.get(db.collection('categories').doc(categoryId))
    ))

    if (account.workspaceId !== workspaceId || !['checking', 'savings', 'cash'].includes(account.type) ||
        account.mirror != null || account.currency !== parsed.expectedCurrency) {
      throw new ImportRejection('La cuenta seleccionada no coincide con el workspace y la moneda esperados.')
    }
    if (!isRelated(account)) throw new ImportRejection('La importación autenticada solo admite cuentas con bolsillos.')

    if (parentId) {
      if (!parent || parent.workspaceId !== workspaceId || !['checking', 'savings'].includes(parent.type) ||
          parent.parentAccountId != null || parent.mirror != null || parent.currency !== account.currency ||
          account.type !== 'savings' || selectedChildren.size > 0 || !parentChildren) {
        throw new ImportRejection('La relación del bolsillo con su cuenta principal no es válida.')
      }
      const childIds = assertRegisteredChildren(parentId, parent, parentChildren, workspaceId)
      if (!childIds.includes(accountId)) throw new ImportRejection('El bolsillo no está registrado en su cuenta principal.')
    } else {
      if (!['checking', 'savings'].includes(account.type)) {
        throw new ImportRejection('La cuenta principal debe ser corriente o de ahorros.')
      }
      assertRegisteredChildren(accountId, account, selectedChildren, workspaceId)
    }

    const categories = new Map(categorySnapshots.map(snapshot => [snapshot.id, snapshot.data()]))
    for (const categoryId of categoryIds) {
      const category = categories.get(categoryId)
      if (!category || (category.workspaceId !== null && category.workspaceId !== workspaceId)) {
        throw new ImportRejection('Una categoría del extracto no pertenece al workspace activo.')
      }
    }

    const currentBalance = Number(account.balance)
    const nextBalance = roundMoney(currentBalance + delta)
    if (!Number.isFinite(currentBalance) || !Number.isFinite(nextBalance) || nextBalance < 0) {
      throw new ImportRejection('El saldo disponible no puede ser negativo.')
    }

    // Reads and validation are complete before any durable write begins.
    rows.forEach((row, index) => {
      transaction.create(transactionRefs[index], {
        workspaceId,
        userId: input.userId,
        accountId,
        amount: row.amount,
        description: row.description,
        categoryId: row.categoryId,
        date: Timestamp.fromDate(row.dateValue),
        type: row.amount > 0 ? 'income' : 'expense',
        toAccountId: null,
        currency: account.currency,
        statementImportId,
        createdAt
      })
    })
    transaction.update(accountRef, {
      balance: nextBalance,
      ...(parentId ? { pocketActivity: true } : {})
    })

    const result: PocketStatementResult = {
      accountId,
      balance: nextBalance,
      delta,
      createdAt: createdAt.toDate().toISOString(),
      transactions: rows.map((row, index) => ({
        id: transactionRefs[index].id,
        date: row.dateValue.toISOString(),
        amount: row.amount,
        type: row.amount > 0 ? 'income' as const : 'expense' as const
      }))
    }
    transaction.create(markerRef, {
      workspaceId,
      userId: input.userId,
      accountId,
      statementImportId,
      requestHash,
      result,
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
    }
    throw toImportHttpsError(error)
  }
})
