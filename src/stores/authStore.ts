import { defineStore } from 'pinia'
import { auth, db } from '@/lib/firebase'
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged,
  updateProfile
} from 'firebase/auth'
import { doc, setDoc } from 'firebase/firestore'

interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    user: null,
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
          } else {
            this.user = null
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
        
        await setDoc(doc(db, 'users', firebaseUser.uid), {
          uid: firebaseUser.uid,
          email,
          displayName,
          currency: 'USD',
          createdAt: new Date()
        })

        this.user = {
          uid: firebaseUser.uid,
          email,
          displayName,
        }
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
      } catch (error) {
        console.error('Error al cerrar sesión:', error)
        throw error
      } finally {
        this.loading = false
      }
    }
  }
})
