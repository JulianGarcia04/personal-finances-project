import { OperatingBudgetRecordSchema, OperatingBudgetDraftSchema, OperatingBudgetPatchSchema, StoredOperatingBudgetRecordSchema } from '../schemas.ts'
import type { OperatingBudget, OperatingBudgetDraft, OperatingBudgetPatch } from '../types.ts'
import { DEFAULT_MONTHLY_BUDGET_ID, linkedAccountsChange } from './budgets.ts'
import {
  Timestamp,
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
  type DocumentData,
  type Firestore,
  type WriteBatch
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

/** Accounts a previous budget keeps after some of its accounts move to the budget being saved. */
export interface BudgetLinkRelease {
  budgetId: string
  linkedAccountIds: string[]
}

export interface BudgetLinkOptions {
  releases?: readonly BudgetLinkRelease[]
}

// Only root, non-bridge, childless accounts can carry a budget link (the rules reject the rest).
const isLinkableAccount = (data: DocumentData, workspaceId: string): boolean =>
  data.workspaceId === workspaceId && data.mirror == null && data.parentAccountId == null &&
  (!Array.isArray(data.childAccountIds) || data.childAccountIds.length === 0)

const linkedAccountsWire = (ids: readonly string[]) => ids.length ? [...ids] : deleteField()

export const createBudgetPersistence = (db: Firestore, workspaceId: string) => {
  assertWorkspaceId(workspaceId)

  const read = async (budgetId: string): Promise<OperatingBudget> => {
    assertBudgetId(budgetId)
    const snapshot = await getDoc(doc(db, 'budgets', budgetId))
    if (!snapshot.exists()) throw new Error('Budget not found')
    return decodeOperatingBudgetRecord(snapshot.id, snapshot.data(), workspaceId)
  }

  // A deleted account reads as permission-denied (the rules need its workspace); skip it like a
  // missing one, since its link can no longer be written either.
  const readAccounts = async (accountIds: readonly string[]) => {
    const snapshots = await Promise.all(accountIds.map(accountId =>
      getDoc(doc(db, 'accounts', accountId)).catch((error: unknown) => {
        if ((error as { code?: string } | null)?.code === 'permission-denied') return null
        throw error
      })))
    return snapshots.flatMap(snapshot => {
      const data = snapshot?.exists() ? snapshot.data() : undefined
      return snapshot && data ? [{ ref: snapshot.ref, data }] : []
    })
  }

  // Each account mirrors its budget link (linkedBudgetId) so the rules can enforce it; the budget,
  // its accounts and the budgets those accounts leave are written in the same batch.
  const stageAccountLinks = async (
    batch: WriteBatch,
    budgetId: string,
    added: readonly string[],
    removed: readonly string[],
    releases: readonly BudgetLinkRelease[] = []
  ) => {
    for (const account of await readAccounts(added)) {
      if (isLinkableAccount(account.data, workspaceId)) batch.update(account.ref, { linkedBudgetId: budgetId })
    }
    for (const account of await readAccounts(removed)) {
      if (account.data.linkedBudgetId === budgetId) batch.update(account.ref, { linkedBudgetId: deleteField() })
    }
    for (const release of releases) {
      assertBudgetId(release.budgetId)
      if (release.budgetId === budgetId) continue
      batch.update(doc(db, 'budgets', release.budgetId), {
        linkedAccountIds: linkedAccountsWire(release.linkedAccountIds),
        updatedAt: serverTimestamp()
      })
    }
  }

  return {
    async create(input: OperatingBudgetDraft, options: BudgetLinkOptions = {}): Promise<OperatingBudget> {
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
      const linkedAccountIds = draft.linkedAccountIds ?? []
      if (linkedAccountIds.length) wire.linkedAccountIds = linkedAccountIds
      const batch = writeBatch(db)
      batch.set(ref, wire)
      await stageAccountLinks(batch, ref.id, linkedAccountIds, [], options.releases)
      await batch.commit()
      return read(ref.id)
    },

    async list(): Promise<OperatingBudget[]> {
      const result = await getDocs(query(collection(db, 'budgets'), where('workspaceId', '==', workspaceId)))
      return result.docs
        .map(snapshot => decodeOperatingBudgetRecord(snapshot.id, snapshot.data(), workspaceId))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    },

    read,

    async patch(budgetId: string, input: OperatingBudgetPatch, options: BudgetLinkOptions = {}): Promise<OperatingBudget> {
      assertBudgetId(budgetId)
      const patch = OperatingBudgetPatchSchema.parse(input)
      const current = await read(budgetId)
      if (current.archived) throw new Error('Archived budgets cannot be changed')

      const merged: Record<string, unknown> = { ...current }
      const wire: Record<string, unknown> = { updatedAt: serverTimestamp() }
      // Links are sent only when they change, and an empty list removes the field.
      const links = patch.linkedAccountIds === undefined
        ? { changed: false, added: [], removed: [] }
        : linkedAccountsChange(current.linkedAccountIds, patch.linkedAccountIds)
      if (patch.linkedAccountIds !== undefined && links.changed) {
        if (patch.linkedAccountIds.length) merged.linkedAccountIds = patch.linkedAccountIds
        else delete merged.linkedAccountIds
        wire.linkedAccountIds = linkedAccountsWire(patch.linkedAccountIds)
      }
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined || field === 'linkedAccountIds') continue
        if (value === null) {
          delete merged[field]
          wire[field] = deleteField()
        } else {
          merged[field] = value
          wire[field] = field === 'startDate' || field === 'endDate' ? planningTimestamp(value as Date) : value
        }
      }
      OperatingBudgetRecordSchema.parse(merged)
      const batch = writeBatch(db)
      batch.update(doc(db, 'budgets', budgetId), wire)
      await stageAccountLinks(batch, budgetId, links.added, links.removed, options.releases)
      await batch.commit()
      return read(budgetId)
    },

    async archive(budgetId: string): Promise<OperatingBudget> {
      assertBudgetId(budgetId)
      const current = await read(budgetId)
      if (current.archived) return current
      // The budget keeps its list as history; its accounts are free to join another budget.
      const batch = writeBatch(db)
      batch.update(doc(db, 'budgets', budgetId), { archived: true, updatedAt: serverTimestamp() })
      await stageAccountLinks(batch, budgetId, [], current.linkedAccountIds ?? [])
      await batch.commit()
      return read(budgetId)
    }
  }
}
