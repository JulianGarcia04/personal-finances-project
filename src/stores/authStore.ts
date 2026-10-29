import { defineStore } from 'pinia'
import { auth, db } from '@/lib/firebase'
import { disablePush, hasPushRegistration } from '@/lib/push'
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  updateProfile
} from 'firebase/auth'
import { doc, getDoc, updateDoc, collection, runTransaction } from 'firebase/firestore'
import type { UserProfile } from '@/types'
import { buildPersonalWorkspace, buildUserProfile, resolveDisplayName } from '@/lib/authProfile'

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
              displayName: resolveDisplayName(firebaseUser.displayName, firebaseUser.email),
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
        await this.ensureUserProfile(firebaseUser.uid, email, displayName)

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
    async signInWithGoogle(): Promise<AuthUser> {
      this.loading = true
      try {
        const { user: firebaseUser } = await signInWithPopup(auth, new GoogleAuthProvider())
        const displayName = resolveDisplayName(firebaseUser.displayName, firebaseUser.email)
        await this.ensureUserProfile(firebaseUser.uid, firebaseUser.email, displayName)

        this.user = {
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          displayName,
        }
        return this.user
      } catch (error) {
        console.error('Error al ingresar con Google:', error)
        throw error
      } finally {
        this.loading = false
      }
    },
    // Loads the profile, creating the personal workspace and profile on the
    // first sign-in. The transaction keeps a double submit or a retry from
    // creating a second workspace or a profile without one.
    async ensureUserProfile(uid: string, email: string | null, displayName: string): Promise<void> {
      const profileRef = doc(db, 'users', uid)
      const profile = await runTransaction(db, async (tx) => {
        const snapshot = await tx.get(profileRef)
        if (snapshot.exists()) return snapshot.data() as UserProfile

        const workspaceRef = doc(collection(db, 'workspaces'))
        const now = new Date()
        const profileData = buildUserProfile({ uid, email, displayName, workspaceId: workspaceRef.id, now })
        tx.set(workspaceRef, buildPersonalWorkspace(uid, workspaceRef.id, now))
        tx.set(profileRef, profileData)
        return profileData as unknown as UserProfile
      })
      this.profile = profile
      this.activeWorkspaceId = profile.activeWorkspaceId || null
    },
    async resetPassword(email: string): Promise<void> {
      try {
        await sendPasswordResetEmail(auth, email.trim())
      } catch (error) {
        // Same answer whether or not the email is registered.
        if ((error as { code?: string }).code === 'auth/user-not-found') return
        throw error
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
          displayName: resolveDisplayName(firebaseUser.displayName, firebaseUser.email),
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
        // Unregister this device first so the next user of this browser never
        // receives the previous user's alerts. Best-effort: never blocks logout.
        const uid = auth.currentUser?.uid
        if (uid && hasPushRegistration()) {
          await disablePush(uid).catch((err) => console.warn('Push unregister on logout failed:', err))
        }
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
