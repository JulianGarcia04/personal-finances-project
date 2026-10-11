import * as admin from 'firebase-admin'
import { roundMoney } from './money'

export type WorkspaceAccountInput = {
  userId: string
  workspaceId: string
  name: string
  type: 'checking' | 'savings' | 'credit' | 'cash'
  balance: number
  currency: string
  limit?: number
  statementClosingDay?: number | null
  paymentDueDay?: number | null
  parentAccountId?: string
}

export async function assertLegacyTransactionAccountsAreUnpocketed(
  db: admin.firestore.Firestore,
  transaction: admin.firestore.Transaction,
  accounts: Array<{ id: string; data: admin.firestore.DocumentData }>
): Promise<void> {
  const uniqueAccounts = [...new Map(accounts.map(account => [account.id, account])).values()]
  for (const account of uniqueAccounts) {
    const registeredChildren = account.data.childAccountIds
    if (account.data.parentAccountId != null ||
        (registeredChildren != null && (!Array.isArray(registeredChildren) || registeredChildren.length > 0))) {
      throw new Error('Las transacciones de bolsillos no están disponibles todavía.')
    }
    const children = await transaction.get(
      db.collection('accounts').where('parentAccountId', '==', account.id)
    )
    if (!children.empty) {
      throw new Error('Las transacciones de cuentas con bolsillos no están disponibles todavía.')
    }
  }
}

export async function createWorkspaceAccount(
  db: admin.firestore.Firestore,
  input: WorkspaceAccountInput
): Promise<Record<string, unknown>> {
  const { userId, workspaceId, parentAccountId } = input
  if (!userId || !workspaceId) throw new Error('El usuario y el workspace son obligatorios.')

  const userRef = db.collection('users').doc(userId)
  const workspaceRef = db.collection('workspaces').doc(workspaceId)
  const accountRef = db.collection('accounts').doc()
  const createdAt = admin.firestore.Timestamp.now()
  const parentRef = parentAccountId ? db.collection('accounts').doc(parentAccountId) : null
  const openingRef = parentAccountId && input.balance > 0
    ? db.collection('transactions').doc()
    : null

  return db.runTransaction(async transaction => {
    const [userSnap, workspaceSnap, parentSnap, childrenSnap] = await Promise.all([
      transaction.get(userRef),
      transaction.get(workspaceRef),
      parentRef ? transaction.get(parentRef) : Promise.resolve(null),
      parentAccountId
        ? transaction.get(db.collection('accounts')
            .where('parentAccountId', '==', parentAccountId))
        : Promise.resolve(null)
    ])

    if (!userSnap.exists || userSnap.data()?.activeWorkspaceId !== workspaceId ||
        !workspaceSnap.exists || !Array.isArray(workspaceSnap.data()?.members) ||
        !workspaceSnap.data()!.members.includes(userId)) {
      throw new Error('El usuario no pertenece al workspace activo.')
    }

    if (!parentAccountId) {
      const rootAccount = {
        workspaceId,
        userId,
        name: input.name,
        type: input.type,
        balance: Number(input.balance),
        limit: input.type === 'credit' ? Number(input.limit || 0) : 0,
        currency: input.currency.toUpperCase(),
        statementClosingDay: input.type === 'credit' ? input.statementClosingDay ?? null : null,
        paymentDueDay: input.type === 'credit' ? input.paymentDueDay ?? null : null,
        createdAt
      }
      transaction.create(accountRef, rootAccount)
      return { id: accountRef.id, ...rootAccount }
    }

    if (!parentRef || !parentSnap?.exists || !childrenSnap || !('docs' in childrenSnap)) {
      throw new Error('La cuenta principal no existe.')
    }
    if (input.type !== 'savings' || !Number.isFinite(input.balance) || input.balance < 0 ||
        (input.limit != null && Number(input.limit) !== 0) ||
        input.statementClosingDay != null || input.paymentDueDay != null ||
        !input.name.trim() || input.name.length > 50 || !input.currency) {
      throw new Error('Un bolsillo requiere un saldo inicial finito y no negativo.')
    }

    const parent = parentSnap.data()
    const registeredIds: unknown = parent?.childAccountIds === undefined ? [] : parent.childAccountIds
    if (!Array.isArray(registeredIds) || registeredIds.some(id => typeof id !== 'string') ||
        new Set(registeredIds).size !== registeredIds.length) {
      throw new Error('El registro de bolsillos de la cuenta principal no es válido.')
    }
    const actualIds = childrenSnap.docs.map(snapshot => snapshot.id).sort()
    if ([...registeredIds].sort().join('|') !== actualIds.join('|')) {
      throw new Error('El registro de bolsillos no coincide con las cuentas hijas existentes.')
    }
    for (const snapshot of childrenSnap.docs) {
      const child = snapshot.data()
      if (child.parentAccountId !== parentAccountId || child.workspaceId !== workspaceId ||
          child.currency !== parent?.currency || child.type !== 'savings' ||
          child.pocketActivity !== true && child.pocketActivity !== false) {
        throw new Error('El registro contiene un bolsillo inválido.')
      }
    }

    const availableBalance = Number(parent?.balance)
    const currency = String(parent?.currency || '')
    if (!['checking', 'savings'].includes(String(parent?.type)) ||
        parent?.parentAccountId != null || parent?.mirror != null ||
        parent?.workspaceId !== workspaceId || !Number.isFinite(availableBalance) ||
        !currency || (input.currency && input.currency.toUpperCase() !== currency)) {
      throw new Error('La cuenta principal no puede contener este bolsillo.')
    }
    if (input.balance > availableBalance) throw new Error('El saldo disponible es insuficiente para abrir el bolsillo.')

    const parentBalanceAfter = roundMoney(availableBalance - input.balance)
    const childIds = [...registeredIds, accountRef.id]
    const pocket = {
      workspaceId,
      userId,
      name: input.name,
      type: 'savings',
      balance: input.balance,
      limit: 0,
      currency,
      statementClosingDay: null,
      paymentDueDay: null,
      parentAccountId,
      childAccountIds: [],
      pocketActivity: input.balance > 0,
      openingAllocationId: openingRef?.id ?? null,
      createdAt
    }

    transaction.update(parentRef, {
      balance: parentBalanceAfter,
      childAccountIds: childIds,
      lastPocketChildId: accountRef.id,
      lastPocketChange: 'created'
    })
    transaction.create(accountRef, pocket)
    if (openingRef) {
      transaction.create(openingRef, {
        workspaceId,
        userId,
        accountId: parentAccountId,
        amount: input.balance,
        description: `Asignación inicial a bolsillo: ${input.name}`,
        categoryId: '',
        date: createdAt,
        type: 'transfer',
        toAccountId: accountRef.id,
        receiptUrl: null,
        notes: null,
        installments: 1,
        currency,
        pocketAllocation: true,
        createdAt
      })
    }
    return { id: accountRef.id, ...pocket }
  })
}

export type WorkspaceTransactionMovement = {
  accountId: string
  amount: number
  description: string
  categoryId?: string
  date?: Date
  type: 'income' | 'expense' | 'transfer' | 'loan' | 'loan_payment'
  toAccountId?: string | null
  receiptUrl?: string | null
  notes?: string | null
  installments?: number | null
  userId?: string
}

export type WorkspaceTransactionMutation = {
  kind: 'created' | 'updated' | 'deleted'
  userId: string
  workspaceId: string
  transactionId?: string
  movement?: WorkspaceTransactionMovement
}

function isPocketRelated(data: admin.firestore.DocumentData): boolean {
  return typeof data.parentAccountId === 'string' ||
    (Array.isArray(data.childAccountIds) && data.childAccountIds.length > 0)
}

/** Balance deltas of one movement; accumulates so a same-account transfer nets to zero. */
export function legacyDeltas(movement: WorkspaceTransactionMovement | admin.firestore.DocumentData, direction: 1 | -1) {
  const deltas: Record<string, number> = {}
  const amount = Number(movement.amount)
  const add = (accountId: string, value: number) => { deltas[accountId] = (deltas[accountId] ?? 0) + value }
  if (movement.type === 'transfer' && movement.toAccountId) {
    add(movement.accountId, -amount * direction)
    add(movement.toAccountId, amount * direction)
  } else {
    add(movement.accountId, amount * direction)
  }
  return deltas
}

const POSITIVE_TYPES = new Set(['income', 'loan_payment'])
const NEGATIVE_TYPES = new Set(['expense', 'loan'])

/**
 * Validates a new movement on unpocketed accounts with the app's signed-amount
 * convention: income/loan_payment > 0, expense/loan < 0, transfer > 0 between
 * two distinct accounts of the same currency.
 */
export function assertLegacyMovement(
  movement: Pick<WorkspaceTransactionMovement, 'accountId' | 'amount'> & { type: string; toAccountId?: string | null },
  source: admin.firestore.DocumentData,
  destination?: admin.firestore.DocumentData
): void {
  const amount = Number(movement.amount)
  if (!Number.isFinite(amount) || amount === 0) throw new Error('El monto del movimiento no es válido.')
  if (movement.type === 'transfer') {
    if (!movement.toAccountId || !destination) throw new Error('La transferencia requiere una cuenta destino.')
    if (movement.toAccountId === movement.accountId) {
      throw new Error('La transferencia requiere cuentas de origen y destino distintas.')
    }
    if (!source.currency || source.currency !== destination.currency) {
      throw new Error('La transferencia requiere cuentas de la misma moneda.')
    }
    if (amount < 0) throw new Error('El monto de la transferencia debe ser positivo.')
  } else if (POSITIVE_TYPES.has(movement.type)) {
    if (amount < 0) throw new Error('El monto debe ser positivo para ingresos y pagos de préstamo recibidos.')
  } else if (NEGATIVE_TYPES.has(movement.type)) {
    if (amount > 0) throw new Error('El monto debe ser negativo para gastos y préstamos dados.')
  } else {
    throw new Error('El tipo de movimiento no es válido.')
  }
}

function addDeltas(target: Record<string, number>, source: Record<string, number>): void {
  for (const [accountId, amount] of Object.entries(source)) {
    target[accountId] = (target[accountId] ?? 0) + amount
  }
}

function movementData(data: WorkspaceTransactionMovement | admin.firestore.DocumentData) {
  return {
    accountId: data.accountId,
    toAccountId: data.toAccountId ?? null,
    amount: Number(data.amount),
    type: data.type
  }
}

function assertSupportedPocketMovement(
  movement: WorkspaceTransactionMovement | admin.firestore.DocumentData,
  source: admin.firestore.DocumentData,
  destination?: admin.firestore.DocumentData
): void {
  const data = movement as admin.firestore.DocumentData
  const amount = Number(movement.amount)
  if (!Number.isFinite(amount) || !source.currency || data.currency && data.currency !== source.currency) {
    throw new Error('El monto y la moneda del movimiento no son válidos.')
  }
  if (data.mirrorOf) throw new Error('Los movimientos espejo no se pueden combinar con bolsillos.')
  if (movement.type === 'transfer') {
    if (!destination || movement.accountId === movement.toAccountId || amount <= 0 ||
        source.currency !== destination.currency) {
      throw new Error('La transferencia requiere cuentas distintas de la misma moneda.')
    }
  } else if ((movement.type !== 'income' && movement.type !== 'expense') ||
             (movement.type === 'income' && amount <= 0) ||
             (movement.type === 'expense' && amount >= 0) || movement.toAccountId) {
    throw new Error('Los bolsillos solo admiten ingresos, gastos y transferencias válidas.')
  }
}

function assertMovementAccount(
  accountId: string,
  data: admin.firestore.DocumentData,
  workspaceId: string,
  parents: Map<string, admin.firestore.DocumentData>,
  childrenByParent: Map<string, string[]>
): void {
  if (data.workspaceId !== workspaceId || !['checking', 'savings', 'cash'].includes(data.type) || data.mirror != null) {
    throw new Error('Las cuentas del movimiento deben ser cuentas ordinarias del mismo workspace.')
  }
  if (data.parentAccountId != null) {
    const parent = parents.get(String(data.parentAccountId))
    const registered = parent?.childAccountIds
    const actual = childrenByParent.get(String(data.parentAccountId)) ?? []
    if (data.type !== 'savings' || !parent || parent.workspaceId !== workspaceId ||
        !['checking', 'savings'].includes(parent.type) || parent.parentAccountId != null || parent.mirror != null ||
        parent.currency !== data.currency || !Array.isArray(registered) || !registered.includes(accountId) ||
        data.childAccountIds?.length || [...registered].sort().join('|') !== [...actual].sort().join('|')) {
      throw new Error('La relación del bolsillo con su cuenta principal no es válida.')
    }
  } else {
    const registered = data.childAccountIds === undefined ? [] : data.childAccountIds
    const actual = childrenByParent.get(accountId) ?? []
    if (!Array.isArray(registered) || registered.some((id: unknown) => typeof id !== 'string') ||
        new Set(registered).size !== registered.length ||
        [...registered].sort().join('|') !== [...actual].sort().join('|')) {
      throw new Error('El registro de bolsillos de la cuenta no coincide con las cuentas hijas.')
    }
  }
}

/** Atomically creates, edits, or reverses a workspace transaction and its account balances. */
export async function mutateWorkspaceTransaction(
  db: admin.firestore.Firestore,
  input: WorkspaceTransactionMutation
): Promise<{ id: string; transactionData: admin.firestore.DocumentData }> {
  if (!input.userId || !input.workspaceId) throw new Error('El usuario y el workspace son obligatorios.')
  if (input.kind !== 'created' && !input.transactionId) throw new Error('La transacción es obligatoria.')
  if (input.kind !== 'deleted' && !input.movement) throw new Error('Faltan los datos del movimiento.')

  const transactionRef = input.transactionId
    ? db.collection('transactions').doc(input.transactionId)
    : db.collection('transactions').doc()
  const transactionId = transactionRef.id
  const userRef = db.collection('users').doc(input.userId)
  const workspaceRef = db.collection('workspaces').doc(input.workspaceId)

  return db.runTransaction(async transaction => {
    const [userSnap, workspaceSnap, beforeSnap] = await Promise.all([
      transaction.get(userRef),
      transaction.get(workspaceRef),
      input.kind === 'created' ? Promise.resolve(null) : transaction.get(transactionRef)
    ])
    if (!userSnap.exists || userSnap.data()?.activeWorkspaceId !== input.workspaceId ||
        !workspaceSnap.exists || !Array.isArray(workspaceSnap.data()?.members) ||
        !workspaceSnap.data()!.members.includes(input.userId)) {
      throw new Error('El usuario no pertenece al workspace activo.')
    }
    if (beforeSnap && !beforeSnap.exists) throw new Error('La transacción no existe.')
    const before = beforeSnap?.data() ?? null
    if (before && before.workspaceId !== input.workspaceId) throw new Error('La transacción pertenece a otro workspace.')
    if (before) {
      // Mirror pairs (shared expenses, settlements) span two workspaces and must be
      // reversed together; only the app's pair flow does that, so refuse half-edits here.
      const referrers = await transaction.get(
        db.collection('transactions').where('mirrorOf', '==', transactionId).limit(1)
      )
      if (before.mirrorOf || before.settlementType || !referrers.empty) {
        throw new Error('Este movimiento está vinculado a otro workspace (gasto compartido o liquidación); modifícalo o elimínalo desde la app para revertir ambas partes juntas.')
      }
    }
    if (before?.pocketAllocation && input.kind === 'updated' &&
        (input.movement?.type !== 'transfer' || input.movement.accountId !== before.accountId ||
         input.movement.toAccountId !== before.toAccountId)) {
      throw new Error('La asignación inicial debe conservar sus cuentas y el tipo de transferencia.')
    }
    if (input.movement?.type && input.movement.type !== 'transfer' && input.movement.toAccountId) {
      throw new Error('La transacción contiene relaciones no compatibles.')
    }

    const ids = new Set<string>()
    for (const movement of [before && movementData(before), input.movement && movementData(input.movement)]) {
      if (!movement) continue
      ids.add(movement.accountId)
      if (movement.toAccountId) ids.add(movement.toAccountId)
    }
    const accountRefs = new Map([...ids].map(id => [id, db.collection('accounts').doc(id)]))
    const accountSnaps = await Promise.all([...accountRefs.values()].map(ref => transaction.get(ref)))
    const accountData = new Map<string, admin.firestore.DocumentData>()
    for (const snapshot of accountSnaps) {
      if (snapshot.exists) accountData.set(snapshot.id, snapshot.data()!)
    }
    if ([...accountData.values()].some(data => data.workspaceId !== input.workspaceId)) {
      throw new Error('Acceso denegado a una cuenta fuera del workspace activo.')
    }
    const related = [...accountData.values()].some(isPocketRelated)
    if (related && accountData.size !== ids.size) throw new Error('Falta una cuenta relacionada con el movimiento.')

    const parentIds = new Set([...accountData.values()].flatMap(data =>
      typeof data.parentAccountId === 'string' ? [data.parentAccountId] : []
    ))
    const parentRefs = [...parentIds].map(id => db.collection('accounts').doc(id))
    const parentSnaps = await Promise.all(parentRefs.map(ref => transaction.get(ref)))
    const parents = new Map<string, admin.firestore.DocumentData>()
    for (const snapshot of parentSnaps) {
      if (!snapshot.exists) throw new Error('No se encontró la cuenta principal del bolsillo.')
      parents.set(snapshot.id, snapshot.data()!)
    }
    const rootsToAudit = new Map<string, admin.firestore.DocumentData>()
    for (const [id, data] of accountData) if (data.parentAccountId == null) rootsToAudit.set(id, data)
    for (const [id, data] of parents) if (data.parentAccountId == null) rootsToAudit.set(id, data)
    const rootsToAuditIds = [...rootsToAudit.keys()]
    const childrenSnaps = await Promise.all(rootsToAuditIds.map(parentId =>
      transaction.get(db.collection('accounts').where('parentAccountId', '==', parentId))
    ))
    const childrenByParent = new Map<string, string[]>()
    rootsToAuditIds.forEach((parentId, index) => {
      childrenByParent.set(parentId, childrenSnaps[index].docs.map(snapshot => snapshot.id))
      const parent = rootsToAudit.get(parentId)!
      for (const childSnapshot of childrenSnaps[index].docs) {
        const child = childSnapshot.data()
        if (child.parentAccountId !== parentId || child.workspaceId !== input.workspaceId ||
            child.currency !== parent.currency || child.type !== 'savings' ||
            (Array.isArray(child.childAccountIds) && child.childAccountIds.length > 0) ||
            typeof child.pocketActivity !== 'boolean') {
          throw new Error('El registro contiene un bolsillo inválido.')
        }
      }
    })

    if (!related) {
      const legacyAccounts = [...accountData.entries()].map(([id, data]) => ({ id, data }))
      if (legacyAccounts.length !== ids.size) throw new Error('Una cuenta del movimiento no existe.')
      await assertLegacyTransactionAccountsAreUnpocketed(db, transaction, legacyAccounts)
    } else {
      for (const [accountId, data] of accountData) {
        assertMovementAccount(accountId, data, input.workspaceId, parents, childrenByParent)
      }
      if (before) {
        const source = accountData.get(before.accountId)
        const destination = before.toAccountId ? accountData.get(before.toAccountId) : undefined
        if (!source || before.currency !== source.currency) throw new Error('La transacción existente tiene una cuenta o moneda inválida.')
        assertSupportedPocketMovement(before, source, destination)
      }
    }

    let next: admin.firestore.DocumentData | null = null
    if (input.movement) {
      const movement = { ...input.movement, amount: roundMoney(Number(input.movement.amount)) }
      const source = accountData.get(movement.accountId)
      const destination = movement.toAccountId ? accountData.get(movement.toAccountId) : undefined
      if (!source) throw new Error('La cuenta origen no existe.')
      if (related) {
        assertSupportedPocketMovement(movement, source, destination)
        if (movement.type === 'transfer' && !destination) throw new Error('La cuenta destino no existe.')
        if (movement.userId && !Array.isArray(workspaceSnap.data()?.members) ||
            movement.userId && !workspaceSnap.data()!.members.includes(movement.userId)) {
          throw new Error('El usuario asociado al movimiento no pertenece al workspace.')
        }
      } else {
        assertLegacyMovement(movement, source, destination)
      }
      const date = movement.date instanceof Date ? movement.date : new Date()
      if (!Number.isFinite(date.getTime())) throw new Error('La fecha del movimiento no es válida.')
      next = {
        ...(input.kind === 'updated' && before ? before : {}),
        workspaceId: input.workspaceId,
        userId: movement.userId || input.userId,
        accountId: movement.accountId,
        amount: Number(movement.amount),
        description: movement.description,
        categoryId: movement.type === 'income' || movement.type === 'expense' ? movement.categoryId || '' : '',
        date: admin.firestore.Timestamp.fromDate(date),
        type: movement.type,
        toAccountId: movement.type === 'transfer' ? movement.toAccountId || null : null,
        receiptUrl: movement.receiptUrl ?? null,
        notes: movement.notes ?? null,
        installments: movement.type === 'expense' && source.type === 'credit' ? movement.installments || 1 : 1,
        currency: source.currency || 'USD',
        createdAt: input.kind === 'updated' && before ? before.createdAt : admin.firestore.FieldValue.serverTimestamp()
      }
    }

    const deltas: Record<string, number> = {}
    if (related) {
      if (before) addDeltas(deltas, legacyDeltas(before, -1))
      if (next) addDeltas(deltas, legacyDeltas(next, 1))
      for (const accountId of ids) {
        const delta = deltas[accountId] ?? 0
        const data = accountData.get(accountId)
        if (!data) throw new Error('Falta una cuenta relacionada con el movimiento.')
        const balance = roundMoney(Number(data.balance) + delta)
        if (!Number.isFinite(balance) || (isPocketRelated(data) && balance < 0)) {
          throw new Error('El saldo disponible de un bolsillo o cuenta principal no puede ser negativo.')
        }
        transaction.update(accountRefs.get(accountId)!, {
          balance,
          lastPocketMovementId: transactionId,
          lastPocketMovementType: input.kind,
          ...(typeof data.parentAccountId === 'string' ? { pocketActivity: true } : {}),
          ...(input.kind === 'deleted' && before?.pocketAllocation === true &&
              before.toAccountId === accountId && data.openingAllocationId === transactionId
            ? { openingAllocationId: null }
            : {})
        })
      }
    } else {
      if (before) addDeltas(deltas, legacyDeltas(before, -1))
      if (next) addDeltas(deltas, legacyDeltas(next, 1))
      for (const [accountId, delta] of Object.entries(deltas)) {
        const data = accountData.get(accountId)
        if (!data) throw new Error('Una cuenta del movimiento no existe.')
        const balance = roundMoney(Number(data.balance) + delta)
        if (!Number.isFinite(balance)) throw new Error('El saldo de la cuenta no es válido.')
        transaction.update(accountRefs.get(accountId)!, { balance })
      }
    }

    if (input.kind === 'created') transaction.create(transactionRef, next!)
    else if (input.kind === 'updated') transaction.update(transactionRef, next!)
    else transaction.delete(transactionRef)
    return { id: transactionId, transactionData: next ?? before! }
  })
}
