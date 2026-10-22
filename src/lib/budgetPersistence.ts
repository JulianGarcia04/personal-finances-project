import { OperatingBudgetRecordSchema, OperatingBudgetDraftSchema, OperatingBudgetPatchSchema, StoredOperatingBudgetRecordSchema } from '../schemas.ts'
import type { OperatingBudget, OperatingBudgetDraft, OperatingBudgetPatch } from '../types.ts'
import { DEFAULT_MONTHLY_BUDGET_ID } from './budgets.ts'
import {
  Timestamp,
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Firestore
} from 'firebase/firestore'

const assertWorkspaceId = (id: string) => {
  if (typeof id !== 'string' || !id.trim() || id.includes('/') || id === '.' || id === '..' || /^__.*__$/.test(id)) {
    throw new Error('Invalid workspace ID')
  }
}

const assertBudgetId = (id: string) => {
  if (typeof id !== 'string' || !id.trim() || id === DEFAULT_MONTHLY_BUDGET_ID || id.includes('/') || id === '.' || id === '..' || /^__.*__$/.test(id)) {
    throw new Error('Invalid additional budget ID')
  }
}

const decodedTimestamp = (value: unknown, field: string): Date => {
  if (!(value instanceof Timestamp)) throw new Error(`Malformed budget ${field}: expected Firestore Timestamp`)
  const date = value.toDate()
  if (!Number.isFinite(date.getTime())) throw new Error(`Malformed budget ${field}: invalid date`)
  return date
}

export const decodeOperatingBudgetRecord = (
  documentId: string,
  data: Record<string, unknown>,
  workspaceId: string
): OperatingBudget => {
  assertBudgetId(documentId)
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.hasOwn(data, 'id')) {
    throw new Error('Malformed budget document identity')
  }
  if (data.workspaceId !== workspaceId) throw new Error('Budget belongs to a different workspace')

  const decoded: Record<string, unknown> = {
    ...data,
    id: documentId,
    createdAt: decodedTimestamp(data.createdAt, 'createdAt'),
    updatedAt: decodedTimestamp(data.updatedAt, 'updatedAt')
  }
  for (const field of ['startDate', 'endDate'] as const) {
    if (Object.hasOwn(data, field)) decoded[field] = decodedTimestamp(data[field], field)
  }
  // Rules only bound the list size, so keep the valid, unique account IDs instead of rejecting the budget.
  if (Object.hasOwn(data, 'linkedAccountIds')) {
    const ids = Array.isArray(data.linkedAccountIds) ? data.linkedAccountIds : []
    decoded.linkedAccountIds = [...new Set(ids.filter((id): id is string =>
      typeof id === 'string' && id.trim().length > 0 && !id.includes('/') && id !== '.' && id !== '..'))]
  }
  return StoredOperatingBudgetRecordSchema.parse(decoded)
}

const planningTimestamp = (date: Date) => Timestamp.fromDate(date)

export const createBudgetPersistence = (db: Firestore, workspaceId: string) => {
  assertWorkspaceId(workspaceId)

  const read = async (budgetId: string): Promise<OperatingBudget> => {
    assertBudgetId(budgetId)
    const snapshot = await getDoc(doc(db, 'budgets', budgetId))
    if (!snapshot.exists()) throw new Error('Budget not found')
    return decodeOperatingBudgetRecord(snapshot.id, snapshot.data(), workspaceId)
  }

  return {
    async create(input: OperatingBudgetDraft): Promise<OperatingBudget> {
      const draft = OperatingBudgetDraftSchema.parse(input)
      const ref = doc(collection(db, 'budgets'))
      assertBudgetId(ref.id)
      const wire: Record<string, unknown> = {
        workspaceId,
        kind: draft.kind,
        name: draft.name,
        capCurrency: draft.capCurrency,
        archived: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
      if (draft.totalLimit !== undefined) wire.totalLimit = draft.totalLimit
      if (draft.startDate !== undefined) wire.startDate = planningTimestamp(draft.startDate)
      if (draft.endDate !== undefined) wire.endDate = planningTimestamp(draft.endDate)
      if (draft.linkedAccountIds !== undefined) wire.linkedAccountIds = draft.linkedAccountIds
      await setDoc(ref, wire)
      return read(ref.id)
    },

    async list(): Promise<OperatingBudget[]> {
      const result = await getDocs(query(collection(db, 'budgets'), where('workspaceId', '==', workspaceId)))
      return result.docs
        .map(snapshot => decodeOperatingBudgetRecord(snapshot.id, snapshot.data(), workspaceId))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    },

    read,

    async patch(budgetId: string, input: OperatingBudgetPatch): Promise<OperatingBudget> {
      assertBudgetId(budgetId)
      const patch = OperatingBudgetPatchSchema.parse(input)
      const current = await read(budgetId)
      if (current.archived) throw new Error('Archived budgets cannot be changed')

      const merged: Record<string, unknown> = { ...current }
      const wire: Record<string, unknown> = { updatedAt: serverTimestamp() }
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue
        if (value === null) {
          delete merged[field]
          wire[field] = deleteField()
        } else {
          merged[field] = value
          wire[field] = field === 'startDate' || field === 'endDate' ? planningTimestamp(value as Date) : value
        }
      }
      OperatingBudgetRecordSchema.parse(merged)
      await updateDoc(doc(db, 'budgets', budgetId), wire)
      return read(budgetId)
    },

    async archive(budgetId: string): Promise<OperatingBudget> {
      assertBudgetId(budgetId)
      const current = await read(budgetId)
      if (current.archived) return current
      await updateDoc(doc(db, 'budgets', budgetId), { archived: true, updatedAt: serverTimestamp() })
      return read(budgetId)
    }
  }
}
