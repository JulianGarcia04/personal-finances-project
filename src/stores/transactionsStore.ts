import { defineStore } from 'pinia'
import { db, auth, storage } from '@/lib/firebase'
import { useAccountsStore } from './accountsStore'
import { useAuthStore } from './authStore'
import { Transaction, Category, TransactionType } from '@/types'
import { 
  collection, 
  query, 
  where, 
  orderBy, 
  getDocs, 
  addDoc, 
  doc, 
  updateDoc,
  deleteDoc, 
  writeBatch,
  Timestamp
} from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'

// Categorías por defecto iniciales
const DEFAULT_CATEGORIES = [
  { name: 'Comida', icon: 'Utensils', color: '#10b981', type: 'expense' },
  { name: 'Transporte', icon: 'Car', color: '#3b82f6', type: 'expense' },
  { name: 'Entretenimiento', icon: 'Film', color: '#f43f5e', type: 'expense' },
  { name: 'Servicios', icon: 'Lightbulb', color: '#fbbf24', type: 'expense' },
  { name: 'Salud', icon: 'Heart', color: '#ec4899', type: 'expense' },
  { name: 'Educación', icon: 'GraduationCap', color: '#8b5cf6', type: 'expense' },
  { name: 'Ingresos', icon: 'TrendingUp', color: '#059669', type: 'income' },
  { name: 'Otros', icon: 'HelpCircle', color: '#6b7280', type: 'both' }
]

interface TransactionsState {
  transactions: Transaction[];
  categories: Category[];
  loading: boolean;
}

export const useTransactionsStore = defineStore('transactions', {
  state: (): TransactionsState => ({
    transactions: [],
    categories: [],
    loading: false,
  }),
  getters: {
    // Filtrar transacciones locales
    filteredTransactions: (state) => (filters: { 
      accountId?: string; 
      categoryId?: string; 
      type?: string; 
      search?: string; 
    } = {}) => {
      let list = [...state.transactions]
      
      if (filters.accountId) {
        list = list.filter(t => t.accountId === filters.accountId)
      }
      if (filters.categoryId) {
        list = list.filter(t => t.categoryId === filters.categoryId)
      }
      if (filters.type) {
        list = list.filter(t => t.type === filters.type)
      }
      if (filters.search) {
        const term = filters.search.toLowerCase()
        list = list.filter(t => t.description.toLowerCase().includes(term))
      }
      
      return list
    }
  },
  actions: {
    // 1. Cargar Categorías (e inicializar por defecto si están vacías)
    async fetchCategories(): Promise<void> {
      const user = auth.currentUser
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!user || !workspaceId) return

      this.loading = true
      try {
        const q = query(
          collection(db, 'categories'), 
          where('workspaceId', '==', workspaceId)
        )
        const snapshot = await getDocs(q)
        const categoriesList: Category[] = []
        snapshot.forEach(docSnap => {
          categoriesList.push({ id: docSnap.id, ...docSnap.data() } as Category)
        })

        // Si no existen categorías personalizadas ni globales asociadas al workspace, inicializamos las por defecto
        const workspaceHasCategories = categoriesList.some(cat => cat.workspaceId === workspaceId)
        if (categoriesList.length === 0 || !workspaceHasCategories) {
          await this.initDefaultCategories()
        } else {
          this.categories = categoriesList
        }
      } catch (error) {
        console.error('Error al cargar categorías:', error)
      } finally {
        this.loading = false
      }
    },

    // Guardar las categorías iniciales en la base de datos
    async initDefaultCategories(): Promise<void> {
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!workspaceId) return

      const batch = writeBatch(db)
      const newCats: Category[] = []

      DEFAULT_CATEGORIES.forEach(cat => {
        const docRef = doc(collection(db, 'categories'))
        const catData = {
          ...cat,
          workspaceId,
          createdAt: new Date()
        }
        batch.set(docRef, catData)
        newCats.push({ id: docRef.id, ...catData } as Category)
      })

      await batch.commit()
      this.categories = newCats
    },

    // 2. Cargar Transacciones
    async fetchTransactions(): Promise<void> {
      const user = auth.currentUser
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!user || !workspaceId) return

      this.loading = true
      try {
        const q = query(
          collection(db, 'transactions'), 
          where('workspaceId', '==', workspaceId),
          orderBy('date', 'desc')
        )
        const snapshot = await getDocs(q)
        const transactionsList: Transaction[] = []
        snapshot.forEach(docSnap => {
          const data = docSnap.data()
          transactionsList.push({ 
            id: docSnap.id, 
            ...data,
            // Convertir timestamp de Firestore a Date
            date: data.date instanceof Timestamp ? data.date.toDate() : new Date(data.date),
            createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : new Date(data.createdAt)
          } as Transaction)
        })
        this.transactions = transactionsList
      } catch (error) {
        console.error('Error fetching transactions:', error)
      } finally {
        this.loading = false
      }
    },

    // uploadReceipt action
    async uploadReceipt(file: File): Promise<string> {
      const user = auth.currentUser
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!user || !workspaceId) throw new Error('Usuario o Workspace no inicializado')

      const fileExtension = file.name.split('.').pop()
      const uniqueName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${fileExtension}`
      const fileRef = storageRef(storage, `workspaces/${workspaceId}/receipts/${uniqueName}`)

      await uploadBytes(fileRef, file)
      const downloadUrl = await getDownloadURL(fileRef)
      return downloadUrl
    },

    // 3. Crear una nueva Transacción
    async addTransaction({ accountId, amount, description, categoryId, date, type, toAccountId = null, receiptUrl = null, userId }: {
      accountId: string;
      amount: number;
      description: string;
      categoryId: string;
      date: Date;
      type: TransactionType;
      toAccountId?: string | null;
      receiptUrl?: string | null;
      userId?: string;
    }): Promise<Transaction> {
      const user = auth.currentUser
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!user || !workspaceId) throw new Error('Usuario o Workspace no inicializado')

      const accountsStore = useAccountsStore()
      const account = accountsStore.getAccountById(accountId)
      if (!account) throw new Error('Cuenta origen no encontrada')

      this.loading = true
      try {
        const transactionDate = date instanceof Date ? date : new Date(date)
        const newTx = {
          workspaceId,
          userId: userId || user.uid,
          accountId,
          amount: Number(amount),
          description,
          categoryId,
          date: Timestamp.fromDate(transactionDate),
          type,
          toAccountId,
          receiptUrl,
          currency: account.currency || 'USD',
          createdAt: new Date()
        }

        // 1. Guardar la transacción en Firestore
        const docRef = await addDoc(collection(db, 'transactions'), newTx)
        const txWithId: Transaction = { 
          id: docRef.id, 
          ...newTx, 
          date: transactionDate 
        }

        // 2. Actualizar balances de las cuentas asociadas
        if (type === 'transfer' && toAccountId) {
          await accountsStore.updateAccountBalance(accountId, -amount)
          await accountsStore.updateAccountBalance(toAccountId, amount)
        } else {
          await accountsStore.updateAccountBalance(accountId, amount)
        }

        this.transactions.unshift(txWithId)
        this.transactions.sort((a, b) => b.date.getTime() - a.date.getTime())

        return txWithId
      } catch (error) {
        console.error('Error al registrar transacción:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // 4. Eliminar Transacción
    async deleteTransaction(transactionId: string): Promise<void> {
      const tx = this.transactions.find(t => t.id === transactionId)
      if (!tx) return

      const accountsStore = useAccountsStore()
      this.loading = true
      try {
        // 1. Eliminar de Firestore
        await deleteDoc(doc(db, 'transactions', transactionId))

        // 1b. Eliminar de Storage si tiene comprobante
        if (tx.receiptUrl) {
          try {
            const storageFileRef = storageRef(storage, tx.receiptUrl)
            await deleteObject(storageFileRef)
          } catch (storageErr) {
            console.warn('No se pudo borrar el comprobante de Storage:', storageErr)
          }
        }

        // 2. Revertir balances de las cuentas
        if (tx.type === 'transfer' && tx.toAccountId) {
          await accountsStore.updateAccountBalance(tx.accountId, tx.amount)
          await accountsStore.updateAccountBalance(tx.toAccountId, -tx.amount)
        } else {
          await accountsStore.updateAccountBalance(tx.accountId, -tx.amount)
        }

        this.transactions = this.transactions.filter(t => t.id !== transactionId)
      } catch (error) {
        console.error('Error al borrar transacción:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // 5. Guardar un lote de transacciones importadas de extracto
    async addTransactionsBatch(accountId: string, rawTxsList: Array<{
      date: string;
      description: string;
      amount: number;
      categorySuggestion: string;
    }>): Promise<Transaction[]> {
      const user = auth.currentUser
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!user || !workspaceId) throw new Error('Usuario o Workspace no inicializado')

      const accountsStore = useAccountsStore()
      const account = accountsStore.getAccountById(accountId)
      if (!account) throw new Error('Cuenta no encontrada')

      this.loading = true
      const batch = writeBatch(db)
      const addedLocalTxs: Transaction[] = []
      let totalAmountChange = 0

      try {
        rawTxsList.forEach(tx => {
          const docRef = doc(collection(db, 'transactions'))
          const txDate = new Date(tx.date)
          
          let categoryId = ''
          const matchedCategory = this.categories.find(c => 
            c.name.toLowerCase() === tx.categorySuggestion.toLowerCase()
          )
          if (matchedCategory) {
            categoryId = matchedCategory.id
          } else {
            const otherCat = this.categories.find(c => c.name === 'Otros')
            categoryId = otherCat ? otherCat.id : ''
          }

          const txAmount = Number(tx.amount)
          totalAmountChange += txAmount

          const txData = {
            workspaceId,
            userId: user.uid,
            accountId,
            amount: txAmount,
            description: tx.description,
            categoryId,
            date: Timestamp.fromDate(txDate),
            type: txAmount >= 0 ? 'income' as TransactionType : 'expense' as TransactionType,
            toAccountId: null,
            currency: account.currency || 'USD',
            createdAt: new Date()
          }

          batch.set(docRef, txData)
          addedLocalTxs.push({
            id: docRef.id,
            ...txData,
            date: txDate
          })
        })

        // Ejecutar en Firestore
        await batch.commit()

        // Actualizar balance
        await accountsStore.updateAccountBalance(accountId, totalAmountChange)

        this.transactions = [...addedLocalTxs, ...this.transactions]
        this.transactions.sort((a, b) => b.date.getTime() - a.date.getTime())

        return addedLocalTxs
      } catch (error) {
        console.error('Error al importar lote de transacciones:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // 6. Editar / Actualizar Transacción
    async updateTransaction(transactionId: string, updates: {
      accountId: string;
      amount: number;
      description: string;
      categoryId: string;
      date: Date;
      type: TransactionType;
      toAccountId?: string | null;
      receiptUrl?: string | null;
      userId?: string;
    }): Promise<Transaction> {
      const user = auth.currentUser
      if (!user) throw new Error('Usuario no autenticado')

      const accountsStore = useAccountsStore()
      const txIndex = this.transactions.findIndex(t => t.id === transactionId)
      if (txIndex === -1) throw new Error('Transacción no encontrada en el estado local')
      const oldTx = this.transactions[txIndex]

      this.loading = true
      try {
        const transactionDate = updates.date instanceof Date ? updates.date : new Date(updates.date)
        const account = accountsStore.getAccountById(updates.accountId)
        if (!account) throw new Error('Cuenta origen no encontrada')

        // 1. Revertir balances de las cuentas antiguas
        if (oldTx.type === 'transfer' && oldTx.toAccountId) {
          await accountsStore.updateAccountBalance(oldTx.accountId, oldTx.amount)
          await accountsStore.updateAccountBalance(oldTx.toAccountId, -oldTx.amount)
        } else {
          await accountsStore.updateAccountBalance(oldTx.accountId, -oldTx.amount)
        }

        // 2. Aplicar balances de las cuentas nuevas
        const newAmount = Number(updates.amount)
        if (updates.type === 'transfer' && updates.toAccountId) {
          await accountsStore.updateAccountBalance(updates.accountId, -newAmount)
          await accountsStore.updateAccountBalance(updates.toAccountId, newAmount)
        } else {
          await accountsStore.updateAccountBalance(updates.accountId, newAmount)
        }

        // 3. Preparar documento de actualización
        const updatedFields = {
          accountId: updates.accountId,
          amount: newAmount,
          description: updates.description,
          categoryId: updates.type === 'transfer' ? '' : updates.categoryId,
          date: Timestamp.fromDate(transactionDate),
          type: updates.type,
          toAccountId: updates.type === 'transfer' ? updates.toAccountId : null,
          receiptUrl: updates.receiptUrl,
          userId: updates.userId || oldTx.userId,
          currency: account.currency || 'USD',
        }

        // 4. Actualizar en Firestore
        const docRef = doc(db, 'transactions', transactionId)
        await updateDoc(docRef, updatedFields)

        // 5. Actualizar en el estado local
        const updatedTx: Transaction = {
          ...oldTx,
          ...updatedFields,
          date: transactionDate
        }

        this.transactions[txIndex] = updatedTx
        this.transactions.sort((a, b) => b.date.getTime() - a.date.getTime())

        return updatedTx
      } catch (error) {
        console.error('Error al actualizar transacción:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // 7. Crear una nueva Categoría
    async addCategory({ name, icon, color, type }: {
      name: string;
      icon: string;
      color: string;
      type: 'income' | 'expense' | 'both';
    }): Promise<Category> {
      const user = auth.currentUser
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!user || !workspaceId) throw new Error('Usuario o Workspace no inicializado')

      this.loading = true
      try {
        const newCat = {
          workspaceId,
          userId: user.uid,
          name,
          icon,
          color,
          type,
          createdAt: new Date()
        }

        const docRef = await addDoc(collection(db, 'categories'), newCat)
        const catWithId: Category = {
          id: docRef.id,
          ...newCat
        }

        this.categories.push(catWithId)
        return catWithId
      } catch (error) {
        console.error('Error al crear categoría:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // 8. Eliminar Categoría
    async deleteCategory(categoryId: string): Promise<void> {
      const user = auth.currentUser
      if (!user) throw new Error('Usuario no autenticado')

      this.loading = true
      try {
        await deleteDoc(doc(db, 'categories', categoryId))
        this.categories = this.categories.filter(c => c.id !== categoryId)
      } catch (error) {
        console.error('Error al borrar categoría:', error)
        throw error
      } finally {
        this.loading = false
      }
    }
  }
})
