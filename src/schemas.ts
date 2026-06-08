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
    .max(3, 'El código de moneda debe tener exactamente 3 caracteres')
})

export const TransactionSchema = z.object({
  accountId: z.string().min(1, 'La cuenta de origen es requerida'),
  amount: z.number().refine(val => val !== 0, {
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
  type: z.enum(['income', 'expense', 'transfer']),
  toAccountId: z.string().nullable().optional(),
  receiptUrl: z.string().nullable().optional()
}).refine(data => {
  if (data.type === 'transfer') {
    return !!data.toAccountId && data.toAccountId !== data.accountId
  }
  return true;
}, {
  message: 'Las transferencias requieren una cuenta de destino diferente a la de origen',
  path: ['toAccountId']
})

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

export const CategorySchema = z.object({
  name: z.string()
    .min(1, 'El nombre es requerido')
    .max(30, 'El nombre no puede exceder 30 caracteres'),
  icon: z.string().min(1, 'El icono es requerido'),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color hexadecimal inválido'),
  type: z.enum(['income', 'expense', 'both'])
})
