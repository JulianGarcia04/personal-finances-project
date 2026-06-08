export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  currency: string;
  createdAt: Date;
  budgetIncome?: number;
  budgetNeedsPercent?: number;
  budgetWantsPercent?: number;
  budgetSavingsPercent?: number;
  budgetAllocations?: Record<string, number>;
}

export type AccountType = 'checking' | 'savings' | 'credit' | 'cash';

export interface Account {
  id: string;
  userId: string;
  name: string;
  type: AccountType;
  balance: number;
  limit: number;
  currency: string;
  createdAt: Date;
}

export type TransactionType = 'income' | 'expense' | 'transfer';

export interface Transaction {
  id: string;
  userId: string;
  accountId: string;
  amount: number;
  description: string;
  categoryId: string;
  date: Date;
  type: TransactionType;
  toAccountId?: string | null;
  statementImportId?: string | null;
  receiptUrl?: string | null;
  currency: string;
  createdAt: Date;
}

export interface Category {
  id: string;
  userId: string | null;
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
  userId: string;
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
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface Chat {
  id: string;
  userId: string;
  title: string;
  messages: ChatMessage[];
  createdAt: any;
  updatedAt: any;
}

