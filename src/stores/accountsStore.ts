import { defineStore } from 'pinia'
import { db, auth } from '@/lib/firebase'
import { Account, AccountType, AccountMirror } from '@/types'
import { PocketOpeningSchema } from '@/schemas'
import { planPocketOpening } from '@/lib/pockets'
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
  runTransaction,
  getDoc,
  Timestamp,
  increment
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
      const userId = auth.currentUser?.uid
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
        if (authStore.activeWorkspaceId === workspaceId && auth.currentUser?.uid === userId) {
          this.accounts = accountsList
        }
      } catch (error) {
        console.error('Error fetching accounts:', error)
      } finally {
        this.loading = false
      }
    },

    // Agregar una nueva cuenta
    async addAccount({ name, type, balance, limit = 0, currency = 'USD', statementClosingDay = null, paymentDueDay = null, parentAccountId = null }: {
      name: string; 
      type: AccountType; 
      balance: number; 
      limit?: number; 
      currency?: string; 
      statementClosingDay?: number | null;
      paymentDueDay?: number | null;
      parentAccountId?: string | null;
    }): Promise<Account> {
      const user = auth.currentUser
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!user || !workspaceId) throw new Error('Usuario o Workspace no inicializado')

      if (parentAccountId) {
        if (type !== 'savings' || Number(limit) !== 0 || statementClosingDay != null || paymentDueDay != null) {
          throw new Error('Un bolsillo debe ser una cuenta de ahorros sin metadatos de crédito.')
        }
        return this.addPocket({ name, balance, currency, parentAccountId })
      }

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
        if (authStore.activeWorkspaceId === workspaceId && auth.currentUser?.uid === user.uid) {
          this.accounts.push(accountWithId)
        }
        return accountWithId
      } catch (error) {
        console.error('Error adding account:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    async addPocket({ name, balance, currency, parentAccountId }: {
      name: string;
      balance: number;
      currency?: string;
      parentAccountId: string;
    }): Promise<Account> {
      const userId = auth.currentUser?.uid
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!userId || !workspaceId) throw new Error('Usuario o Workspace no inicializado')

      const parsed = PocketOpeningSchema.safeParse({ name, parentAccountId, balance, currency })
      if (!parsed.success) throw new Error(parsed.error.errors[0]?.message || 'Datos del bolsillo inválidos.')

      const parentRef = doc(db, 'accounts', parentAccountId)
      const workspaceRef = doc(db, 'workspaces', workspaceId)
      const pocketRef = doc(collection(db, 'accounts'))
      const amount = parsed.data.balance
      const openingRef = amount > 0 ? doc(collection(db, 'transactions')) : null
      this.loading = true

      try {
        // Web transactions can read documents, not arbitrary queries. Read all
        // actual direct children first, then pin the registry value
        // inside the transaction so a concurrent hierarchy change fails closed.
        const childrenQuery = query(
          collection(db, 'accounts'),
          where('workspaceId', '==', workspaceId),
          where('parentAccountId', '==', parentAccountId)
        )
        const queriedChildren = await getDocs(childrenQuery)
        const queriedChildIds = queriedChildren.docs.map(child => child.id).sort()
        const result = await runTransaction(db, async transaction => {
          const [workspaceSnap, parentSnap] = await Promise.all([
            transaction.get(workspaceRef),
            transaction.get(parentRef)
          ])
          if (!workspaceSnap.exists() || !workspaceSnap.data().members?.includes(userId)) {
            throw new Error('El usuario no pertenece al workspace activo.')
          }
          if (!parentSnap.exists()) throw new Error('La cuenta principal no existe.')

          const parentData = parentSnap.data() as Account
          // Pocket movements cannot carry a budget, so a linked account cannot get pockets.
          if (parentData.linkedBudgetId) {
            throw new Error('Esta cuenta está ligada a un presupuesto: quítala del presupuesto antes de crearle bolsillos.')
          }
          const registeredChildIds = parentData.childAccountIds === undefined ? [] : parentData.childAccountIds
          if (!Array.isArray(registeredChildIds) || registeredChildIds.some(id => typeof id !== 'string')) {
            throw new Error('El registro de bolsillos de la cuenta principal no es válido.')
          }
          const existingChildSnaps = await Promise.all(
            registeredChildIds.map(id => transaction.get(doc(db, 'accounts', id)))
          )
          const actualChildIds = existingChildSnaps.filter(snapshot => snapshot.exists()).map(snapshot => snapshot.id).sort()
          if (actualChildIds.length !== registeredChildIds.length ||
              [...registeredChildIds].sort().join('|') !== queriedChildIds.join('|') ||
              actualChildIds.join('|') !== queriedChildIds.join('|')) {
            throw new Error('El registro de bolsillos no coincide con las cuentas hijas existentes.')
          }
          for (const childSnap of existingChildSnaps) {
            const child = childSnap.data() as Account
            if (!childSnap.exists() || child.parentAccountId !== parentAccountId ||
                child.workspaceId !== workspaceId || child.currency !== parentData.currency || child.type !== 'savings') {
              throw new Error('El registro contiene un bolsillo inválido.')
            }
          }
          const plan = planPocketOpening(parentData, amount, workspaceId, currency)
          const childIds = [...registeredChildIds, pocketRef.id]
          const createdAt = new Date()
          const pocket: Account = {
            id: pocketRef.id,
            workspaceId,
            userId,
            name: parsed.data.name,
            type: 'savings',
            balance: plan.pocketBalance,
            limit: 0,
            currency: parentData.currency,
            statementClosingDay: null,
            paymentDueDay: null,
            parentAccountId,
            childAccountIds: [],
            pocketActivity: amount > 0,
            openingAllocationId: openingRef?.id ?? null,
            createdAt
          }

          transaction.update(parentRef, {
            balance: increment(-amount),
            childAccountIds: childIds,
            lastPocketChildId: pocketRef.id,
            lastPocketChange: 'created'
          })
          transaction.set(pocketRef, {
            workspaceId,
            userId,
            name: pocket.name,
            type: pocket.type,
            balance: pocket.balance,
            limit: pocket.limit,
            currency: pocket.currency,
            statementClosingDay: pocket.statementClosingDay,
            paymentDueDay: pocket.paymentDueDay,
            parentAccountId,
            childAccountIds: [],
            pocketActivity: pocket.pocketActivity,
            openingAllocationId: pocket.openingAllocationId,
            createdAt
          })
          if (openingRef) {
            const date = Timestamp.fromDate(createdAt)
            transaction.set(openingRef, {
              workspaceId,
              userId,
              accountId: parentAccountId,
              amount,
              description: `Asignación inicial a bolsillo: ${pocket.name}`,
              categoryId: '',
              date,
              type: 'transfer',
              toAccountId: pocketRef.id,
              receiptUrl: null,
              notes: null,
              installments: 1,
              currency: parentData.currency,
              pocketAllocation: true,
              createdAt: date
            })
          }
          return {
            pocket,
            parentBalanceAfter: plan.parentBalanceAfter,
            parentChildAccountIds: childIds
          }
        })

        if (authStore.activeWorkspaceId === workspaceId && auth.currentUser?.uid === userId) {
          const parentIndex = this.accounts.findIndex(account => account.id === parentAccountId)
          if (parentIndex !== -1) {
            this.accounts[parentIndex] = {
              ...this.accounts[parentIndex],
              balance: result.parentBalanceAfter,
              childAccountIds: result.parentChildAccountIds
            }
          }
          this.accounts.push(result.pocket)
        }
        return result.pocket
      } catch (error) {
        console.error('Error creating pocket:', error)
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
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      const userId = auth.currentUser?.uid
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
        if (authStore.activeWorkspaceId === workspaceId && auth.currentUser?.uid === userId) {
          const index = this.accounts.findIndex(acc => acc.id === accountId)
          if (index !== -1) {
            this.accounts[index] = { ...this.accounts[index], ...fields }
          }
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
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      const userId = auth.currentUser?.uid
      this.loading = true
      try {
        const accountRef = doc(db, 'accounts', accountId)
        await runTransaction(db, async (transaction) => {
          const accountSnap = await transaction.get(accountRef)
          if (!accountSnap.exists()) throw new Error('La cuenta no existe')

          if (mirror !== null && accountSnap.data().linkedBudgetId) {
            throw new Error('Esta cuenta está ligada a un presupuesto: quítala del presupuesto antes de convertirla en cuenta puente.')
          }
          if (mirror === null && Number(accountSnap.data().balance) !== 0) {
            throw new Error('No puedes quitar el espejo mientras la cuenta tenga saldo distinto de cero. Liquida la deuda antes de quitarlo.')
          }

          transaction.update(accountRef, { mirror })
        })
        if (authStore.activeWorkspaceId === workspaceId && auth.currentUser?.uid === userId) {
          const index = this.accounts.findIndex(acc => acc.id === accountId)
          if (index !== -1) this.accounts[index] = { ...this.accounts[index], mirror }
        }
      } catch (error) {
        console.error('Error updating account mirror:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // Eliminar cuenta
    async deleteAccount(accountId: string): Promise<void> {
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      const userId = auth.currentUser?.uid
      const accountRef = doc(db, 'accounts', accountId)
      const accountSnap = await getDoc(accountRef)
      if (!accountSnap.exists()) throw new Error('La cuenta no existe.')
      const account = { id: accountSnap.id, ...accountSnap.data() } as Account
      // El espejo vive en otro workspace: borrar el puente dejaría allá un saldo
      // por cobrar sin contrapartida y sin forma de liquidarlo desde la UI.
      if (account?.mirror) {
        throw new Error('Esta cuenta tiene un espejo activo. Liquida el saldo pendiente y quita el espejo antes de borrarla.')
      }

      if (account.parentAccountId) {
        if (account.workspaceId !== workspaceId) throw new Error('El bolsillo pertenece a otro workspace.')
        return this.deleteEmptyPocket(accountId, account, workspaceId, userId)
      }
      if ((account.childAccountIds?.length || 0) > 0) {
        throw new Error('Elimina primero los bolsillos vacíos de esta cuenta principal.')
      }

      this.loading = true
      try {
        await deleteDoc(accountRef)
        if (authStore.activeWorkspaceId === workspaceId && auth.currentUser?.uid === userId) {
          this.accounts = this.accounts.filter(acc => acc.id !== accountId)
        }
      } catch (error) {
        console.error('Error deleting account:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    async deleteEmptyPocket(accountId: string, account: Account, workspaceId: string, userId: string | undefined): Promise<void> {
      if (!userId) throw new Error('Usuario no autenticado.')
      const parentAccountId = account.parentAccountId
      if (!parentAccountId) throw new Error('La relación del bolsillo no es válida.')
      const parentRef = doc(db, 'accounts', parentAccountId)
      const pocketRef = doc(db, 'accounts', accountId)
      const workspaceRef = doc(db, 'workspaces', workspaceId)
      const childrenQuery = query(
        collection(db, 'accounts'),
        where('workspaceId', '==', workspaceId),
        where('parentAccountId', '==', parentAccountId)
      )
      const queriedChildren = await getDocs(childrenQuery)
      const queriedChildIds = queriedChildren.docs.map(child => child.id).sort()
      this.loading = true
      try {
        await runTransaction(db, async transaction => {
          const [workspaceSnap, pocketSnap, parentSnap] = await Promise.all([
            transaction.get(workspaceRef),
            transaction.get(pocketRef),
            transaction.get(parentRef)
          ])
          if (!workspaceSnap.exists() || !workspaceSnap.data().members?.includes(userId)) {
            throw new Error('El usuario no pertenece al workspace activo.')
          }
          if (!pocketSnap.exists() || !parentSnap.exists()) throw new Error('No se encontró la relación del bolsillo.')
          const livePocket = pocketSnap.data()
          const parent = parentSnap.data()
          const childIds = parent.childAccountIds === undefined ? [] : parent.childAccountIds
          if (!Array.isArray(childIds) || childIds.some(id => typeof id !== 'string') ||
              new Set(childIds).size !== childIds.length) {
            throw new Error('El registro de bolsillos de la cuenta principal no es válido.')
          }
          const existingChildren = await Promise.all(childIds.map(id => transaction.get(doc(db, 'accounts', id))))
          const actualIds = existingChildren.filter(snapshot => snapshot.exists()).map(snapshot => snapshot.id).sort()
          if (actualIds.join('|') !== queriedChildIds.join('|') ||
              [...childIds].sort().join('|') !== queriedChildIds.join('|')) {
            throw new Error('El registro de bolsillos no coincide con las cuentas hijas existentes.')
          }
          if (livePocket.parentAccountId !== parentAccountId || livePocket.workspaceId !== workspaceId ||
              livePocket.currency !== parent.currency || livePocket.balance !== 0 ||
              livePocket.pocketActivity !== false || livePocket.openingAllocationId !== null ||
              !childIds.includes(accountId)) {
            throw new Error('Solo se puede eliminar un bolsillo vacío que nunca haya tenido actividad.')
          }
          const remainingIds = childIds.filter(id => id !== accountId)
          transaction.update(parentRef, {
            childAccountIds: remainingIds,
            lastPocketChildId: accountId,
            lastPocketChange: 'deleted'
          })
          transaction.delete(pocketRef)
        })
        const authStore = useAuthStore()
        if (authStore.activeWorkspaceId === workspaceId && auth.currentUser?.uid === userId) {
          this.accounts = this.accounts.filter(existing => existing.id !== accountId)
        }
      } finally {
        this.loading = false
      }
    },

    // Modificar saldo de cuenta (al agregar/eliminar transacciones)
    async updateAccountBalance(accountId: string, amountChange: number): Promise<void> {
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      const userId = auth.currentUser?.uid
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
        if (authStore.activeWorkspaceId === workspaceId && auth.currentUser?.uid === userId) {
          const index = this.accounts.findIndex(acc => acc.id === accountId)
          if (index !== -1) {
            this.accounts[index].balance += Number(amountChange)
          }
        }
      } catch (error) {
        console.error("Error al actualizar balance de la cuenta:", error)
        throw error
      }
    }
  }
})
