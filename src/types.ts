export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  members: string[];
  currency: string;
  expenseLimit?: number; // ponytail: simple number limit
  /** Explicit unit for legacy categoryBudgets; never inferred from currency or converted. */
  categoryBudgetCurrency?: string;
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
  // Recurring credit-card cycle days. Null/undefined keeps legacy accounts valid.
  statementClosingDay?: number | null;
  paymentDueDay?: number | null;
  mirror?: AccountMirror | null;
  // Pockets are one level deep; these fields are absent on legacy root accounts.
  parentAccountId?: string | null;
  childAccountIds?: string[];
  pocketActivity?: boolean;
  openingAllocationId?: string | null;
  lastPocketMovementId?: string;
  lastPocketMovementType?: 'created' | 'updated' | 'deleted';
  createdAt: Date;
}

// loan: plata que YO presto (sale de la cuenta, no es gasto).
// loan_payment: plata que me pagan de un préstamo (entra, no es ingreso).
export type TransactionType = 'income' | 'expense' | 'transfer' | 'loan' | 'loan_payment';

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
  // Full purchase stays in amount; KPIs distribute it across this many months.
  installments?: number | null;
  // Expense membership; absent/null preserves the protected monthly default.
  budgetId?: string | null;
  // ID de la pata gemela en el otro workspace (actividad espejo).
  mirrorOf?: string | null;
  // Distinguishes new bridge settlements from other mirrored transfers and their reversals.
  settlementType?: 'settlement' | 'reversal' | null;
  reversalOf?: string | null;
  reversedBy?: string | null;
  reversedAt?: Date | null;
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

export type OperatingBudgetKind = 'monthly' | 'event';

// Additional operating-budget record. The default monthly baseline remains in legacy workspace settings.
export interface OperatingBudget {
  id: string;
  workspaceId: string;
  kind: OperatingBudgetKind;
  name: string;
  capCurrency: string; // Stable denomination shared by this budget's scalar caps.
  totalLimit?: number;
  // Accounts whose movements belong to this budget (the selector is locked to it).
  linkedAccountIds?: string[];
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
  // Event planning metadata only; it does not affect transaction attribution or installments.
  startDate?: Date;
  endDate?: Date;
}

// Form input contains no record identity, lifecycle, audit, or ledger fields.
export type OperatingBudgetDraft = Pick<OperatingBudget,
  'kind' | 'name' | 'capCurrency' | 'totalLimit' | 'startDate' | 'endDate' | 'linkedAccountIds'
>;

// Omitted keys mean no change; null clears the optional limit or event date.
export interface OperatingBudgetPatch {
  name?: string;
  totalLimit?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
  linkedAccountIds?: string[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  // UI-only failure notice: never persisted nor sent to the model.
  isError?: boolean;
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
