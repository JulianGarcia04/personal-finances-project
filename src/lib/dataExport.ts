// Portable JSON copy of one workspace, built from the documents the signed-in
// member can read. Pure: the Firestore reads live in dataExportFetch.ts.

export const EXPORT_COLLECTIONS = ['accounts', 'transactions', 'categories', 'goals', 'budgets', 'chats'] as const

export type ExportCollection = (typeof EXPORT_COLLECTIONS)[number]
export type ExportRecord = { id: string } & Record<string, unknown>

const isTimestampLike = (value: unknown): value is { toDate: () => Date } =>
  typeof value === 'object' && value !== null && typeof (value as { toDate?: unknown }).toDate === 'function'

/** Firestore timestamps and dates become ISO strings; everything else is copied as is. */
export function normalizeForExport(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (isTimestampLike(value)) return value.toDate().toISOString()
  if (Array.isArray(value)) return value.map(normalizeForExport)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeForExport(item)]))
  }
  return value
}

export function buildWorkspaceExport(input: {
  now: Date
  workspace: Record<string, unknown>
  profile: Record<string, unknown> | null
  collections: Record<ExportCollection, ExportRecord[]>
  budgetCategoryCaps: Record<string, ExportRecord[]>
}) {
  const collections = {
    ...input.collections,
    budgets: input.collections.budgets.map((budget) => ({
      ...budget,
      categoryCaps: input.budgetCategoryCaps[budget.id] ?? []
    }))
  }
  return {
    format: 'vault-export' as const,
    formatVersion: 1 as const,
    exportedAt: input.now.toISOString(),
    workspace: normalizeForExport(input.workspace),
    profile: normalizeForExport(input.profile),
    ...(normalizeForExport(collections) as Record<ExportCollection, unknown[]>)
  }
}

export function exportFileName(workspaceName: string, now: Date): string {
  const slug = workspaceName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace'
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `vault-${slug}-${day}.json`
}
