import { defineStore } from 'pinia'
import { db, auth } from '@/lib/firebase'
import { Workspace, UserProfile } from '@/types'
import { collection, query, where, getDocs, doc, setDoc, updateDoc, getDoc } from 'firebase/firestore'
import { useAuthStore } from './authStore'
import { parseBudgetBasis, type BudgetBasis } from '@/lib/budgetBasis'

interface WorkspacesState {
  workspaces: Workspace[];
  activeWorkspaceProfiles: UserProfile[];
  loading: boolean;
  pendingExpenseLimitWrites: Set<string>;
  pendingBudgetCardBasisWrites: Set<string>;
}

// Función auxiliar (puedes adaptarla a tu entorno)
const getFunctionUrl = (name: string): string => {
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID || "vault-finances-dev"
  if (import.meta.env.DEV) {
    return `http://localhost:5001/${projectId}/us-central1/${name}`
  }
  return `https://us-central1-${projectId}.cloudfunctions.net/${name}`
}

export const useWorkspacesStore = defineStore('workspaces', {
  state: (): WorkspacesState => ({
    workspaces: [],
    activeWorkspaceProfiles: [],
    loading: false,
    pendingExpenseLimitWrites: new Set(),
    pendingBudgetCardBasisWrites: new Set()
  }),
  getters: {
    activeWorkspace(state): Workspace | undefined {
      const workspaceId = useAuthStore().activeWorkspaceId
      return state.workspaces.find(w => w.id === workspaceId)
    },
    // Shared by every member and budget surface; absent or invalid counts consumption.
    activeBudgetCardBasis(): BudgetBasis {
      return parseBudgetBasis(this.activeWorkspace?.budgetCardBasis)
    },
    isActiveWorkspaceOwner(): boolean {
      const uid = useAuthStore().user?.uid
      return Boolean(uid && this.activeWorkspace?.ownerId === uid)
    }
  },
  actions: {
    async fetchMyWorkspaces() {
      const user = auth.currentUser
      if (!user) return

      this.loading = true
      try {
        const q = query(collection(db, 'workspaces'), where('members', 'array-contains', user.uid))
        const snap = await getDocs(q)
        const list: Workspace[] = []
        snap.forEach(docSnap => {
          list.push({ id: docSnap.id, ...docSnap.data() } as Workspace)
        })
        this.workspaces = list
      } catch (err) {
        console.error("Error fetching workspaces:", err)
      } finally {
        this.loading = false
      }
    },
    
    async fetchActiveWorkspaceProfiles() {
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!workspaceId) return

      const workspace = this.workspaces.find(w => w.id === workspaceId)
      if (!workspace || !workspace.members) return

      this.loading = true
      try {
        const profiles: UserProfile[] = []
        for (const uid of workspace.members) {
          const userDoc = await getDoc(doc(db, 'users', uid))
          if (userDoc.exists()) {
            profiles.push(userDoc.data() as UserProfile)
          }
        }
        this.activeWorkspaceProfiles = profiles
      } catch (err) {
        console.error("Error fetching workspace members profiles:", err)
      } finally {
        this.loading = false
      }
    },
    
    async createWorkspace(name: string) {
      const user = auth.currentUser
      if (!user) return

      this.loading = true
      try {
        const newRef = doc(collection(db, 'workspaces'))
        const workspaceId = newRef.id
        
        const newWorkspace: Workspace = {
          id: workspaceId,
          name,
          ownerId: user.uid,
          members: [user.uid],
          currency: 'USD',
          createdAt: new Date().toISOString()
        }
        await setDoc(newRef, newWorkspace)
        
        this.workspaces.push(newWorkspace)
        
        // Actualizar array de workspaces en el authStore profile
        const authStore = useAuthStore()
        if (authStore.profile) {
          const updatedWorkspaces = [...(authStore.profile.workspaces || []), workspaceId]
          authStore.profile.workspaces = updatedWorkspaces
          await updateDoc(doc(db, 'users', user.uid), {
            workspaces: updatedWorkspaces
          })
          
          // Automáticamente cambiar a este workspace
          await authStore.switchWorkspace(workspaceId)
        }
        
        return workspaceId
      } catch (err) {
        console.error("Error creating workspace", err)
        throw err
      } finally {
        this.loading = false
      }
    },

    // Resolves with the server message; it never reveals whether the email is registered.
    async inviteUser(workspaceId: string, email: string): Promise<string> {
      const user = auth.currentUser
      if (!user) throw new Error("No autenticado")

      this.loading = true
      try {
        const token = await user.getIdToken()
        const url = getFunctionUrl('inviteToWorkspace')
        
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ workspaceId, email })
        })
        
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(data.error || "Error invitando usuario")
        }

        await this.fetchMyWorkspaces()
        return data.message || "Invitación procesada."
      } catch (err) {
        console.error("Error invitando", err)
        throw err
      } finally {
        this.loading = false
      }
    },
    
    // Actualiza o limpia (0) el límite mensual de gastos del workspace.
    async updateWorkspaceLimit(workspaceId: string, limit: number) {
      const normalized = Number(limit)
      if (!Number.isFinite(normalized) || normalized < 0) {
        throw new Error('El límite de gastos debe ser un número mayor o igual a 0.')
      }
      // Keep the claim across route changes; other workspaces can still save.
      if (this.pendingExpenseLimitWrites.has(workspaceId)) {
        throw new Error('Ya se está guardando el tope de este espacio de trabajo.')
      }
      this.pendingExpenseLimitWrites.add(workspaceId)
      try {
        await updateDoc(doc(db, 'workspaces', workspaceId), { expenseLimit: normalized })
        const ws = this.workspaces.find(w => w.id === workspaceId)
        if (ws) ws.expenseLimit = normalized
      } finally {
        this.pendingExpenseLimitWrites.delete(workspaceId)
      }
    },

    // Only the owner changes how budgets count card expenses for every member (rules enforce it too).
    async updateBudgetCardBasis(workspaceId: string, basis: BudgetBasis) {
      if (basis !== 'consumption' && basis !== 'payment') {
        throw new Error('Elige Consumo del mes o Pagos del mes.')
      }
      const uid = useAuthStore().user?.uid
      if (!uid || this.workspaces.find(w => w.id === workspaceId)?.ownerId !== uid) {
        throw new Error('Solo el dueño del espacio de trabajo puede cambiar cómo se cuentan las tarjetas.')
      }
      if (this.pendingBudgetCardBasisWrites.has(workspaceId)) {
        throw new Error('Ya se está guardando cómo se cuentan las tarjetas en este espacio de trabajo.')
      }
      this.pendingBudgetCardBasisWrites.add(workspaceId)
      try {
        await updateDoc(doc(db, 'workspaces', workspaceId), { budgetCardBasis: basis })
        const ws = this.workspaces.find(w => w.id === workspaceId)
        if (ws) ws.budgetCardBasis = basis
      } finally {
        this.pendingBudgetCardBasisWrites.delete(workspaceId)
      }
    }
  }
})
