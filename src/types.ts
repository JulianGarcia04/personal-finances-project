export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  members: string[];
  currency: string;
  expenseLimit?: number; // ponytail: simple number limit
  createdAt: string | Date;
}

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  currency: string;
  createdAt: Date;
  activeWorkspaceId?: string;
  workspaces?: string[];
  budgetIncome?: number;
  budgetNeedsPercent?: number;
  budgetWantsPercent?: number;
  budgetSavingsPercent?: number;
  budgetAllocations?: Record<string, number>;
}

export type AccountType = 'checking' | 'savings' | 'credit' | 'cash';

// Cuenta puente: un gasto registrado contra ella se replica automáticamente en otro
// workspace como transferencia (cuenta real que puso la plata -> cuenta por cobrar).
// Su saldo negativo = lo que este workspace le debe a quien pagó.
export interface AccountMirror {
  workspaceId: string;     // workspace espejo (ej. el personal de quien paga)
  accountId: string;       // cuenta "por cobrar" en el workspace espejo
  sourceAccountId: string; // cuenta real de donde sale la plata (ej. la tarjeta)
}

export interface Account {
  id: string;
  workspaceId: string;
  userId?: string; // Legacy / creator tracking
  name: string;
  type: AccountType;
  balance: number;
  limit: number;
  currency: string;
  mirror?: AccountMirror | null;
  createdAt: Date;
}

export type TransactionType = 'income' | 'expense' | 'transfer';

export interface Transaction {
  id: string;
  workspaceId: string;
  userId?: string; // Legacy / creator tracking
  accountId: string;
  amount: number;
  description: string;
  categoryId: string;
  date: Date;
  type: TransactionType;
  toAccountId?: string | null;
  statementImportId?: string | null;
  receiptUrl?: string | null;
  notes?: string | null;
  // ID de la pata gemela en el otro workspace (gastos espejo). Borrar una borra la otra.
  mirrorOf?: string | null;
  currency: string;
  createdAt: Date;
}

export interface Category {
  id: string;
  workspaceId: string | null;
  userId?: string | null; // Legacy
  name: string;
  icon: string;
  color: string;
  type: 'income' | 'expense' | 'both';
  createdAt?: Date;
}

export interface UserSettings {
  aiEnabled: boolean;
  useCustomKey: boolean;
  country: string;
  currency: string;
}

export interface Goal {
  id: string;
  workspaceId: string;
  userId?: string; // Legacy
  name: string;
  targetAmount: number;
  currentAmount: number;
  currency: string;
  targetDate: Date;
  createdAt: Date;
}

export interface BudgetSettings {
  budgetIncome: number;
  budgetNeedsPercent: number;
  budgetWantsPercent: number;
  budgetSavingsPercent: number;
  budgetAllocations: Record<string, number>;
  // Presupuesto mensual recurrente por categoría (categoryId -> límite)
  categoryBudgets: Record<string, number>;
  // Tasas de cambio manuales hacia la moneda principal (currency -> cuántas unidades de la principal vale 1 unidad)
  exchangeRates: Record<string, number>;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface Chat {
  id: string;
  workspaceId: string;
  userId?: string; // Legacy
  title: string;
  messages: ChatMessage[];
  createdAt: any;
  updatedAt: any;
}

