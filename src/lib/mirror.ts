// Lógica pura del gasto compartido reembolsable (cuentas puente).
//
// Caso: un gasto del workspace A (ej. "casa") se paga con una cuenta real del
// workspace B (ej. la tarjeta personal). Se registran dos patas:
//   A: gasto contra la cuenta puente  -> consume el presupuesto de A
//   B: transferencia cuenta real -> cuenta "por cobrar"  -> no toca presupuesto de B
//
// Sin dependencias (ni Firebase ni Pinia) para poder verificar los signos aparte.

export interface MirrorDeltas {
  bridge: number // cuenta puente, en el workspace del gasto
  source: number // cuenta real que puso la plata, en el workspace espejo
  receivable: number // cuenta "por cobrar", en el workspace espejo
}

export interface MirrorPlanInput {
  amount: number // monto del gasto (negativo por convención, se normaliza)
  bridgeCurrency: string
  sourceCurrency: string
  receivableCurrency: string
}

/**
 * Valida y calcula los deltas de saldo de un gasto compartido.
 *
 * Invariantes (verificados en mirror.test.ts):
 *   source + receivable === 0  -> el patrimonio de quien paga no cambia: cambia cupo por derecho de cobro
 *   bridge + receivable === 0  -> las dos contrapartidas de la deuda se cancelan entre workspaces
 */
export function planMirror({ amount, bridgeCurrency, sourceCurrency, receivableCurrency }: MirrorPlanInput): MirrorDeltas {
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error('El monto del gasto compartido debe ser un número distinto de cero')
  }

  // Las transferencias del proyecto no convierten divisas (mueven el mismo número en
  // ambas cuentas), así que un espejo entre monedas distintas mentiría en los saldos.
  if (sourceCurrency !== bridgeCurrency || receivableCurrency !== bridgeCurrency) {
    throw new Error(
      `El gasto espejo requiere que las tres cuentas usen la misma moneda ` +
        `(puente: ${bridgeCurrency}, origen: ${sourceCurrency}, por cobrar: ${receivableCurrency})`
    )
  }

  const spent = -Math.abs(amount) // un gasto siempre resta, venga con el signo que venga
  return { bridge: spent, source: spent, receivable: -spent }
}

export interface SettlementDeltas {
  from: number // cuenta que paga la deuda, en el workspace del puente
  bridge: number // cuenta puente: sube hacia 0
  receivable: number // cuenta "por cobrar" del workspace espejo: baja hacia 0
  to: number // cuenta que recibe la plata, en el workspace espejo
}

export interface SettlementPlanInput {
  amount: number // monto a liquidar, positivo
  debt: number // deuda pendiente = -saldo del puente
  bridgeCurrency: string
  fromCurrency: string
  receivableCurrency: string
  toCurrency: string
}

/**
 * Valida y calcula los deltas de una liquidación (parcial o total) de la cuenta puente.
 *
 * Invariantes (verificados en mirror.test.ts):
 *   from + bridge === 0        -> el patrimonio del workspace deudor no cambia: ya tenía la deuda registrada
 *   receivable + to === 0      -> tu patrimonio no cambia: cambias derecho de cobro por plata
 */
export function planSettlement({
  amount,
  debt,
  bridgeCurrency,
  fromCurrency,
  receivableCurrency,
  toCurrency
}: SettlementPlanInput): SettlementDeltas {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('El monto a liquidar debe ser mayor a cero')
  }
  if (debt <= 0) {
    throw new Error('Esta cuenta puente no tiene nada pendiente de reembolso')
  }
  // Liquidar de más invertiría la deuda en silencio: casi siempre es un dedazo.
  if (amount > debt) {
    throw new Error(`No puedes liquidar más de lo pendiente (${debt})`)
  }
  if (fromCurrency !== bridgeCurrency || receivableCurrency !== bridgeCurrency || toCurrency !== bridgeCurrency) {
    throw new Error('Las cuatro cuentas de la liquidación deben usar la misma moneda')
  }

  return { from: -amount, bridge: amount, receivable: -amount, to: amount }
}

export interface SettlementLegRecord {
  id: string;
  workspaceId: string;
  accountId: string;
  toAccountId?: string | null;
  amount: number;
  description: string;
  categoryId: string;
  date: unknown;
  type: string;
  currency: string;
  mirrorOf?: string | null;
  notes?: string | null;
  settlementType?: string | null;
  reversedBy?: string | null;
  reversedAt?: unknown;
  reversalOf?: string | null;
}

export interface SettlementAccountRecord {
  id: string;
  workspaceId: string;
  currency: string;
  mirror?: {
    workspaceId?: string;
    accountId?: string;
    sourceAccountId?: string;
  } | null;
}

export interface SettlementReversalPlan {
  amount: number;
  paidLegId: string;
  receivedLegId: string;
  fromAccountId: string;
  bridgeAccountId: string;
  receivableAccountId: string;
  toAccountId: string;
  workspaceId: string;
  mirrorWorkspaceId: string;
  deltas: { from: number; bridge: number; receivable: number; to: number };
}

const PAID_NOTE_PREFIX = 'Reembolso pagado desde '
const RECEIVED_NOTE_PREFIX = 'Reembolso recibido en '
const SETTLEMENT_DESCRIPTION_PREFIX = 'Liquidación de '

export function isSettlementCandidate(record: Partial<SettlementLegRecord>): boolean {
  if (
    record.type !== 'transfer' || !record.mirrorOf ||
    record.reversedBy != null || record.reversedAt != null || record.reversalOf != null ||
    record.settlementType === 'reversal'
  ) return false

  if (record.settlementType === 'settlement') return true
  if (record.settlementType != null) return false

  const note = record.notes || ''
  return !!record.description?.startsWith(SETTLEMENT_DESCRIPTION_PREFIX) &&
    (note.startsWith(PAID_NOTE_PREFIX) || note.startsWith(RECEIVED_NOTE_PREFIX))
}

const invalidSettlement = (reason: string): never => {
  throw new Error(`El par no es una liquidación de puente válida: ${reason}`)
}

const dateInMillis = (value: unknown): number => {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).getTime()
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return value.toDate().getTime()
  }
  return NaN
}

/** Validates current and legacy settlement pairs before calculating an accounting-only reversal. */
export function planSettlementReversal({
  first,
  second,
  accountsById
}: {
  first: SettlementLegRecord;
  second: SettlementLegRecord;
  accountsById: Record<string, SettlementAccountRecord | undefined>;
}): SettlementReversalPlan {
  if (!first.id || !second.id || first.id === second.id || first.mirrorOf !== second.id || second.mirrorOf !== first.id) {
    return invalidSettlement('los vínculos entre las dos patas no son recíprocos')
  }
  if (first.type !== 'transfer' || second.type !== 'transfer') {
    return invalidSettlement('las dos patas deben ser transferencias')
  }
  if (first.settlementType != null || second.settlementType != null) {
    if (first.settlementType !== 'settlement' || second.settlementType !== 'settlement') {
      return invalidSettlement('el tipo de liquidación no coincide en ambas patas')
    }
  }
  if (
    first.reversedBy != null || second.reversedBy != null || first.reversedAt != null || second.reversedAt != null ||
    first.reversalOf != null || second.reversalOf != null
  ) {
    throw new Error('La liquidación ya fue revertida')
  }

  const paidLeg = first.notes?.startsWith(PAID_NOTE_PREFIX) ? first : second
  const receivedLeg = paidLeg === first ? second : first
  if (
    !paidLeg.notes?.startsWith(PAID_NOTE_PREFIX) || paidLeg.notes.slice(PAID_NOTE_PREFIX.length).trim() === '' ||
    !receivedLeg.notes?.startsWith(RECEIVED_NOTE_PREFIX) || receivedLeg.notes.slice(RECEIVED_NOTE_PREFIX.length).trim() === ''
  ) return invalidSettlement('las notas no identifican de forma inequívoca una liquidación')
  if (
    !paidLeg.description.startsWith(SETTLEMENT_DESCRIPTION_PREFIX) ||
    paidLeg.description.slice(SETTLEMENT_DESCRIPTION_PREFIX.length).trim() === '' ||
    receivedLeg.description !== paidLeg.description
  ) return invalidSettlement('la descripción no identifica la misma liquidación')
  if (paidLeg.categoryId !== '' || receivedLeg.categoryId !== '') {
    return invalidSettlement('las patas deben ser transferencias sin categoría')
  }
  if (
    !Number.isFinite(paidLeg.amount) || paidLeg.amount <= 0 ||
    !Number.isFinite(receivedLeg.amount) || receivedLeg.amount !== paidLeg.amount
  ) return invalidSettlement('los montos no coinciden o no son positivos')
  if (
    !paidLeg.workspaceId || !receivedLeg.workspaceId || paidLeg.workspaceId === receivedLeg.workspaceId ||
    dateInMillis(paidLeg.date) !== dateInMillis(receivedLeg.date)
  ) return invalidSettlement('los workspaces o las fechas no coinciden')
  if (
    typeof paidLeg.currency !== 'string' || !paidLeg.currency ||
    receivedLeg.currency !== paidLeg.currency
  ) return invalidSettlement('las monedas de las patas no coinciden')

  const fromAccountId = paidLeg.accountId
  const bridgeAccountId = paidLeg.toAccountId
  const receivableAccountId = receivedLeg.accountId
  const toAccountId = receivedLeg.toAccountId
  if (!fromAccountId || !bridgeAccountId || !receivableAccountId || !toAccountId) {
    return invalidSettlement('faltan cuentas en las patas de la liquidación')
  }
  if (new Set([fromAccountId, bridgeAccountId, receivableAccountId, toAccountId]).size !== 4) {
    return invalidSettlement('las cuatro cuentas deben ser distintas')
  }

  const from = accountsById[fromAccountId]
  const bridge = accountsById[bridgeAccountId]
  const receivable = accountsById[receivableAccountId]
  const to = accountsById[toAccountId]
  if (!from || !bridge || !receivable || !to) return invalidSettlement('falta una cuenta asociada')
  if (
    from.id !== fromAccountId || bridge.id !== bridgeAccountId ||
    receivable.id !== receivableAccountId || to.id !== toAccountId ||
    from.workspaceId !== paidLeg.workspaceId || bridge.workspaceId !== paidLeg.workspaceId ||
    receivable.workspaceId !== receivedLeg.workspaceId || to.workspaceId !== receivedLeg.workspaceId
  ) return invalidSettlement('las cuentas no corresponden a los workspaces de cada pata')
  if (
    !from.currency || !bridge.currency || !receivable.currency || !to.currency ||
    from.currency !== paidLeg.currency || bridge.currency !== paidLeg.currency ||
    receivable.currency !== paidLeg.currency || to.currency !== paidLeg.currency
  ) return invalidSettlement('las cuentas y las patas deben usar la misma moneda')
  if (
    !bridge.mirror || bridge.mirror.workspaceId !== receivedLeg.workspaceId ||
    bridge.mirror.accountId !== receivableAccountId || !bridge.mirror.sourceAccountId
  ) return invalidSettlement('la cuenta puente ya no identifica la cuenta espejo')

  return {
    amount: paidLeg.amount,
    paidLegId: paidLeg.id,
    receivedLegId: receivedLeg.id,
    fromAccountId,
    bridgeAccountId,
    receivableAccountId,
    toAccountId,
    workspaceId: paidLeg.workspaceId,
    mirrorWorkspaceId: receivedLeg.workspaceId,
    deltas: {
      from: paidLeg.amount,
      bridge: -paidLeg.amount,
      receivable: paidLeg.amount,
      to: -paidLeg.amount
    }
  }
}
