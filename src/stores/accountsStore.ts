import { defineStore } from 'pinia'
import { db, auth } from '@/lib/firebase'
import { Account, AccountType, AccountMirror } from '@/types'
import { useAuthStore } from '@/stores/authStore'
import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  doc,
  deleteDoc,
  updateDoc,
  runTransaction
} from 'firebase/firestore'

interface AccountsState {
  accounts: Account[];
  loading: boolean;
}

export const useAccountsStore = defineStore('accounts', {
  state: (): AccountsState => ({
    accounts: [],
    loading: false,
  }),
  getters: {
    getAccountById: (state) => (id: string): Account | undefined => state.accounts.find(acc => acc.id === id),
    // Patrimonio neto agrupado por tipo de moneda
    netWorthByCurrency: (state): Record<string, number> => {
      const totals: Record<string, number> = {}
      state.accounts.forEach(acc => {
        const currency = acc.currency || 'USD'
        if (!totals[currency]) totals[currency] = 0
        totals[currency] += acc.balance
      });
      return totals
    }
  },
  actions: {
    // Obtener todas las cuentas del usuario
    async fetchAccounts(): Promise<void> {
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!workspaceId) return

      this.loading = true
      try {
        const q = query(collection(db, 'accounts'), where('workspaceId', '==', workspaceId))
        const querySnapshot = await getDocs(q)
        const accountsList: Account[] = []
        querySnapshot.forEach((docSnap) => {
          const data = docSnap.data()
          accountsList.push({ 
            id: docSnap.id, 
            ...data,
            createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt)
          } as Account)
        })
        this.accounts = accountsList
      } catch (error) {
        console.error('Error fetching accounts:', error)
      } finally {
        this.loading = false
      }
    },

    // Agregar una nueva cuenta
    async addAccount({ name, type, balance, limit = 0, currency = 'USD', statementClosingDay = null, paymentDueDay = null }: {
      name: string; 
      type: AccountType; 
      balance: number; 
      limit?: number; 
      currency?: string; 
      statementClosingDay?: number | null;
      paymentDueDay?: number | null;
    }): Promise<Account> {
      const user = auth.currentUser
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!user || !workspaceId) throw new Error('Usuario o Workspace no inicializado')

      this.loading = true
      try {
        const newAccount = {
          workspaceId,
          userId: user.uid,
          name,
          type,
          balance: Number(balance),
          limit: type === 'credit' ? Number(limit) : 0,
          currency,
          statementClosingDay: type === 'credit' ? statementClosingDay : null,
          paymentDueDay: type === 'credit' ? paymentDueDay : null,
          createdAt: new Date()
        }

        const docRef = await addDoc(collection(db, 'accounts'), newAccount)
        const accountWithId: Account = { id: docRef.id, ...newAccount }
        this.accounts.push(accountWithId)
        return accountWithId
      } catch (error) {
        console.error('Error adding account:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // Editar cuenta (balance NO editable: lo mutan las transacciones)
    async updateAccount(accountId: string, updates: {
      name: string;
      type: AccountType;
      limit: number;
      currency: string;
      statementClosingDay?: number | null;
      paymentDueDay?: number | null;
    }): Promise<void> {
      this.loading = true
      try {
        const fields = {
          name: updates.name,
          type: updates.type,
          limit: updates.type === 'credit' ? Number(updates.limit) : 0,
          currency: updates.currency,
          statementClosingDay: updates.type === 'credit' ? updates.statementClosingDay ?? null : null,
          paymentDueDay: updates.type === 'credit' ? updates.paymentDueDay ?? null : null
        }
        await updateDoc(doc(db, 'accounts', accountId), fields)
        const index = this.accounts.findIndex(acc => acc.id === accountId)
        if (index !== -1) {
          this.accounts[index] = { ...this.accounts[index], ...fields }
        }
      } catch (error) {
        console.error('Error updating account:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // Cuentas de otro workspace del usuario (para configurar/leer el espejo).
    // No toca el estado: el store solo mantiene el workspace activo.
    async fetchAccountsByWorkspace(workspaceId: string): Promise<Account[]> {
      const q = query(collection(db, 'accounts'), where('workspaceId', '==', workspaceId))
      const snap = await getDocs(q)
      return snap.docs.map(docSnap => {
        const data = docSnap.data()
        return {
          id: docSnap.id,
          ...data,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt)
        } as Account
      })
    },

    // Configurar (o quitar con null) el espejo de una cuenta puente
    async setAccountMirror(accountId: string, mirror: AccountMirror | null): Promise<void> {
      this.loading = true
      try {
        await updateDoc(doc(db, 'accounts', accountId), { mirror })
        const index = this.accounts.findIndex(acc => acc.id === accountId)
        if (index !== -1) this.accounts[index] = { ...this.accounts[index], mirror }
      } catch (error) {
        console.error('Error updating account mirror:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // Eliminar cuenta
    async deleteAccount(accountId: string): Promise<void> {
      const account = this.accounts.find(acc => acc.id === accountId)
      // El espejo vive en otro workspace: borrar el puente dejaría allá un saldo
      // por cobrar sin contrapartida y sin forma de liquidarlo desde la UI.
      if (account?.mirror) {
        throw new Error('Esta cuenta tiene un espejo activo. Liquida el saldo pendiente y quita el espejo antes de borrarla.')
      }

      this.loading = true
      try {
        await deleteDoc(doc(db, 'accounts', accountId))
        this.accounts = this.accounts.filter(acc => acc.id !== accountId)
      } catch (error) {
        console.error('Error deleting account:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // Modificar saldo de cuenta (al agregar/eliminar transacciones)
    async updateAccountBalance(accountId: string, amountChange: number): Promise<void> {
      const accountRef = doc(db, 'accounts', accountId)
      
      try {
        await runTransaction(db, async (transaction) => {
          const sfDoc = await transaction.get(accountRef)
          if (!sfDoc.exists()) {
            throw new Error("La cuenta no existe!")
          }

          const newBalance = Number(sfDoc.data().balance) + Number(amountChange)
          transaction.update(accountRef, { balance: newBalance })
        })

        // Actualizar estado local
        const index = this.accounts.findIndex(acc => acc.id === accountId)
        if (index !== -1) {
          this.accounts[index].balance += Number(amountChange)
        }
      } catch (error) {
        console.error("Error al actualizar balance de la cuenta:", error)
        throw error
      }
    }
  }
})
