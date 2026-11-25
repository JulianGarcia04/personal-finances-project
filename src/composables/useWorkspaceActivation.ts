import { useAuthStore } from '@/stores/authStore'
import { useAccountsStore } from '@/stores/accountsStore'
import { useGoalsStore } from '@/stores/goalsStore'
import { useTransactionsStore } from '@/stores/transactionsStore'

// Shared by the workspace switcher and workspace creation: make the workspace active, then
// reload every workspace-scoped store so no view keeps the previous workspace's data.
// It lives outside authStore on purpose: goalsStore imports authStore and accountsStore lazily,
// and those lazy imports stop working (INEFFECTIVE_DYNAMIC_IMPORT) once authStore imports them.
export async function activateWorkspace(workspaceId: string): Promise<void> {
  const authStore = useAuthStore()
  if (!authStore.user) return
  await authStore.switchWorkspace(workspaceId)
  const transactionsStore = useTransactionsStore()
  const goalsStore = useGoalsStore()
  await Promise.all([
    useAccountsStore().fetchAccounts(),
    transactionsStore.fetchTransactions(),
    goalsStore.fetchGoals(),
    goalsStore.loadBudgetSettings(),
    transactionsStore.fetchCategories()
  ])
}
