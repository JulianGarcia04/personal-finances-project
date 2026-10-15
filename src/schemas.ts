import { z } from 'zod'

export const AccountSchema = z.object({
  name: z.string()
    .min(1, 'El nombre es requerido')
    .max(50, 'El nombre no puede exceder 50 caracteres'),
  type: z.enum(['checking', 'savings', 'credit', 'cash'], {
    errorMap: () => ({ message: 'Tipo de cuenta inválido' })
  }),
  balance: z.number({
    invalid_type_error: 'El saldo debe ser un número'
  }),
  limit: z.number().default(0),
  currency: z.string()
    .min(3, 'El código de moneda debe tener exactamente 3 caracteres')
    .max(3, 'El código de moneda debe tener exactamente 3 caracteres'),
  statementClosingDay: z.number().int().min(1).max(31).nullable().optional(),
  paymentDueDay: z.number().int().min(1).max(31).nullable().optional(),
  parentAccountId: z.string().min(1).nullable().optional()
})

export const PocketOpeningSchema = z.object({
  name: z.string()
    .min(1, 'El nombre es requerido')
    .max(50, 'El nombre no puede exceder 50 caracteres'),
  parentAccountId: z.string().min(1, 'La cuenta principal es requerida'),
  balance: z.number().finite().min(0, 'El saldo inicial debe ser mayor o igual a cero'),
  currency: z.string().length(3).optional()
})

export const TransactionSchema = z.object({
  accountId: z.string().min(1, 'La cuenta de origen es requerida'),
  amount: z.number({
    invalid_type_error: 'El monto debe ser un número'
  }).refine(Number.isFinite, {
    message: 'El monto debe ser un número finito'
  }).refine(val => val !== 0, {
    message: 'El monto no puede ser cero'
  }),
  description: z.string()
    .min(1, 'La descripción es requerida')
    .max(100, 'La descripción no puede exceder los 100 caracteres'),
  categoryId: z.string().optional(),
  date: z.date({
    required_error: 'La fecha es requerida',
    invalid_type_error: 'Fecha inválida'
  }),
  type: z.enum(['income', 'expense', 'transfer', 'loan', 'loan_payment']),
  toAccountId: z.string().nullable().optional(),
  receiptUrl: z.string().nullable().optional(),
  notes: z.string().max(500, 'Las notas no pueden exceder 500 caracteres').nullable().optional(),
  installments: z.number().int().min(1).max(60).nullable().optional(),
  userId: z.string().optional()
}).refine(data => {
  if (data.type === 'transfer') {
    return !!data.toAccountId && data.toAccountId !== data.accountId
  }
  return true;
}, {
  message: 'Las transferencias requieren una cuenta de destino diferente a la de origen',
  path: ['toAccountId']
}).refine(data => {
  if (data.type === 'expense' || data.type === 'loan') return data.amount < 0
  return data.amount > 0
}, {
  message: 'Los gastos y préstamos deben tener un monto negativo; los ingresos, transferencias y pagos de préstamos deben tener uno positivo',
  path: ['amount']
})

// Statement descriptions come from external bank formats and do not use the
// shorter manual-transaction form limit. Firestore enforces document quotas.
export const StatementImportRowSchema = z.object({
  date: z.string().min(1).refine(value => Number.isFinite(new Date(value).getTime()), {
    message: 'Fecha inválida'
  }),
  description: z.string().min(1),
  amount: z.number().finite().refine(value => value !== 0, {
    message: 'El monto no puede ser cero'
  }),
  categorySuggestion: z.string()
}).strict()

export const StatementImportBatchSchema = z.array(StatementImportRowSchema).min(1)

export const ApiKeySchema = z.object({
  apiKey: z.string()
    .min(10, 'La API Key es demasiado corta')
    .regex(/^AIzaSy[A-Za-z0-9_-]{33}$/, 'Formato de API Key de Gemini inválido')
})

export const GoalSchema = z.object({
  name: z.string()
    .min(1, 'El nombre del objetivo es requerido')
    .max(50, 'El nombre no puede exceder 50 caracteres'),
  targetAmount: z.number({
    invalid_type_error: 'El monto objetivo debe ser un número'
  }).min(1, 'El monto objetivo debe ser mayor a 0'),
  currentAmount: z.number().default(0),
  currency: z.string()
    .min(3, 'El código de moneda debe tener exactamente 3 caracteres')
    .max(3, 'El código de moneda debe tener exactamente 3 caracteres'),
  targetDate: z.date({
    required_error: 'La fecha límite es requerida',
    invalid_type_error: 'Fecha límite inválida'
  })
})

export const BudgetSchema = z.object({
  budgetIncome: z.number({
    invalid_type_error: 'El ingreso mensual debe ser un número'
  }).min(0, 'El ingreso mensual debe ser mayor o igual a 0'),
  budgetNeedsPercent: z.number().min(0).max(100),
  budgetWantsPercent: z.number().min(0).max(100),
  budgetSavingsPercent: z.number().min(0).max(100),
}).refine(data => {
  return (data.budgetNeedsPercent + data.budgetWantsPercent + data.budgetSavingsPercent) === 100;
}, {
  message: 'La suma de los porcentajes debe ser exactamente 100%',
  path: ['budgetNeedsPercent']
})

// Limits are finite and nonnegative, with no arbitrary magnitude/product cap.
const operatingBudgetLimitSchema = z.number().finite().nonnegative()
const operatingBudgetNameSchema = z.string().trim().min(1).max(100)
const operatingBudgetCurrencySchema = z.string().regex(/^[A-Z]{3}$/)
const operatingBudgetDateSchema = z.date().refine(date => Number.isFinite(date.getTime()))
// Keep aligned with DEFAULT_MONTHLY_BUDGET_ID in src/lib/budgets.ts; the schema tests guard this contract.
const defaultOperatingBudgetId = 'default-monthly'
const operatingBudgetIdSchema = z.string().min(1).refine(id =>
  id.trim().length > 0 && !id.includes('/') && id !== '.' && id !== '..' && !/^__.*__$/.test(id),
  'Invalid Firestore document ID'
)
const additionalOperatingBudgetIdSchema = operatingBudgetIdSchema.refine(
  id => id !== defaultOperatingBudgetId,
  'The default monthly baseline is not an additional budget record'
)

export const OperatingBudgetKindSchema = z.enum(['monthly', 'event'])

const operatingBudgetPlanningFields = {
  startDate: operatingBudgetDateSchema.optional(),
  endDate: operatingBudgetDateSchema.optional()
}

const validateOperatingBudgetPlanning = (
  data: { kind: 'monthly' | 'event'; startDate?: Date; endDate?: Date },
  ctx: z.RefinementCtx
) => {
  if (data.kind === 'monthly' && (data.startDate !== undefined || data.endDate !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Monthly budgets cannot have planning dates' })
  }
  if (data.startDate && data.endDate && data.endDate < data.startDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Event end date cannot precede its start date' })
  }
}

export const OperatingBudgetDraftSchema = z.object({
  kind: OperatingBudgetKindSchema,
  name: operatingBudgetNameSchema,
  capCurrency: operatingBudgetCurrencySchema,
  totalLimit: operatingBudgetLimitSchema.optional(),
  ...operatingBudgetPlanningFields
}).strict().superRefine(validateOperatingBudgetPlanning)

// id is injected from the root document ID by the reader; createdAt/updatedAt must already be decoded Dates.
export const OperatingBudgetRecordSchema = z.object({
  id: additionalOperatingBudgetIdSchema,
  workspaceId: operatingBudgetIdSchema,
  kind: OperatingBudgetKindSchema,
  name: operatingBudgetNameSchema,
  capCurrency: operatingBudgetCurrencySchema,
  totalLimit: operatingBudgetLimitSchema.optional(),
  archived: z.boolean(),
  createdAt: operatingBudgetDateSchema,
  updatedAt: operatingBudgetDateSchema,
  ...operatingBudgetPlanningFields
}).strict().superRefine(validateOperatingBudgetPlanning)

// B2P must merge a patch with the stored record and validate the full post-state (kind/date chronology included).
export const OperatingBudgetPatchSchema = z.object({
  name: operatingBudgetNameSchema.optional(),
  totalLimit: operatingBudgetLimitSchema.nullable().optional(),
  startDate: operatingBudgetDateSchema.nullable().optional(),
  endDate: operatingBudgetDateSchema.nullable().optional()
}).strict().superRefine((patch, ctx) => {
  if (!Object.values(patch).some(value => value !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Patch must change at least one field' })
  }
})

export const CategorySchema = z.object({
  name: z.string()
    .min(1, 'El nombre es requerido')
    .max(30, 'El nombre no puede exceder 30 caracteres'),
  icon: z.string().min(1, 'El icono es requerido'),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color hexadecimal inválido'),
  type: z.enum(['income', 'expense', 'both'])
})
