import { initializeApp } from 'firebase/app'
import { getAuth, connectAuthEmulator } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { getStorage, connectStorageEmulator } from 'firebase/storage'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "mock-api-key-for-local-emulators",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "vault-finances-dev.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "vault-finances-dev",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "vault-finances-dev.appspot.com",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "123456789",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:123456789:web:abcdef123456"
}

const app = initializeApp(firebaseConfig)

const auth = getAuth(app)
const db = getFirestore(app)
const storage = getStorage(app)
const functions = getFunctions(app)

// Conectar a emuladores locales en modo de desarrollo
if (import.meta.env.DEV) {
  console.log("⚡ Conectando a los emuladores locales de Firebase...")
  try {
    connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true })
    connectFirestoreEmulator(db, "localhost", 8080)
    connectStorageEmulator(storage, "localhost", 9199)
    connectFunctionsEmulator(functions, "localhost", 5001)
  } catch (err) {
    console.warn("⚠️ Error conectando a los emuladores locales:", err)
  }
}

export { app, auth, db, storage, functions }
