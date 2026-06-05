import { defineStore } from 'pinia'
import { db, auth } from '@/lib/firebase'
import { Goal, BudgetSettings } from '@/types'
import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
  Timestamp
} from 'firebase/firestore'

interface GoalsState {
  goals: Goal[];
  budgetIncome: number;
  budgetNeedsPercent: number;
  budgetWantsPercent: number;
  budgetSavingsPercent: number;
  budgetAllocations: Record<string, number>;
  loading: boolean;
}

export const useGoalsStore = defineStore('goals', {
  state: (): GoalsState => ({
    goals: [],
    budgetIncome: 0,
    budgetNeedsPercent: 50,
    budgetWantsPercent: 30,
    budgetSavingsPercent: 20,
    budgetAllocations: {},
    loading: false,
  }),
  getters: {
    getGoalById: (state) => (id: string): Goal | undefined => state.goals.find(g => g.id === id),
  },
  actions: {
    // 1. Cargar Objetivos de Ahorro
    async fetchGoals(): Promise<void> {
      const user = auth.currentUser
      if (!user) return

      this.loading = true
      try {
        const q = query(collection(db, 'goals'), where('userId', '==', user.uid))
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
            targetDate: data.targetDate instanceof Timestamp ? data.targetDate.toDate() : new Date(data.targetDate),
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
      const user = auth.currentUser
      if (!user) throw new Error('Usuario no autenticado')

      this.loading = true
      try {
        const newGoal = {
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
            budgetAllocations: newAllocations
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
      const user = auth.currentUser
      if (!user) return

      this.loading = true
      try {
        const userDoc = await getDoc(doc(db, 'users', user.uid))
        if (userDoc.exists()) {
          const data = userDoc.data()
          this.budgetIncome = data.budgetIncome !== undefined ? Number(data.budgetIncome) : 0
          this.budgetNeedsPercent = data.budgetNeedsPercent !== undefined ? Number(data.budgetNeedsPercent) : 50
          this.budgetWantsPercent = data.budgetWantsPercent !== undefined ? Number(data.budgetWantsPercent) : 30
          this.budgetSavingsPercent = data.budgetSavingsPercent !== undefined ? Number(data.budgetSavingsPercent) : 20
          this.budgetAllocations = data.budgetAllocations || {}
        }
      } catch (error) {
        console.error('Error al cargar configuraciones del presupuesto:', error)
      } finally {
        this.loading = false
      }
    },

    // 6. Guardar configuraciones del presupuesto
    async saveBudgetSettings(settings: BudgetSettings): Promise<void> {
      const user = auth.currentUser
      if (!user) throw new Error('Usuario no autenticado')

      this.loading = true
      try {
        const userRef = doc(db, 'users', user.uid)
        await updateDoc(userRef, {
          budgetIncome: Number(settings.budgetIncome),
          budgetNeedsPercent: Number(settings.budgetNeedsPercent),
          budgetWantsPercent: Number(settings.budgetWantsPercent),
          budgetSavingsPercent: Number(settings.budgetSavingsPercent),
          budgetAllocations: settings.budgetAllocations
        })

        this.budgetIncome = Number(settings.budgetIncome)
        this.budgetNeedsPercent = Number(settings.budgetNeedsPercent)
        this.budgetWantsPercent = Number(settings.budgetWantsPercent)
        this.budgetSavingsPercent = Number(settings.budgetSavingsPercent)
        this.budgetAllocations = settings.budgetAllocations
      } catch (error) {
        console.error('Error al guardar configuraciones del presupuesto:', error)
        throw error
      } finally {
        this.loading = false
      }
    }
  }
})
