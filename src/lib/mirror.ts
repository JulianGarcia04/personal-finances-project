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
