// Must stay first: applies global function options before onCall below.
import './options'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { z } from 'zod'
import { roundMoney } from './money'
import { isPocketRelated } from './pockets'
import {
  isSettlementCandidate,
  planSettlement,
  planSettlementReversal,
  SettlementAccountRecord,
  SettlementLegRecord,
  SettlementRejection
} from './settlementPlan'

// Bridge settlements move four balances across two workspaces. The client writes
// them directly while no account has pockets; once one does, its balance may only
// change with pocket movement markers, which the client rules cannot grant to a
// cross-workspace pair. These Admin SDK paths validate the same invariants and
// stamp the markers, so pocket-related endpoints stay auditable.

type Firestore = admin.firestore.Firestore
type Transaction = admin.firestore.Transaction
type DocumentData = admin.firestore.DocumentData

export type SettleBridgeInput = {
  userId: string
  workspaceId: string
  bridgeAccountId: string
  receivableAccountId: string
  fromAccountId: string
  toAccountId: string
  amount: number
  date: number
  expectedBridgeBalance: number
}

export type SettlementLegInput = {
  userId: string
  workspaceId: string
  transactionId: string
}

const NEGATIVE_AVAILABLE = 'El saldo disponible de un bolsillo o cuenta principal no puede ser negativo.'

async function assertMemberOfBoth(
  db: Firestore,
  transaction: Transaction,
  userId: string,
  activeWorkspaceId: string,
  workspaceIds: string[]
): Promise<void> {
  const [userSnap, ...workspaceSnaps] = await Promise.all([
    transaction.get(db.collection('users').doc(userId)),
    ...workspaceIds.map(id => transaction.get(db.collection('workspaces').doc(id)))
  ])
  if (!userSnap.exists || userSnap.data()?.activeWorkspaceId !== activeWorkspaceId ||
      workspaceSnaps.some(snap => !snap.exists || !Array.isArray(snap.data()?.members) ||
        !snap.data()!.members.includes(userId))) {
    throw new SettlementRejection('Debes pertenecer a ambos workspaces de la liquidación.')
  }
}

/** Reads settlement accounts, refusing pockets and registries that disagree with their child accounts. */
async function readSettlementAccounts(
  db: Firestore,
  transaction: Transaction,
  accountIds: string[]
): Promise<Map<string, DocumentData>> {
  const ids = [...new Set(accountIds)]
  const [snaps, childrenSnaps] = await Promise.all([
    Promise.all(ids.map(id => transaction.get(db.collection('accounts').doc(id)))),
    Promise.all(ids.map(id => transaction.get(db.collection('accounts').where('parentAccountId', '==', id))))
  ])
  const accounts = new Map<string, DocumentData>()
  ids.forEach((id, index) => {
    if (!snaps[index].exists) throw new SettlementRejection('Falta una cuenta asociada a la liquidación')
    const data = snaps[index].data()!
    if (data.parentAccountId != null) {
      throw new SettlementRejection('Las liquidaciones usan la cuenta principal, no un bolsillo.')
    }
    const registered = data.childAccountIds === undefined ? [] : data.childAccountIds
    const actual = childrenSnaps[index].docs.map(snapshot => snapshot.id).sort()
    if (!Array.isArray(registered) || [...registered].sort().join('|') !== actual.join('|')) {
      throw new SettlementRejection('El registro de bolsillos de la cuenta no coincide con las cuentas hijas.')
    }
    if (typeof data.balance !== 'number' || !Number.isFinite(data.balance)) {
      throw new SettlementRejection('Una cuenta asociada tiene un saldo inválido')
    }
    accounts.set(id, data)
  })
  return accounts
}

/**
 * Applies balance deltas, refusing a negative available balance on accounts with
 * pockets and stamping those accounts with the leg recorded in their workspace.
 */
function updateBalances(
  db: Firestore,
  transaction: Transaction,
  accounts: Map<string, DocumentData>,
  deltas: Record<string, number>,
  legIdByWorkspace: Record<string, string>,
  movementType: 'created' | 'deleted'
): void {
  const updates = Object.entries(deltas).map(([accountId, delta]) => {
    const data = accounts.get(accountId)!
    const balance = roundMoney(data.balance + delta)
    const pocketRelated = isPocketRelated(data)
    if (!Number.isFinite(balance)) throw new SettlementRejection('Los saldos de la liquidación no son válidos')
    if (pocketRelated && balance < 0) throw new SettlementRejection(NEGATIVE_AVAILABLE)
    return {
      ref: db.collection('accounts').doc(accountId),
      patch: pocketRelated
        ? { balance, lastPocketMovementId: legIdByWorkspace[data.workspaceId], lastPocketMovementType: movementType }
        : { balance }
    }
  })
  for (const { ref, patch } of updates) transaction.update(ref, patch)
}

/** Records a partial or full bridge settlement: one transfer in each workspace and four balances. */
export async function settleBridge(db: Firestore, input: SettleBridgeInput): Promise<{ id: string; mirrorId: string }> {
  const date = new Date(input.date)
  if (!Number.isFinite(date.getTime())) throw new SettlementRejection('La fecha de la liquidación no es válida')
  const amount = roundMoney(Number(input.amount))
  const localRef = db.collection('transactions').doc()
  const mirrorRef = db.collection('transactions').doc()

  return db.runTransaction(async transaction => {
    const bridgeSnap = await transaction.get(db.collection('accounts').doc(input.bridgeAccountId))
    if (!bridgeSnap.exists) throw new SettlementRejection('La cuenta puente no existe')
    const mirror = bridgeSnap.data()!.mirror
    if (!mirror?.workspaceId || mirror.accountId !== input.receivableAccountId) {
      throw new SettlementRejection('El espejo cambió; vuelve a cargar la cuenta antes de liquidar')
    }
    await assertMemberOfBoth(db, transaction, input.userId, input.workspaceId, [input.workspaceId, mirror.workspaceId])
    const accounts = await readSettlementAccounts(db, transaction, [
      input.fromAccountId, input.bridgeAccountId, input.receivableAccountId, input.toAccountId
    ])
    const from = accounts.get(input.fromAccountId)!
    const bridge = accounts.get(input.bridgeAccountId)!
    const receivable = accounts.get(input.receivableAccountId)!
    const to = accounts.get(input.toAccountId)!

    if (bridge.workspaceId !== input.workspaceId || from.workspaceId !== input.workspaceId) {
      throw new SettlementRejection('La cuenta puente y la cuenta de pago deben pertenecer al workspace activo')
    }
    if (receivable.workspaceId !== mirror.workspaceId || to.workspaceId !== mirror.workspaceId) {
      throw new SettlementRejection('Las cuentas espejo no pertenecen al workspace configurado')
    }
    if (input.fromAccountId === input.bridgeAccountId) {
      throw new SettlementRejection('La cuenta de pago no puede ser la cuenta puente')
    }
    if (input.toAccountId === input.receivableAccountId) {
      throw new SettlementRejection('La cuenta que recibe no puede ser la cuenta por cobrar')
    }

    const deltas = planSettlement({
      amount,
      debt: -bridge.balance,
      bridgeCurrency: bridge.currency || 'USD',
      fromCurrency: from.currency || 'USD',
      receivableCurrency: receivable.currency || 'USD',
      toCurrency: to.currency || 'USD'
    })
    if (bridge.balance !== input.expectedBridgeBalance) {
      throw new SettlementRejection('El monto ya no es válido porque cambió el saldo del puente; vuelve a cargar la cuenta')
    }
    if (receivable.balance < amount) {
      throw new SettlementRejection('El saldo por cobrar no cubre el monto a liquidar')
    }

    updateBalances(db, transaction, accounts, {
      [input.fromAccountId]: deltas.from,
      [input.bridgeAccountId]: deltas.bridge,
      [input.receivableAccountId]: deltas.receivable,
      [input.toAccountId]: deltas.to
    }, { [input.workspaceId]: localRef.id, [mirror.workspaceId]: mirrorRef.id }, 'created')

    const shared = {
      amount,
      description: `Liquidación de ${bridge.name}`,
      categoryId: '',
      date: Timestamp.fromDate(date),
      type: 'transfer',
      receiptUrl: null,
      userId: input.userId,
      settlementType: 'settlement',
      createdAt: FieldValue.serverTimestamp()
    }
    transaction.create(localRef, {
      ...shared,
      workspaceId: input.workspaceId,
      accountId: input.fromAccountId,
      toAccountId: input.bridgeAccountId,
      notes: `Reembolso pagado desde ${from.name}`,
      mirrorOf: mirrorRef.id,
      currency: bridge.currency || 'USD'
    })
    transaction.create(mirrorRef, {
      ...shared,
      workspaceId: mirror.workspaceId,
      accountId: input.receivableAccountId,
      toAccountId: input.toAccountId,
      notes: `Reembolso recibido en ${to.name}`,
      mirrorOf: localRef.id,
      currency: to.currency || 'USD'
    })
    return { id: localRef.id, mirrorId: mirrorRef.id }
  })
}

async function readLinkedLegs(
  db: Firestore,
  transaction: Transaction,
  transactionId: string,
  workspaceId: string
): Promise<[SettlementLegRecord, SettlementLegRecord]> {
  const requestedSnap = await transaction.get(db.collection('transactions').doc(transactionId))
  if (!requestedSnap.exists) throw new SettlementRejection('No se encontró la liquidación')
  const requested = { ...requestedSnap.data(), id: requestedSnap.id } as SettlementLegRecord
  if (requested.workspaceId !== workspaceId || !requested.mirrorOf) {
    throw new SettlementRejection('La transacción no es una liquidación del workspace activo')
  }
  const twinSnap = await transaction.get(db.collection('transactions').doc(requested.mirrorOf))
  if (!twinSnap.exists) throw new SettlementRejection('No se encontró la pata vinculada de la liquidación')
  const twin = { ...twinSnap.data(), id: twinSnap.id } as SettlementLegRecord
  if (twin.mirrorOf !== requested.id || !twin.workspaceId || twin.workspaceId === requested.workspaceId) {
    throw new SettlementRejection('Las patas de la liquidación no están vinculadas entre workspaces')
  }
  return [requested, twin]
}

/** Records accounting-only compensating entries for a settlement; it never moves bank funds. */
export async function reverseBridgeSettlement(
  db: Firestore,
  input: SettlementLegInput
): Promise<{ paidReversalId: string; receivedReversalId: string }> {
  const paidReversalRef = db.collection('transactions').doc()
  const receivedReversalRef = db.collection('transactions').doc()

  return db.runTransaction(async transaction => {
    const [requested, twin] = await readLinkedLegs(db, transaction, input.transactionId, input.workspaceId)
    if (!isSettlementCandidate(requested)) {
      throw new SettlementRejection('La transacción no es una liquidación reversible del workspace activo')
    }
    await assertMemberOfBoth(db, transaction, input.userId, input.workspaceId, [requested.workspaceId, twin.workspaceId])
    const accountIds = [requested.accountId, requested.toAccountId, twin.accountId, twin.toAccountId]
    if (!accountIds.every((id): id is string => typeof id === 'string' && id.length > 0)) {
      throw new SettlementRejection('Las cuentas vinculadas de la liquidación no son válidas')
    }
    const accounts = await readSettlementAccounts(db, transaction, accountIds)
    const accountsById: Record<string, SettlementAccountRecord> = {}
    for (const [id, data] of accounts) accountsById[id] = { ...data, id } as SettlementAccountRecord
    const plan = planSettlementReversal({ first: requested, second: twin, accountsById })
    const paidLeg = requested.id === plan.paidLegId ? requested : twin
    const receivedLeg = paidLeg === requested ? twin : requested

    updateBalances(db, transaction, accounts, {
      [plan.fromAccountId]: plan.deltas.from,
      [plan.bridgeAccountId]: plan.deltas.bridge,
      [plan.receivableAccountId]: plan.deltas.receivable,
      [plan.toAccountId]: plan.deltas.to
    }, { [plan.workspaceId]: paidReversalRef.id, [plan.mirrorWorkspaceId]: receivedReversalRef.id }, 'created')

    const reversalDate = Timestamp.now()
    const sharedReversal = {
      amount: plan.amount,
      description: `Reversión contable de ${paidLeg.description}`,
      categoryId: '',
      date: reversalDate,
      type: 'transfer',
      receiptUrl: null,
      userId: input.userId,
      notes: 'Ajuste contable de Vault. No representa ni inicia un movimiento bancario.',
      settlementType: 'reversal',
      createdAt: reversalDate
    }
    transaction.create(paidReversalRef, {
      ...sharedReversal,
      workspaceId: plan.workspaceId,
      accountId: plan.bridgeAccountId,
      toAccountId: plan.fromAccountId,
      mirrorOf: receivedReversalRef.id,
      reversalOf: paidLeg.id,
      currency: paidLeg.currency
    })
    transaction.create(receivedReversalRef, {
      ...sharedReversal,
      workspaceId: plan.mirrorWorkspaceId,
      accountId: plan.toAccountId,
      toAccountId: plan.receivableAccountId,
      mirrorOf: paidReversalRef.id,
      reversalOf: receivedLeg.id,
      currency: receivedLeg.currency
    })
    transaction.update(db.collection('transactions').doc(paidLeg.id), {
      reversedBy: paidReversalRef.id,
      reversedAt: reversalDate
    })
    transaction.update(db.collection('transactions').doc(receivedLeg.id), {
      reversedBy: receivedReversalRef.id,
      reversedAt: reversalDate
    })
    return { paidReversalId: paidReversalRef.id, receivedReversalId: receivedReversalRef.id }
  })
}

/** Deletes both legs of a settlement (or of its reversal) and undoes their balances together. */
export async function deleteBridgeSettlement(db: Firestore, input: SettlementLegInput): Promise<void> {
  await db.runTransaction(async transaction => {
    const legs = await readLinkedLegs(db, transaction, input.transactionId, input.workspaceId)
    if (legs.some(leg => leg.type !== 'transfer' || leg.categoryId !== '' || !leg.toAccountId)) {
      throw new SettlementRejection('Solo las liquidaciones de cuentas puente se eliminan junto con su pata vinculada.')
    }
    await assertMemberOfBoth(db, transaction, input.userId, input.workspaceId, legs.map(leg => leg.workspaceId))
    const accounts = await readSettlementAccounts(db, transaction, legs.flatMap(leg => [leg.accountId, leg.toAccountId!]))

    const deltas: Record<string, number> = {}
    const legIdByWorkspace: Record<string, string> = {}
    for (const leg of legs) {
      const amount = Number(leg.amount)
      if (!Number.isFinite(amount)) throw new SettlementRejection('El monto de la liquidación no es válido')
      if (accounts.get(leg.accountId)!.workspaceId !== leg.workspaceId ||
          accounts.get(leg.toAccountId!)!.workspaceId !== leg.workspaceId) {
        throw new SettlementRejection('Las cuentas no corresponden a los workspaces de cada pata')
      }
      deltas[leg.accountId] = (deltas[leg.accountId] ?? 0) + amount
      deltas[leg.toAccountId!] = (deltas[leg.toAccountId!] ?? 0) - amount
      legIdByWorkspace[leg.workspaceId] = leg.id
    }
    updateBalances(db, transaction, accounts, deltas, legIdByWorkspace, 'deleted')
    for (const leg of legs) transaction.delete(db.collection('transactions').doc(leg.id))
  })
}

const idSchema = z.string().min(1).max(128)
const legRequestShape = { workspaceId: idSchema, transactionId: idSchema }
const bridgeSettlementRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('settle'),
    workspaceId: idSchema,
    bridgeAccountId: idSchema,
    receivableAccountId: idSchema,
    fromAccountId: idSchema,
    toAccountId: idSchema,
    amount: z.number().finite(),
    date: z.number().finite(),
    expectedBridgeBalance: z.number().finite()
  }),
  z.object({ action: z.literal('reverse'), ...legRequestShape }),
  z.object({ action: z.literal('delete'), ...legRequestShape })
])

const ABORTED_CODES = new Set<number | string>([10, 'aborted', 'ABORTED'])

export const bridgeSettlement = onCall(async request => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'La autenticación es obligatoria.')
  const parsed = bridgeSettlementRequestSchema.safeParse(request.data)
  if (!parsed.success) throw new HttpsError('invalid-argument', 'La solicitud de liquidación no es válida.')
  const userId = request.auth.uid
  const db = admin.firestore()
  try {
    const input = parsed.data
    if (input.action === 'settle') return await settleBridge(db, { ...input, userId })
    const leg = { userId, workspaceId: input.workspaceId, transactionId: input.transactionId }
    if (input.action === 'reverse') return await reverseBridgeSettlement(db, leg)
    await deleteBridgeSettlement(db, leg)
    return { deleted: true }
  } catch (error) {
    if (error instanceof SettlementRejection) throw new HttpsError('failed-precondition', error.message)
    if (ABORTED_CODES.has((error as { code?: number | string } | null)?.code ?? '')) {
      throw new HttpsError('aborted', 'Las cuentas están recibiendo otros cambios. Intenta de nuevo.')
    }
    logger.error('bridgeSettlement failed', error)
    throw new HttpsError('internal', 'No se pudo completar la liquidación. Intenta de nuevo más tarde.')
  }
})
