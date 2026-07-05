import { defineStore } from 'pinia'
import { auth, db } from '@/lib/firebase'
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged,
  updateProfile
} from 'firebase/auth'
import { doc, getDoc, setDoc, updateDoc, collection } from 'firebase/firestore'
import type { UserProfile } from '@/types'

interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

interface AuthState {
  user: AuthUser | null;
  profile: UserProfile | null;
  activeWorkspaceId: string | null;
  loading: boolean;
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    user: null,
    profile: null,
    activeWorkspaceId: null,
    loading: true,
  }),
  getters: {
    isAuthenticated: (state) => !!state.user,
  },
  actions: {
    init(): Promise<AuthUser | null> {
      return new Promise((resolve) => {
        onAuthStateChanged(auth, async (firebaseUser) => {
          if (firebaseUser) {
            this.user = {
              uid: firebaseUser.uid,
              email: firebaseUser.email,
              displayName: firebaseUser.displayName || (firebaseUser.email ? firebaseUser.email.split('@')[0] : 'Usuario'),
            }
            try {
              const profileDoc = await getDoc(doc(db, 'users', firebaseUser.uid))
              if (profileDoc.exists()) {
                this.profile = profileDoc.data() as UserProfile
                this.activeWorkspaceId = this.profile.activeWorkspaceId || null
              }
            } catch (err) {
              console.error("Error fetching user profile", err)
            }
          } else {
            this.user = null
            this.profile = null
            this.activeWorkspaceId = null
          }
          this.loading = false
          resolve(this.user)
        })
      })
    },
    async signUp(email: string, password: string, displayName: string): Promise<AuthUser> {
      this.loading = true
      try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password)
        const firebaseUser = userCredential.user
        
        await updateProfile(firebaseUser, { displayName })
        
        // Crear Workspace personal
        const workspaceRef = doc(collection(db, 'workspaces'))
        const workspaceId = workspaceRef.id
        await setDoc(workspaceRef, {
          id: workspaceId,
          name: 'Personal',
          ownerId: firebaseUser.uid,
          members: [firebaseUser.uid],
          currency: 'USD',
          createdAt: new Date().toISOString()
        })

        const profileData = {
          uid: firebaseUser.uid,
          email,
          displayName,
          currency: 'USD',
          createdAt: new Date(),
          activeWorkspaceId: workspaceId,
          workspaces: [workspaceId]
        }
        await setDoc(doc(db, 'users', firebaseUser.uid), profileData)

        this.user = {
          uid: firebaseUser.uid,
          email,
          displayName,
        }
        this.profile = profileData as unknown as UserProfile
        this.activeWorkspaceId = workspaceId
        
        return this.user
      } catch (error) {
        console.error('Error al registrarse:', error)
        throw error
      } finally {
        this.loading = false
      }
    },
    async signIn(email: string, password: string): Promise<AuthUser> {
      this.loading = true
      try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password)
        const firebaseUser = userCredential.user
        this.user = {
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          displayName: firebaseUser.displayName || (firebaseUser.email ? firebaseUser.email.split('@')[0] : 'Usuario'),
        }
        const profileDoc = await getDoc(doc(db, 'users', firebaseUser.uid))
        if (profileDoc.exists()) {
          this.profile = profileDoc.data() as UserProfile
          this.activeWorkspaceId = this.profile.activeWorkspaceId || null
        }
        return this.user
      } catch (error) {
        console.error('Error al iniciar sesión:', error)
        throw error
      } finally {
        this.loading = false
      }
    },
    async logout(): Promise<void> {
      this.loading = true
      try {
        await signOut(auth)
        this.user = null
        this.profile = null
        this.activeWorkspaceId = null
      } catch (error) {
        console.error('Error al cerrar sesión:', error)
        throw error
      } finally {
        this.loading = false
      }
    },
    async switchWorkspace(workspaceId: string): Promise<void> {
      if (!this.user) return;
      this.activeWorkspaceId = workspaceId;
      if (this.profile) {
        this.profile.activeWorkspaceId = workspaceId;
      }
      try {
        await updateDoc(doc(db, 'users', this.user.uid), {
          activeWorkspaceId: workspaceId
        });
      } catch (err) {
        console.error("Error updating active workspace", err);
      }
    }
  }
})
