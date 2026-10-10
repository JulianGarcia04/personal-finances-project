import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'vite'

export const projectId = 'demo-vault-pockets'
const repositoryRoot = resolve(import.meta.dirname, '..')
const requireFunctions = createRequire(resolve(repositoryRoot, 'functions/package.json'))

function assertLoopbackEmulatorHost(value, port, name) {
  assert.ok(value, `${name} emulator host must be configured`)
  const [host, rawPort] = value.split(':')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(host), `${name} emulator must use loopback`)
  assert.equal(Number(rawPort), port, `${name} emulator port must match the local fixture`)
}

export async function createPocketFixture() {
  assert.equal(process.env.GCLOUD_PROJECT, projectId, 'tests must run against the demo project only')
  assertLoopbackEmulatorHost(process.env.FIRESTORE_EMULATOR_HOST, 8080, 'Firestore')
  assertLoopbackEmulatorHost(process.env.FIREBASE_AUTH_EMULATOR_HOST, 9099, 'Auth')
  assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined, 'ambient Google credentials are not allowed')
  assert.equal(process.env.FIREBASE_TOKEN, undefined, 'ambient Firebase tokens are not allowed')

  const rulesPath = resolve(repositoryRoot, 'tests/firestore.rules')
  assert.equal(realpathSync(rulesPath), resolve(repositoryRoot, 'firestore.rules'), 'the test rules must resolve to the live repository rules file')
  assert.match(readFileSync(rulesPath, 'utf8'), /function isWorkspaceMember\(/, 'the test rules target does not contain the expected workspace-membership rule')

  const admin = requireFunctions('firebase-admin')
  const adminApp = admin.initializeApp({ projectId }, `pockets-${Date.now()}-${Math.random()}`)
  const adminDb = adminApp.firestore()
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: repositoryRoot,
    mode: 'test',
    logLevel: 'error',
    resolve: { alias: { '@': resolve(repositoryRoot, 'src') } },
    define: {
      'import.meta.env': JSON.stringify({
        BASE_URL: '/',
        MODE: 'test',
        DEV: true,
        PROD: false,
        SSR: true,
        VITE_FIREBASE_API_KEY: 'emulator-only-fixture-key',
        VITE_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
        VITE_FIREBASE_PROJECT_ID: projectId,
        VITE_FIREBASE_STORAGE_BUCKET: `${projectId}.appspot.com`,
        VITE_FIREBASE_MESSAGING_SENDER_ID: '123456789',
        VITE_FIREBASE_APP_ID: '1:123456789:web:pocket-fixture'
      })
    }
  })

  try {
    const { auth, db, app } = await vite.ssrLoadModule('/src/lib/firebase.ts')
    const { initializeApp, deleteApp } = await import('firebase/app')
    const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signOut } = await import('firebase/auth')
    const { getFirestore, connectFirestoreEmulator, doc, setDoc, terminate } = await import('firebase/firestore')
    const { createPinia, setActivePinia } = await import('pinia')
    const authStoreModule = await vite.ssrLoadModule('/src/stores/authStore.ts')
    const accountsStoreModule = await vite.ssrLoadModule('/src/stores/accountsStore.ts')
    const transactionsStoreModule = await vite.ssrLoadModule('/src/stores/transactionsStore.ts')
    const identity = await createUserWithEmailAndPassword(
      auth,
      `pockets-${Date.now()}@example.test`,
      'emulator-password-123'
    )
    const workspaceId = `workspace-${identity.user.uid}`
    await adminDb.collection('workspaces').doc(workspaceId).set({
      id: workspaceId,
      name: 'Pocket test workspace',
      ownerId: identity.user.uid,
      members: [identity.user.uid],
      currency: 'COP'
    })
    await adminDb.collection('users').doc(identity.user.uid).set({
      uid: identity.user.uid,
      activeWorkspaceId: workspaceId,
      workspaces: [workspaceId]
    })

    // Allow-all fallback is unsafe for this harness. A real outsider denial proves
    // that the Firestore emulator loaded the configured repository rules.
    const outsiderApp = initializeApp({
      apiKey: 'emulator-only-fixture-key',
      authDomain: `${projectId}.firebaseapp.com`,
      projectId,
      storageBucket: `${projectId}.appspot.com`,
      messagingSenderId: '123456789',
      appId: '1:123456789:web:pocket-outsider'
    }, `outsider-${Date.now()}`)
    const outsiderAuth = getAuth(outsiderApp)
    connectAuthEmulator(outsiderAuth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
    const outsiderDb = getFirestore(outsiderApp)
    connectFirestoreEmulator(outsiderDb, '127.0.0.1', 8080)
    const outsider = await createUserWithEmailAndPassword(
      outsiderAuth,
      `outsider-${Date.now()}@example.test`,
      'emulator-password-123'
    )
    const canaryRef = doc(outsiderDb, 'accounts', `outsider-canary-${outsider.user.uid}`)
    await assert.rejects(
      setDoc(canaryRef, {
        workspaceId,
        userId: outsider.user.uid,
        name: 'Outsider canary',
        type: 'checking',
        balance: 1,
        limit: 0,
        currency: 'COP',
        createdAt: new Date()
      }),
      (error) => error?.code === 'permission-denied',
      'Firestore rules were not loaded: the outsider canary write must be denied'
    )
    assert.equal((await adminDb.collection('accounts').doc(canaryRef.id).get()).exists, false)

    setActivePinia(createPinia())
    const authStore = authStoreModule.useAuthStore()
    authStore.activeWorkspaceId = workspaceId
    const accountsStore = accountsStoreModule.useAccountsStore()
    const transactionsStore = transactionsStoreModule.useTransactionsStore()

    return {
      admin,
      adminDb,
      app,
      auth,
      authStore,
      accountsStore,
      transactionsStore,
      db,
      identity,
      workspaceId,
      outsiderApp,
      outsiderAuth,
      outsiderDb,
      async close() {
        const cleanups = [
          signOut(auth),
          signOut(outsiderAuth),
          terminate(db),
          terminate(outsiderDb),
          deleteApp(app),
          deleteApp(outsiderApp)
        ]
        const cleanupResults = await Promise.allSettled(cleanups)
        await vite.close()
        await adminApp.delete()
        const rejected = cleanupResults.find(result => result.status === 'rejected')
        if (rejected?.status === 'rejected') throw rejected.reason
      }
    }
  } catch (error) {
    await vite.close()
    await adminApp.delete()
    throw error
  }
}

export const functionsRequire = requireFunctions
