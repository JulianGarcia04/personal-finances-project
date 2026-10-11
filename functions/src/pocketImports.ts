import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { z } from 'zod'

const rowSchema = z.object({
  date: z.string().min(1).refine(value => Number.isFinite(new Date(value).getTime())),
  description: z.string().min(1).refine(value => value.trim().length > 0),
  amount: z.number().finite().refine(value => value !== 0),
  categoryId: z.string()
}).strict()

const requestSchema = z.object({
  workspaceId: z.string().min(1),
  accountId: z.string().min(1),
  expectedCurrency: z.string().length(3),
  rows: z.array(rowSchema).min(1)
}).strict()

export type PocketStatementRequest = z.infer<typeof requestSchema>

type PreparedRow = z.infer<typeof rowSchema> & { dateValue: Date }

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
    throw new Error('El registro de bolsillos no coincide con las cuentas hijas existentes.')
  }
  for (const snapshot of children.docs) {
    const child = snapshot.data()
    if (child.parentAccountId !== parentId || child.workspaceId !== workspaceId ||
        child.currency !== parent.currency || child.type !== 'savings' ||
        (Array.isArray(child.childAccountIds) && child.childAccountIds.length > 0) ||
        typeof child.pocketActivity !== 'boolean') {
      throw new Error('El registro contiene un bolsillo inválido.')
    }
  }
  return actual
}

/** Imports a complete statement and the selected account balance atomically. */
export async function importWorkspacePocketStatement(
  db: admin.firestore.Firestore,
  input: PocketStatementRequest & { userId: string }
): Promise<{
  accountId: string
  balance: number
  delta: number
  createdAt: string
  transactions: Array<{ id: string; date: string; amount: number; type: 'income' | 'expense' }>
}> {
  const parsed = requestSchema.parse({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    expectedCurrency: input.expectedCurrency,
    rows: input.rows
  })
  if (!input.userId) throw new Error('El usuario es obligatorio.')

  const rows: PreparedRow[] = parsed.rows.map(row => ({ ...row, dateValue: new Date(row.date) }))
  const delta = rows.reduce((sum, row) => sum + row.amount, 0)
  if (!Number.isFinite(delta)) throw new Error('El total del extracto no es válido.')

  const { workspaceId, accountId } = parsed
  const accountRef = db.collection('accounts').doc(accountId)
  const userRef = db.collection('users').doc(input.userId)
  const workspaceRef = db.collection('workspaces').doc(workspaceId)
  const transactionRefs = rows.map(() => db.collection('transactions').doc())
  const createdAt = Timestamp.now()

  return db.runTransaction(async transaction => {
    const [userSnapshot, workspaceSnapshot, accountSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(workspaceRef),
      transaction.get(accountRef)
    ])
    const workspace = workspaceSnapshot.data()
    if (!userSnapshot.exists || userSnapshot.data()?.activeWorkspaceId !== workspaceId ||
        !workspaceSnapshot.exists || !Array.isArray(workspace?.members) ||
        !workspace.members.includes(input.userId)) {
      throw new Error('El usuario no pertenece al workspace activo.')
    }
    if (!accountSnapshot.exists) throw new Error('La cuenta seleccionada no existe.')

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
      throw new Error('La cuenta seleccionada no coincide con el workspace y la moneda esperados.')
    }
    if (!isRelated(account)) throw new Error('La importación autenticada solo admite cuentas con bolsillos.')

    if (parentId) {
      if (!parent || parent.workspaceId !== workspaceId || !['checking', 'savings'].includes(parent.type) ||
          parent.parentAccountId != null || parent.mirror != null || parent.currency !== account.currency ||
          account.type !== 'savings' || selectedChildren.size > 0 || !parentChildren) {
        throw new Error('La relación del bolsillo con su cuenta principal no es válida.')
      }
      const childIds = assertRegisteredChildren(parentId, parent, parentChildren, workspaceId)
      if (!childIds.includes(accountId)) throw new Error('El bolsillo no está registrado en su cuenta principal.')
    } else {
      if (!['checking', 'savings'].includes(account.type)) {
        throw new Error('La cuenta principal debe ser corriente o de ahorros.')
      }
      assertRegisteredChildren(accountId, account, selectedChildren, workspaceId)
    }

    const categories = new Map(categorySnapshots.map(snapshot => [snapshot.id, snapshot.data()]))
    for (const categoryId of categoryIds) {
      const category = categories.get(categoryId)
      if (!category || (category.workspaceId !== null && category.workspaceId !== workspaceId)) {
        throw new Error('Una categoría del extracto no pertenece al workspace activo.')
      }
    }

    const currentBalance = Number(account.balance)
    const nextBalance = currentBalance + delta
    if (!Number.isFinite(currentBalance) || !Number.isFinite(nextBalance) || nextBalance < 0) {
      throw new Error('El saldo disponible no puede ser negativo.')
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
        createdAt
      })
    })
    transaction.update(accountRef, {
      balance: nextBalance,
      ...(parentId ? { pocketActivity: true } : {})
    })

    return {
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
  })
}

export const importPocketStatement = onCall(async request => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'La autenticación es obligatoria.')
  const parsed = requestSchema.safeParse(request.data)
  if (!parsed.success) throw new HttpsError('invalid-argument', 'El extracto no tiene un formato válido.')
  try {
    return await importWorkspacePocketStatement(admin.firestore(), {
      ...parsed.data,
      userId: request.auth.uid
    })
  } catch (error) {
    if (error instanceof HttpsError) throw error
    throw new HttpsError('failed-precondition', error instanceof Error ? error.message : 'No se pudo importar el extracto.')
  }
})
