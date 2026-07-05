import { defineStore } from 'pinia'
import { db, auth } from '@/lib/firebase'
import { Workspace, UserProfile } from '@/types'
import { collection, query, where, getDocs, doc, setDoc, updateDoc, getDoc } from 'firebase/firestore'
import { useAuthStore } from './authStore'

interface WorkspacesState {
  workspaces: Workspace[];
  activeWorkspaceProfiles: UserProfile[];
  loading: boolean;
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
    loading: false
  }),
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

    async inviteUser(workspaceId: string, email: string) {
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
        
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || "Error invitando usuario")
        }
        
        await this.fetchMyWorkspaces()
      } catch (err) {
        console.error("Error invitando", err)
        throw err
      } finally {
        this.loading = false
      }
    },
    
    // ponytail: Minimum code to set limit
    async updateWorkspaceLimit(workspaceId: string, limit: number) {
      try {
        await updateDoc(doc(db, 'workspaces', workspaceId), { expenseLimit: limit })
        const ws = this.workspaces.find(w => w.id === workspaceId)
        if (ws) ws.expenseLimit = limit
      } catch (err) {
        console.error("Error limit", err)
      }
    }
  }
})
