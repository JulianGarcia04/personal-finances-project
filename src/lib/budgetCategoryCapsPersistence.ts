import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  type Firestore
} from 'firebase/firestore'
import { createBudgetPersistence } from './budgetPersistence.ts'

const assertWorkspaceId = (id: string) => {
  if (typeof id !== 'string' || !id.trim() || id.includes('/') || id === '.' || id === '..' || /^__.*__$/.test(id)) {
    throw new Error('Invalid workspace ID')
  }
}

const assertBudgetId = (id: string) => {
  if (typeof id !== 'string' || !id.trim() || id === 'default-monthly' || id.includes('/') || id === '.' || id === '..' || /^__.*__$/.test(id)) {
    throw new Error('Invalid budget ID')
  }
}

const assertCategoryId = (id: string) => {
  if (typeof id !== 'string' || !id.trim() || id.includes('/') || id === '.' || id === '..' || id === '__proto__' || /^__.*__$/.test(id)) {
    throw new Error('Invalid category ID')
  }
}

const assertAmount = (amount: number) => {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new Error('Category cap amount must be a finite nonnegative number')
  }
}

export const decodeBudgetCategoryCap = (data: unknown): number => {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype) {
    throw new Error('Malformed category cap document')
  }
  const keys = Reflect.ownKeys(data)
  const amount = Object.getOwnPropertyDescriptor(data, 'amount')
  if (keys.length !== 1 || keys[0] !== 'amount' || !amount || !amount.enumerable || !('value' in amount)) {
    throw new Error('Malformed category cap document')
  }
  assertAmount(amount.value as number)
  return amount.value as number
}

export const buildBudgetCategoryCapsRecord = (entries: Iterable<readonly [string, unknown]>): Record<string, number> => {
  const caps: Record<string, number> = {}
  for (const [categoryId, data] of entries) {
    Object.defineProperty(caps, categoryId, {
      value: decodeBudgetCategoryCap(data), enumerable: true, configurable: true, writable: true
    })
  }
  return caps
}

export const createBudgetCategoryCapsPersistence = (db: Firestore, workspaceId: string) => {
  assertWorkspaceId(workspaceId)
  const parentPersistence = createBudgetPersistence(db, workspaceId)
  const authorizeParent = async (budgetId: string, allowArchived: boolean) => {
    assertBudgetId(budgetId)
    const parent = await parentPersistence.read(budgetId)
    if (!allowArchived && parent.archived) throw new Error('Archived budgets cannot change category caps')
  }
  const capRef = (budgetId: string, categoryId: string) => {
    assertBudgetId(budgetId)
    assertCategoryId(categoryId)
    return doc(db, 'budgets', budgetId, 'categoryCaps', categoryId)
  }

  return {
    async list(budgetId: string): Promise<Record<string, number>> {
      await authorizeParent(budgetId, true)
      const snapshot = await getDocs(collection(db, 'budgets', budgetId, 'categoryCaps'))
      return buildBudgetCategoryCapsRecord(snapshot.docs.map(document => [document.id, document.data()] as const))
    },

    async read(budgetId: string, categoryId: string): Promise<number | undefined> {
      const ref = capRef(budgetId, categoryId)
      await authorizeParent(budgetId, true)
      const snapshot = await getDoc(ref)
      return snapshot.exists() ? decodeBudgetCategoryCap(snapshot.data()) : undefined
    },

    async set(budgetId: string, categoryId: string, amount: number): Promise<void> {
      assertAmount(amount)
      const ref = capRef(budgetId, categoryId)
      await authorizeParent(budgetId, false)
      await setDoc(ref, { amount })
    },

    async remove(budgetId: string, categoryId: string): Promise<void> {
      const ref = capRef(budgetId, categoryId)
      await authorizeParent(budgetId, false)
      await deleteDoc(ref)
    }
  }
}
