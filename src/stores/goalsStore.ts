import { defineStore } from 'pinia'
import type { BudgetSettings, Goal, OperatingBudget, OperatingBudgetDraft, OperatingBudgetPatch } from '../types.ts'
import {
  Timestamp,
  collection,
  query,
  where,
  getDocs,
  addDoc,
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
  runTransaction
} from 'firebase/firestore'
import {
  createBudgetWorkspaceAdapter,
  type BudgetWorkspaceAdapter,
  type BudgetWorkspaceAdapterDependencies,
  type BudgetWorkspaceBudgetSnapshot,
  type BudgetWorkspaceContext,
  type BudgetWorkspaceLegacyData,
  type CategoryBudgetCurrencyPatch,
  type CategoryBudgetCurrencyState
} from '../lib/budgetWorkspaceAdapter.ts'
import { createBudgetPersistence, type BudgetLinkOptions } from '../lib/budgetPersistence.ts'
import { createBudgetCategoryCapsPersistence } from '../lib/budgetCategoryCapsPersistence.ts'
import { DEFAULT_MONTHLY_BUDGET_ID } from '../lib/budgets.ts'
import { toDateValue } from '../lib/dates.ts'

interface GoalsState {
  goals: Goal[];
  budgetIncome: number;
  budgetNeedsPercent: number;
  budgetWantsPercent: number;
  budgetSavingsPercent: number;
  budgetAllocations: Record<string, number>;
  categoryBudgets: Record<string, number>;
  exchangeRates: Record<string, number>;
  operatingBudgets: BudgetWorkspaceBudgetSnapshot[];
  categoryBudgetCurrency: CategoryBudgetCurrencyState;
  budgetSettingsContextKey: string | null;
  budgetSettingsLoading: boolean;
  budgetSettingsError: string | null;
  budgetSettingsLoadVersion: number;
  // Workspace-wide budget alerts (notifyBudgetThreshold email + push). Absent means enabled.
  budgetAlertsEnabled: boolean;
  loading: boolean;
}

export interface GoalsBudgetSettingsDocument extends Partial<BudgetSettings> {
  categoryBudgetCurrency?: string
  budgetAlertsEnabled?: boolean
}

export type LegacyBudgetSettingsPatch = BudgetSettings

export interface GoalsBudgetManagementDependencies {
  getCurrentContext(): BudgetWorkspaceContext | null
  readWorkspaceSettings(workspaceId: string): Promise<GoalsBudgetSettingsDocument | null>
  createWorkspaceAdapter(): BudgetWorkspaceAdapter
  createBudgetPersistence(workspaceId: string): ReturnType<typeof createBudgetPersistence>
  createCategoryCapsPersistence(workspaceId: string): ReturnType<typeof createBudgetCategoryCapsPersistence>
  writeWorkspaceSettings(workspaceId: string, patch: LegacyBudgetSettingsPatch): Promise<void>
}

const defaultCategoryBudgetCurrency: CategoryBudgetCurrencyState = { status: 'unconfirmed' }
const defaultBudgetSettings = {
  budgetIncome: 0,
  budgetNeedsPercent: 50,
  budgetWantsPercent: 30,
  budgetSavingsPercent: 20
}

const contextKey = (context: BudgetWorkspaceContext): string => JSON.stringify([context.userId, context.workspaceId])
const sameContext = (left: BudgetWorkspaceContext | null, right: BudgetWorkspaceContext): boolean =>
  left?.userId === right.userId && left.workspaceId === right.workspaceId

const ownNumericRecord = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...(value as Record<string, number>) }
}

const finiteOr = (value: unknown, fallback: number): number => {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

const resetWorkspaceBudgetState = (state: GoalsState): void => {
  Object.assign(state, defaultBudgetSettings)
  state.budgetAllocations = {}
  state.categoryBudgets = {}
  state.exchangeRates = {}
  state.operatingBudgets = []
  state.categoryBudgetCurrency = { ...defaultCategoryBudgetCurrency }
  state.budgetSettingsError = null
  state.budgetAlertsEnabled = true
}

export const buildLegacyBudgetSettingsPatch = (settings: BudgetSettings): LegacyBudgetSettingsPatch => ({
  budgetIncome: Number(settings.budgetIncome),
  budgetNeedsPercent: Number(settings.budgetNeedsPercent),
  budgetWantsPercent: Number(settings.budgetWantsPercent),
  budgetSavingsPercent: Number(settings.budgetSavingsPercent),
  budgetAllocations: settings.budgetAllocations,
  categoryBudgets: settings.categoryBudgets,
  exchangeRates: settings.exchangeRates
})

const budgetByName = (entries: readonly BudgetWorkspaceBudgetSnapshot[]): BudgetWorkspaceBudgetSnapshot[] =>
  [...entries].sort((left, right) =>
    left.budget.name.localeCompare(right.budget.name) || left.budget.id.localeCompare(right.budget.id)
  )

const assertAdditionalBudgetId = (budgetId: string): void => {
  if (budgetId === DEFAULT_MONTHLY_BUDGET_ID) {
    throw new Error('The protected default monthly budget is not an additional budget')
  }
}

const defineOwnNumber = (record: Record<string, number>, key: string, value: number): void => {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true })
}

export const createGoalsBudgetActions = (
  state: GoalsState,
  dependencies: GoalsBudgetManagementDependencies
) => {
  const requireContext = (): BudgetWorkspaceContext => {
    const context = dependencies.getCurrentContext()
    if (!context || !context.userId.trim() || !context.workspaceId.trim()) {
      throw new Error('Active budget workspace context is required')
    }
    return { userId: context.userId, workspaceId: context.workspaceId }
  }

  const assertContextIsCurrent = (context: BudgetWorkspaceContext): void => {
    if (!sameContext(dependencies.getCurrentContext(), context)) {
      throw new Error('Budget workspace context changed during operation')
    }
  }

  const requireLoadedContext = (): BudgetWorkspaceContext => {
    const context = requireContext()
    if (state.budgetSettingsContextKey !== contextKey(context) || state.budgetSettingsLoading) {
      throw new Error('Budget settings are not ready for the active workspace')
    }
    return context
  }

  const updateBudgetEntry = (budget: OperatingBudget): void => {
    const index = state.operatingBudgets.findIndex(entry => entry.budget.id === budget.id)
    if (index < 0) return
    const existing = state.operatingBudgets[index]!
    const updated = [...state.operatingBudgets]
    updated[index] = { ...existing, budget }
    state.operatingBudgets = budgetByName(updated)
  }

  // Budgets that gave up accounts to the saved budget (written in the same batch).
  const applyLinkReleases = (options: BudgetLinkOptions): void => {
    for (const release of options.releases ?? []) {
      const entry = state.operatingBudgets.find(candidate => candidate.budget.id === release.budgetId)
      if (!entry) continue
      const { linkedAccountIds: _previous, ...rest } = entry.budget
      updateBudgetEntry(release.linkedAccountIds.length
        ? { ...rest, linkedAccountIds: [...release.linkedAccountIds] }
        : rest)
    }
  }

  return {
    async loadBudgetSettings(): Promise<void> {
      const context = dependencies.getCurrentContext()
      const requestVersion = ++state.budgetSettingsLoadVersion
      if (!context || !context.userId.trim() || !context.workspaceId.trim()) {
        state.budgetSettingsContextKey = null
        state.budgetSettingsLoading = false
        resetWorkspaceBudgetState(state)
        return
      }

      const captured = { userId: context.userId, workspaceId: context.workspaceId }
      const capturedKey = contextKey(captured)
      if (state.budgetSettingsContextKey !== capturedKey) {
        resetWorkspaceBudgetState(state)
        state.budgetSettingsContextKey = capturedKey
      }
      state.budgetSettingsLoading = true
      state.budgetSettingsError = null

      try {
        const adapter = dependencies.createWorkspaceAdapter()
        const [workspace, snapshot] = await Promise.all([
          dependencies.readWorkspaceSettings(captured.workspaceId),
          adapter.loadSnapshot()
        ])
        if (requestVersion !== state.budgetSettingsLoadVersion || !sameContext(dependencies.getCurrentContext(), captured)) return
        if (snapshot.context.userId !== captured.userId || snapshot.context.workspaceId !== captured.workspaceId) {
          throw new Error('Budget workspace context changed during operation')
        }
        if (snapshot.budgets.some(entry => entry.budget.id === DEFAULT_MONTHLY_BUDGET_ID)) {
          throw new Error('The protected default monthly budget cannot be loaded as an additional budget')
        }

        state.budgetIncome = finiteOr(workspace?.budgetIncome, defaultBudgetSettings.budgetIncome)
        state.budgetNeedsPercent = finiteOr(workspace?.budgetNeedsPercent, defaultBudgetSettings.budgetNeedsPercent)
        state.budgetWantsPercent = finiteOr(workspace?.budgetWantsPercent, defaultBudgetSettings.budgetWantsPercent)
        state.budgetSavingsPercent = finiteOr(workspace?.budgetSavingsPercent, defaultBudgetSettings.budgetSavingsPercent)
        state.budgetAllocations = ownNumericRecord(workspace?.budgetAllocations)
        state.categoryBudgets = ownNumericRecord(snapshot.legacy.categoryBudgets)
        state.exchangeRates = ownNumericRecord(snapshot.legacy.exchangeRates)
        state.categoryBudgetCurrency = snapshot.legacy.categoryBudgetCurrency
        state.budgetAlertsEnabled = workspace?.budgetAlertsEnabled !== false
        state.operatingBudgets = budgetByName(snapshot.budgets.map(entry => ({
          budget: entry.budget,
          categoryCaps: ownNumericRecord(entry.categoryCaps)
        })))
      } catch (error) {
        if (requestVersion === state.budgetSettingsLoadVersion && sameContext(dependencies.getCurrentContext(), captured)) {
          state.budgetSettingsError = error instanceof Error ? error.message : 'No se pudieron cargar los presupuestos.'
          console.error('Error al cargar configuraciones del presupuesto:', error)
        }
      } finally {
        if (requestVersion === state.budgetSettingsLoadVersion) state.budgetSettingsLoading = false
      }
    },

    async saveLegacySettings(settings: BudgetSettings): Promise<void> {
      const context = requireContext()
      if (state.budgetSettingsLoading || (state.budgetSettingsContextKey && state.budgetSettingsContextKey !== contextKey(context))) {
        throw new Error('Budget settings are not ready for the active workspace')
      }
      const patch = buildLegacyBudgetSettingsPatch(settings)
      await dependencies.writeWorkspaceSettings(context.workspaceId, patch)
      assertContextIsCurrent(context)
      state.budgetIncome = patch.budgetIncome
      state.budgetNeedsPercent = patch.budgetNeedsPercent
      state.budgetWantsPercent = patch.budgetWantsPercent
      state.budgetSavingsPercent = patch.budgetSavingsPercent
      state.budgetAllocations = ownNumericRecord(patch.budgetAllocations)
      state.categoryBudgets = ownNumericRecord(patch.categoryBudgets)
      state.exchangeRates = ownNumericRecord(patch.exchangeRates)
    },

    async createOperatingBudget(draft: OperatingBudgetDraft, options: BudgetLinkOptions = {}): Promise<OperatingBudget> {
      const context = requireLoadedContext()
      const budget = await dependencies.createBudgetPersistence(context.workspaceId).create(draft, options)
      assertContextIsCurrent(context)
      applyLinkReleases(options)
      if (budget.id === DEFAULT_MONTHLY_BUDGET_ID) throw new Error('The protected default monthly budget cannot be created')
      state.operatingBudgets = budgetByName([
        ...state.operatingBudgets.filter(entry => entry.budget.id !== budget.id),
        { budget, categoryCaps: {} }
      ])
      return budget
    },

    async updateOperatingBudget(budgetId: string, patch: OperatingBudgetPatch, options: BudgetLinkOptions = {}): Promise<OperatingBudget> {
      assertAdditionalBudgetId(budgetId)
      const context = requireLoadedContext()
      const budget = await dependencies.createBudgetPersistence(context.workspaceId).patch(budgetId, patch, options)
      assertContextIsCurrent(context)
      applyLinkReleases(options)
      updateBudgetEntry(budget)
      return budget
    },

    async archiveOperatingBudget(budgetId: string): Promise<OperatingBudget> {
      assertAdditionalBudgetId(budgetId)
      const context = requireLoadedContext()
      const budget = await dependencies.createBudgetPersistence(context.workspaceId).archive(budgetId)
      assertContextIsCurrent(context)
      updateBudgetEntry(budget)
      return budget
    },

    async saveOperatingBudgetCategoryCaps(budgetId: string, desiredCaps: Readonly<Record<string, number>>): Promise<void> {
      assertAdditionalBudgetId(budgetId)
      const context = requireLoadedContext()
      const entry = state.operatingBudgets.find(candidate => candidate.budget.id === budgetId)
      if (!entry) throw new Error('Budget not found in the active workspace')
      if (entry.budget.archived) throw new Error('Archived budgets cannot be changed')

      const caps = dependencies.createCategoryCapsPersistence(context.workspaceId)
      const categoryIds = new Set([...Object.keys(entry.categoryCaps), ...Object.keys(desiredCaps)])
      for (const categoryId of categoryIds) {
        const hadCap = Object.hasOwn(entry.categoryCaps, categoryId)
        const hasCap = Object.hasOwn(desiredCaps, categoryId)
        if (hadCap === hasCap && (!hadCap || entry.categoryCaps[categoryId] === desiredCaps[categoryId])) continue

        if (hasCap) await caps.set(budgetId, categoryId, desiredCaps[categoryId]!)
        else await caps.remove(budgetId, categoryId)
        assertContextIsCurrent(context)

        const current = state.operatingBudgets.find(candidate => candidate.budget.id === budgetId)
        if (!current) return
        const nextCaps = { ...current.categoryCaps }
        if (hasCap) defineOwnNumber(nextCaps, categoryId, desiredCaps[categoryId]!)
        else delete nextCaps[categoryId]
        const nextEntries = [...state.operatingBudgets]
        const index = nextEntries.findIndex(candidate => candidate.budget.id === budgetId)
        nextEntries[index] = { ...current, categoryCaps: nextCaps }
        state.operatingBudgets = nextEntries
      }
    },

    async confirmLegacyCategoryBudgetCurrency(code: string): Promise<'confirmed' | 'unchanged'> {
      const context = requireLoadedContext()
      const result = await dependencies.createWorkspaceAdapter().confirmLegacyCategoryBudgetCurrency(code)
      assertContextIsCurrent(context)
      state.categoryBudgetCurrency = { status: 'confirmed', code }
      return result
    }
  }
}

const loadGoalsRuntime = async () => {
  const [{ db, auth }, { useAuthStore }] = await Promise.all([
    import('../lib/firebase.ts'),
    import('./authStore.ts')
  ])
  return { db, auth, authStore: useAuthStore() }
}

const createRuntimeBudgetDependencies = (runtime: Awaited<ReturnType<typeof loadGoalsRuntime>>): GoalsBudgetManagementDependencies => {
  const getCurrentContext = (): BudgetWorkspaceContext | null => {
    const userId = runtime.auth.currentUser?.uid
    const workspaceId = runtime.authStore.activeWorkspaceId
    return userId && workspaceId ? { userId, workspaceId } : null
  }
  const readLegacyWorkspace = async (workspaceId: string): Promise<BudgetWorkspaceLegacyData | null> => {
    const snapshot = await getDoc(doc(runtime.db, 'workspaces', workspaceId))
    return snapshot.exists() ? snapshot.data() as BudgetWorkspaceLegacyData : null
  }

  return {
    getCurrentContext,
    async readWorkspaceSettings(workspaceId) {
      const snapshot = await getDoc(doc(runtime.db, 'workspaces', workspaceId))
      return snapshot.exists() ? snapshot.data() as GoalsBudgetSettingsDocument : null
    },
    createWorkspaceAdapter: () => createBudgetWorkspaceAdapter({
      getCurrentContext,
      readWorkspace: readLegacyWorkspace,
      createBudgetPersistence: workspaceId => createBudgetPersistence(runtime.db, workspaceId),
      createBudgetCategoryCapsPersistence: workspaceId => createBudgetCategoryCapsPersistence(runtime.db, workspaceId),
      runLegacyWorkspaceTransaction: ((context, callback) => runTransaction(runtime.db, async transaction => {
        const reference = doc(runtime.db, 'workspaces', context.workspaceId)
        const snapshot = await transaction.get(reference)
        if (!snapshot.exists()) throw new Error('Workspace not found')
        return callback(
          snapshot.data() as BudgetWorkspaceLegacyData,
          (patch: CategoryBudgetCurrencyPatch) => { transaction.update(reference, { ...patch }) }
        )
      })) satisfies BudgetWorkspaceAdapterDependencies['runLegacyWorkspaceTransaction']
    }),
    createBudgetPersistence: workspaceId => createBudgetPersistence(runtime.db, workspaceId),
    createCategoryCapsPersistence: workspaceId => createBudgetCategoryCapsPersistence(runtime.db, workspaceId),
    writeWorkspaceSettings: (workspaceId, patch) => updateDoc(doc(runtime.db, 'workspaces', workspaceId), { ...patch })
  }
}

export const useGoalsStore = defineStore('goals', {
  state: (): GoalsState => ({
    goals: [],
    budgetIncome: 0,
    budgetNeedsPercent: 50,
    budgetWantsPercent: 30,
    budgetSavingsPercent: 20,
    budgetAllocations: {},
    categoryBudgets: {},
    exchangeRates: {},
    operatingBudgets: [],
    categoryBudgetCurrency: { ...defaultCategoryBudgetCurrency },
    budgetSettingsContextKey: null,
    budgetSettingsLoading: false,
    budgetSettingsError: null,
    budgetSettingsLoadVersion: 0,
    budgetAlertsEnabled: true,
    loading: false,
  }),
  getters: {
    getGoalById: (state) => (id: string): Goal | undefined => state.goals.find(g => g.id === id),
    // Convierte un monto a la moneda principal usando las tasas manuales.
    // ponytail: si no hay tasa configurada, se suma tal cual (1:1) — el usuario configura las tasas en Objetivos & Presupuesto.
    convertToPrimary: (state) => (amount: number, currency: string, primaryCurrency: string): number => {
      if (!currency || currency === primaryCurrency) return amount
      const rate = state.exchangeRates[currency]
      return rate ? amount * rate : amount
    }
  },
  actions: {
    // 1. Cargar Objetivos de Ahorro
    async fetchGoals(): Promise<void> {
      const { db, authStore } = await loadGoalsRuntime()
      const workspaceId = authStore.activeWorkspaceId
      if (!workspaceId) return

      this.loading = true
      try {
        const q = query(collection(db, 'goals'), where('workspaceId', '==', workspaceId))
        const querySnapshot = await getDocs(q)
        const goalsList: Goal[] = []
        querySnapshot.forEach((docSnap) => {
          const data = docSnap.data()
          goalsList.push({
            id: docSnap.id,
            userId: data.userId,
            name: data.name,
            targetAmount: Number(data.targetAmount),
            currentAmount: Number(data.currentAmount || 0),
            currency: data.currency || 'USD',
            targetDate: toDateValue(data.targetDate),
            createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : new Date(data.createdAt),
          } as Goal)
        })
        this.goals = goalsList
      } catch (error) {
        console.error('Error al cargar metas de ahorro:', error)
      } finally {
        this.loading = false
      }
    },

    // 2. Agregar Objetivo
    async addGoal({ name, targetAmount, currentAmount = 0, currency = 'USD', targetDate }: {
      name: string;
      targetAmount: number;
      currentAmount?: number;
      currency?: string;
      targetDate: Date;
    }): Promise<Goal> {
      const { db, auth, authStore } = await loadGoalsRuntime()
      const user = auth.currentUser
      const workspaceId = authStore.activeWorkspaceId
      if (!user || !workspaceId) throw new Error('Usuario o Workspace no autenticado')

      this.loading = true
      try {
        const newGoal = {
          workspaceId,
          userId: user.uid,
          name,
          targetAmount: Number(targetAmount),
          currentAmount: Number(currentAmount),
          currency,
          targetDate: Timestamp.fromDate(targetDate),
          createdAt: Timestamp.fromDate(new Date())
        }

        const docRef = await addDoc(collection(db, 'goals'), newGoal)
        const goalWithId: Goal = {
          id: docRef.id,
          workspaceId,
          userId: user.uid,
          name,
          targetAmount: Number(targetAmount),
          currentAmount: Number(currentAmount),
          currency,
          targetDate,
          createdAt: new Date()
        }
        this.goals.push(goalWithId)
        return goalWithId
      } catch (error) {
        console.error('Error al guardar meta de ahorro:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // 3. Aportar Fondos o actualizar saldo
    async updateGoalAmount(goalId: string, currentAmount: number): Promise<void> {
      this.loading = true
      try {
        const { db } = await loadGoalsRuntime()
        const goalRef = doc(db, 'goals', goalId)
        await updateDoc(goalRef, {
          currentAmount: Number(currentAmount)
        })

        const index = this.goals.findIndex(g => g.id === goalId)
        if (index !== -1) {
          this.goals[index].currentAmount = Number(currentAmount)
        }
      } catch (error) {
        console.error('Error al actualizar saldo de la meta:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // 4. Eliminar Objetivo
    async deleteGoal(goalId: string): Promise<void> {
      this.loading = true
      try {
        const { db } = await loadGoalsRuntime()
        await deleteDoc(doc(db, 'goals', goalId))
        this.goals = this.goals.filter(g => g.id !== goalId)
        
        // Limpiar asignación de presupuesto si existía
        if (this.budgetAllocations[goalId]) {
          const newAllocations = { ...this.budgetAllocations }
          delete newAllocations[goalId]
          await this.saveBudgetSettings({
            budgetIncome: this.budgetIncome,
            budgetNeedsPercent: this.budgetNeedsPercent,
            budgetWantsPercent: this.budgetWantsPercent,
            budgetSavingsPercent: this.budgetSavingsPercent,
            budgetAllocations: newAllocations,
            categoryBudgets: this.categoryBudgets,
            exchangeRates: this.exchangeRates
          })
        }
      } catch (error) {
        console.error('Error al eliminar meta de ahorro:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // 5. Cargar configuraciones del presupuesto
    async loadBudgetSettings(): Promise<void> {
      const runtime = await loadGoalsRuntime()
      return createGoalsBudgetActions(this, createRuntimeBudgetDependencies(runtime)).loadBudgetSettings()
    },

    async createOperatingBudget(draft: OperatingBudgetDraft, options: BudgetLinkOptions = {}): Promise<OperatingBudget> {
      const runtime = await loadGoalsRuntime()
      return createGoalsBudgetActions(this, createRuntimeBudgetDependencies(runtime)).createOperatingBudget(draft, options)
    },

    async updateOperatingBudget(budgetId: string, patch: OperatingBudgetPatch, options: BudgetLinkOptions = {}): Promise<OperatingBudget> {
      const runtime = await loadGoalsRuntime()
      return createGoalsBudgetActions(this, createRuntimeBudgetDependencies(runtime)).updateOperatingBudget(budgetId, patch, options)
    },

    async archiveOperatingBudget(budgetId: string): Promise<OperatingBudget> {
      const runtime = await loadGoalsRuntime()
      return createGoalsBudgetActions(this, createRuntimeBudgetDependencies(runtime)).archiveOperatingBudget(budgetId)
    },

    async saveOperatingBudgetCategoryCaps(budgetId: string, categoryCaps: Readonly<Record<string, number>>): Promise<void> {
      const runtime = await loadGoalsRuntime()
      return createGoalsBudgetActions(this, createRuntimeBudgetDependencies(runtime))
        .saveOperatingBudgetCategoryCaps(budgetId, categoryCaps)
    },

    async confirmLegacyCategoryBudgetCurrency(code: string): Promise<'confirmed' | 'unchanged'> {
      const runtime = await loadGoalsRuntime()
      return createGoalsBudgetActions(this, createRuntimeBudgetDependencies(runtime))
        .confirmLegacyCategoryBudgetCurrency(code)
    },

    // 6. Guardar sólo la configuración heredada; los presupuestos adicionales viven en sus propios documentos.
    async saveBudgetSettings(settings: BudgetSettings): Promise<void> {
      const runtime = await loadGoalsRuntime()
      return createGoalsBudgetActions(this, createRuntimeBudgetDependencies(runtime)).saveLegacySettings(settings)
    },

    // 7. Activar/desactivar alertas de presupuesto (correo + push) del workspace activo
    async saveBudgetAlertsEnabled(enabled: boolean): Promise<void> {
      const runtime = await loadGoalsRuntime()
      const workspaceId = runtime.authStore.activeWorkspaceId
      if (!workspaceId) throw new Error('Workspace no inicializado')

      await updateDoc(doc(runtime.db, 'workspaces', workspaceId), { budgetAlertsEnabled: enabled })
      if (runtime.authStore.activeWorkspaceId === workspaceId) this.budgetAlertsEnabled = enabled
    }
  }
})
