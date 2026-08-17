import { defineStore } from 'pinia'
import { db, auth, storage } from '@/lib/firebase'
import { useAccountsStore } from './accountsStore'
import { useAuthStore } from './authStore'
import { Transaction, Category, TransactionType } from '@/types'
import { planMirror, planSettlement } from '@/lib/mirror'
import { 
  collection, 
  query, 
  where, 
  orderBy, 
  getDocs, 
  getDoc,
  addDoc, 
  doc, 
  updateDoc,
  deleteDoc, 
  writeBatch,
  increment,
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
  { name: 'Ahorro', icon: 'PiggyBank', color: '#14b8a6', type: 'expense' },
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
      dateFrom?: string;
      dateTo?: string;
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
        list = list.filter(t =>
          t.description.toLowerCase().includes(term) ||
          (t.notes && t.notes.toLowerCase().includes(term))
        )
      }
      if (filters.dateFrom) {
        const from = new Date(filters.dateFrom + 'T00:00:00')
        list = list.filter(t => t.date >= from)
      }
      if (filters.dateTo) {
        const to = new Date(filters.dateTo + 'T23:59:59.999')
        list = list.filter(t => t.date <= to)
      }

      return list
    },
    // Gastos del mes actual agrupados por categoría (para presupuestos).
    // Acepta un convertidor opcional (amount, currency) => amount en moneda principal.
    spendingByCategoryThisMonth: (state) => (convert?: (amount: number, currency: string) => number) => {
      const now = new Date()
      const result: Record<string, number> = {}
      state.transactions.forEach(t => {
        if (t.type !== 'expense' || !t.categoryId) return
        if (t.date.getMonth() !== now.getMonth() || t.date.getFullYear() !== now.getFullYear()) return
        const amount = convert ? convert(Math.abs(t.amount), t.currency) : Math.abs(t.amount)
        result[t.categoryId] = (result[t.categoryId] || 0) + amount
      })
      return result
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
    async addTransaction({ accountId, amount, description, categoryId, date, type, toAccountId = null, receiptUrl = null, notes = null, userId }: {
      accountId: string;
      amount: number;
      description: string;
      categoryId: string;
      date: Date;
      type: TransactionType;
      toAccountId?: string | null;
      receiptUrl?: string | null;
      notes?: string | null;
      userId?: string;
    }): Promise<Transaction> {
      const user = auth.currentUser
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!user || !workspaceId) throw new Error('Usuario o Workspace no inicializado')

      const accountsStore = useAccountsStore()
      const account = accountsStore.getAccountById(accountId)
      if (!account) throw new Error('Cuenta origen no encontrada')

      // Cuenta puente: un gasto contra ella se replica solo en el workspace espejo.
      // Solo gastos: la transferencia de liquidación no debe replicarse.
      if (type === 'expense' && account.mirror) {
        return this.addMirroredExpense({ accountId, amount, description, categoryId, date, receiptUrl, notes, userId })
      }

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
          notes,
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

    // 3b. Gasto compartido reembolsable (cuenta puente con `mirror` configurado).
    // Escribe el gasto en este workspace + la transferencia espejo en el otro.
    // Los 2 documentos y los 3 saldos van en un solo writeBatch: o entra todo o nada,
    // así no queda una pata huérfana en un workspace que no estás mirando.
    async addMirroredExpense({ accountId, amount, description, categoryId, date, receiptUrl = null, notes = null, userId }: {
      accountId: string;
      amount: number;
      description: string;
      categoryId: string;
      date: Date;
      receiptUrl?: string | null;
      notes?: string | null;
      userId?: string;
    }): Promise<Transaction> {
      const user = auth.currentUser
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!user || !workspaceId) throw new Error('Usuario o Workspace no inicializado')

      const accountsStore = useAccountsStore()
      const bridge = accountsStore.getAccountById(accountId)
      if (!bridge?.mirror) throw new Error('La cuenta no tiene espejo configurado')
      const { workspaceId: mirrorWorkspaceId, accountId: receivableId, sourceAccountId } = bridge.mirror

      this.loading = true
      try {
        // Las cuentas del workspace espejo no están en el estado local: leerlas para
        // validar que existan, que pertenezcan a ese workspace y que la moneda cuadre.
        const [sourceSnap, receivableSnap] = await Promise.all([
          getDoc(doc(db, 'accounts', sourceAccountId)),
          getDoc(doc(db, 'accounts', receivableId))
        ])
        if (!sourceSnap.exists() || !receivableSnap.exists()) {
          throw new Error('Las cuentas del workspace espejo no existen')
        }
        const source = sourceSnap.data()
        const receivable = receivableSnap.data()
        if (source.workspaceId !== mirrorWorkspaceId || receivable.workspaceId !== mirrorWorkspaceId) {
          throw new Error('Las cuentas espejo no pertenecen al workspace configurado')
        }

        const deltas = planMirror({
          amount,
          bridgeCurrency: bridge.currency || 'USD',
          sourceCurrency: source.currency || 'USD',
          receivableCurrency: receivable.currency || 'USD'
        })

        const transactionDate = date instanceof Date ? date : new Date(date)
        // IDs por adelantado para que cada pata apunte a su gemela desde el inicio.
        const mainRef = doc(collection(db, 'transactions'))
        const mirrorRef = doc(collection(db, 'transactions'))

        // Pata local: gasto normal contra la cuenta puente -> consume el presupuesto de este workspace.
        const mainTx = {
          workspaceId,
          userId: userId || user.uid,
          accountId,
          amount: deltas.bridge,
          description,
          categoryId,
          date: Timestamp.fromDate(transactionDate),
          type: 'expense' as TransactionType,
          toAccountId: null,
          receiptUrl,
          notes,
          mirrorOf: mirrorRef.id,
          currency: bridge.currency || 'USD',
          createdAt: new Date()
        }

        // Pata espejo: transferencia sin categoría -> invisible para presupuestos e ingresos/gastos.
        const mirrorTx = {
          workspaceId: mirrorWorkspaceId,
          userId: user.uid,
          accountId: sourceAccountId,
          amount: Math.abs(deltas.bridge),
          description,
          categoryId: '',
          date: Timestamp.fromDate(transactionDate),
          type: 'transfer' as TransactionType,
          toAccountId: receivableId,
          receiptUrl: null,
          notes: `Gasto reembolsable registrado en "${bridge.name}"`,
          mirrorOf: mainRef.id,
          currency: source.currency || 'USD',
          createdAt: new Date()
        }

        const batch = writeBatch(db)
        batch.set(mainRef, mainTx)
        batch.set(mirrorRef, mirrorTx)
        batch.update(doc(db, 'accounts', accountId), { balance: increment(deltas.bridge) })
        batch.update(doc(db, 'accounts', sourceAccountId), { balance: increment(deltas.source) })
        batch.update(doc(db, 'accounts', receivableId), { balance: increment(deltas.receivable) })
        await batch.commit()

        // Estado local: solo la cuenta puente es visible en el workspace activo.
        const bridgeIndex = accountsStore.accounts.findIndex(acc => acc.id === accountId)
        if (bridgeIndex !== -1) accountsStore.accounts[bridgeIndex].balance += deltas.bridge

        // Nota: las cuentas del workspace espejo no están en el estado local; sus saldos
        // ya quedaron correctos en Firestore y se leen al cambiar de workspace.
        const txWithId: Transaction = { id: mainRef.id, ...mainTx, date: transactionDate }
        this.transactions.unshift(txWithId)
        this.transactions.sort((a, b) => b.date.getTime() - a.date.getTime())

        return txWithId
      } catch (error) {
        console.error('Error al registrar gasto espejo:', error)
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
        // 1. Eliminar de Firestore y revertir saldos.
        if (tx.mirrorOf) {
          // Gasto espejo: las dos patas y los tres saldos se revierten juntos o no se revierte nada.
          await this.deleteMirrorPair(tx)
        } else {
          await deleteDoc(doc(db, 'transactions', transactionId))

          if (tx.type === 'transfer' && tx.toAccountId) {
            await accountsStore.updateAccountBalance(tx.accountId, tx.amount)
            await accountsStore.updateAccountBalance(tx.toAccountId, -tx.amount)
          } else {
            await accountsStore.updateAccountBalance(tx.accountId, -tx.amount)
          }
        }

        // 1b. Eliminar de Storage si tiene comprobante
        if (tx.receiptUrl) {
          try {
            const storageFileRef = storageRef(storage, tx.receiptUrl)
            await deleteObject(storageFileRef)
          } catch (storageErr) {
            console.warn('No se pudo borrar el comprobante de Storage:', storageErr)
          }
        }

        this.transactions = this.transactions.filter(t => t.id !== transactionId)
      } catch (error) {
        console.error('Error al borrar transacción:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // 4b. Borrar un par espejo (gasto compartido o liquidación): ambas patas y todos
    // los saldos en un solo batch. Si la pata gemela no se puede leer, falla completo
    // antes de escribir nada: preferible un borrado que no ocurre a media deuda colgando.
    async deleteMirrorPair(tx: Transaction): Promise<void> {
      const accountsStore = useAccountsStore()
      const twinSnap = await getDoc(doc(db, 'transactions', tx.mirrorOf as string))

      const batch = writeBatch(db)
      // Revierte una pata con la misma convención de signos que deleteTransaction.
      const reverse = (leg: { type: string; accountId: string; toAccountId?: string | null; amount: number }) => {
        if (leg.type === 'transfer' && leg.toAccountId) {
          batch.update(doc(db, 'accounts', leg.accountId), { balance: increment(leg.amount) })
          batch.update(doc(db, 'accounts', leg.toAccountId), { balance: increment(-leg.amount) })
        } else {
          batch.update(doc(db, 'accounts', leg.accountId), { balance: increment(-leg.amount) })
        }
      }

      batch.delete(doc(db, 'transactions', tx.id))
      reverse(tx)

      if (twinSnap.exists()) {
        batch.delete(twinSnap.ref)
        reverse(twinSnap.data() as any)
      } else {
        console.warn('La pata espejo ya no existe: se revierte solo este workspace')
      }
      await batch.commit()

      // Puede haber tocado varias cuentas locales: releer es más corto y más fiable
      // que parchear saldo por saldo a mano.
      await accountsStore.fetchAccounts()
    },

    // 4c. Liquidar una cuenta puente: la plata pasa de verdad del workspace deudor a
    // quien puso el gasto. Dos transferencias (una en cada workspace), sin categoría,
    // así que no tocan presupuestos ni ingresos: solo mueven saldos.
    async settleMirror({ bridgeAccountId, amount, fromAccountId, toAccountId, date }: {
      bridgeAccountId: string;
      amount: number;
      fromAccountId: string;
      toAccountId: string;
      date: Date;
    }): Promise<void> {
      const user = auth.currentUser
      const authStore = useAuthStore()
      const workspaceId = authStore.activeWorkspaceId
      if (!user || !workspaceId) throw new Error('Usuario o Workspace no inicializado')

      const accountsStore = useAccountsStore()
      const bridge = accountsStore.getAccountById(bridgeAccountId)
      if (!bridge?.mirror) throw new Error('La cuenta no tiene espejo configurado')
      const from = accountsStore.getAccountById(fromAccountId)
      if (!from) throw new Error('Cuenta de pago no encontrada')
      if (fromAccountId === bridgeAccountId) throw new Error('La cuenta de pago no puede ser la cuenta puente')

      const { workspaceId: mirrorWorkspaceId, accountId: receivableId } = bridge.mirror

      this.loading = true
      try {
        const [receivableSnap, toSnap] = await Promise.all([
          getDoc(doc(db, 'accounts', receivableId)),
          getDoc(doc(db, 'accounts', toAccountId))
        ])
        if (!receivableSnap.exists() || !toSnap.exists()) {
          throw new Error('Las cuentas del workspace espejo no existen')
        }
        const receivable = receivableSnap.data()
        const to = toSnap.data()
        if (receivable.workspaceId !== mirrorWorkspaceId || to.workspaceId !== mirrorWorkspaceId) {
          throw new Error('Las cuentas espejo no pertenecen al workspace configurado')
        }
        if (toAccountId === receivableId) throw new Error('La cuenta que recibe no puede ser la cuenta por cobrar')

        const deltas = planSettlement({
          amount,
          debt: -bridge.balance,
          bridgeCurrency: bridge.currency || 'USD',
          fromCurrency: from.currency || 'USD',
          receivableCurrency: receivable.currency || 'USD',
          toCurrency: to.currency || 'USD'
        })

        const transactionDate = date instanceof Date ? date : new Date(date)
        const localRef = doc(collection(db, 'transactions'))
        const mirrorRef = doc(collection(db, 'transactions'))
        const shared = {
          amount,
          description: `Liquidación de ${bridge.name}`,
          categoryId: '',
          date: Timestamp.fromDate(transactionDate),
          type: 'transfer' as TransactionType,
          receiptUrl: null,
          createdAt: new Date()
        }

        const batch = writeBatch(db)
        batch.set(localRef, {
          ...shared,
          workspaceId,
          userId: user.uid,
          accountId: fromAccountId,
          toAccountId: bridgeAccountId,
          notes: `Reembolso pagado desde ${from.name}`,
          mirrorOf: mirrorRef.id,
          currency: bridge.currency || 'USD'
        })
        batch.set(mirrorRef, {
          ...shared,
          workspaceId: mirrorWorkspaceId,
          userId: user.uid,
          accountId: receivableId,
          toAccountId,
          notes: `Reembolso recibido en ${to.name}`,
          mirrorOf: localRef.id,
          currency: to.currency || 'USD'
        })
        batch.update(doc(db, 'accounts', fromAccountId), { balance: increment(deltas.from) })
        batch.update(doc(db, 'accounts', bridgeAccountId), { balance: increment(deltas.bridge) })
        batch.update(doc(db, 'accounts', receivableId), { balance: increment(deltas.receivable) })
        batch.update(doc(db, 'accounts', toAccountId), { balance: increment(deltas.to) })
        await batch.commit()

        await accountsStore.fetchAccounts()
        await this.fetchTransactions()
      } catch (error) {
        console.error('Error al liquidar cuenta puente:', error)
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
      notes?: string | null;
      userId?: string;
    }): Promise<Transaction> {
      const user = auth.currentUser
      if (!user) throw new Error('Usuario no autenticado')

      const accountsStore = useAccountsStore()
      const txIndex = this.transactions.findIndex(t => t.id === transactionId)
      if (txIndex === -1) throw new Error('Transacción no encontrada en el estado local')
      const oldTx = this.transactions[txIndex]

      // Editar solo una pata desincronizaría el saldo del otro workspace en silencio.
      // ponytail: bloquear en vez de sincronizar; borrar y recrear es 2 clics.
      if (oldTx.mirrorOf) {
        throw new Error('Este gasto tiene una pata espejo en otro workspace. Bórralo y vuelve a crearlo para modificarlo.')
      }

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
          notes: updates.notes ?? null,
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
