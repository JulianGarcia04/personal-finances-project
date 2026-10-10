import * as admin from 'firebase-admin'

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

    const parentBalanceAfter = availableBalance - input.balance
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
