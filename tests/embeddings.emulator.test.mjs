// Embedding sync core against the Firestore emulator, with a fake embedder (no Gemini calls).
// Requires `pnpm --filter functions build`. Run (demo project only):
//   firebase emulators:exec --project demo-vault-access --only firestore \
//     --config tests/firebase.pockets.json "node --test tests/embeddings.emulator.test.mjs"
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const requireFunctions = createRequire(resolve(repositoryRoot, 'functions/package.json'))

assert.match(process.env.GCLOUD_PROJECT ?? '', /^demo-/, 'tests must run against a demo project only')
assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /^(127\.0\.0\.1|localhost):\d+$/, 'Firestore emulator must use loopback')

const { initializeApp, deleteApp } = requireFunctions('firebase-admin/app')
const { getFirestore } = requireFunctions('firebase-admin/firestore')
const embeddings = requireFunctions('./lib/embeddings.js')
const { EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDINGS_COLLECTION, createNameResolver, planEmbeddingSync, syncTransactionEmbedding, toVectorArray } = embeddings

let app
let db
const workspaceId = `ws-${Date.now()}`
const calls = []
const fakeEmbed = async (input) => {
  calls.push(input)
  return Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === calls.length % EMBEDDING_DIM ? 1 : 0))
}
const sync = async (id, embed = fakeEmbed) => {
  const snap = await db.collection('transactions').doc(id).get()
  return syncTransactionEmbedding({ db, names: createNameResolver(db), embed }, id, snap.data())
}
const embeddingDoc = id => db.collection(EMBEDDINGS_COLLECTION).doc(id).get()

before(async () => {
  app = initializeApp({ projectId: process.env.GCLOUD_PROJECT }, `embeddings-${Date.now()}`)
  db = getFirestore(app)
  await db.collection('categories').doc(`${workspaceId}-food`).set({ workspaceId, name: 'Comida' })
  await db.collection('accounts').doc(`${workspaceId}-visa`).set({ workspaceId, name: 'Visa' })
})

after(async () => {
  await deleteApp(app)
})

test('create embeds with category/account names and stores the vector off the transaction', async () => {
  const id = `${workspaceId}-t1`
  await db.collection('transactions').doc(id).set({
    workspaceId, description: 'Almuerzo', type: 'expense', amount: -20, currency: 'COP',
    categoryId: `${workspaceId}-food`, accountId: `${workspaceId}-visa`, date: new Date('2026-10-11T15:00:00Z')
  })
  assert.equal(await sync(id), 'embedded')
  assert.match(calls.at(-1), /^title: none \| text: .*Categoría: Comida\. Cuenta: Visa\./)
  const stored = (await embeddingDoc(id)).data()
  assert.equal(stored.workspaceId, workspaceId)
  assert.equal(stored.model, EMBEDDING_MODEL)
  assert.equal(stored.dim, EMBEDDING_DIM)
  assert.equal(stored.textHash.length, 64)
  assert.ok(Array.isArray(stored.embedding), '3072 dims exceed the 2048-dim Firestore vector limit')
  assert.equal(toVectorArray(stored.embedding).length, EMBEDDING_DIM)
  assert.equal((await db.collection('transactions').doc(id).get()).get('embedding'), undefined, 'transaction is not touched')

  const before = calls.length
  assert.equal(await sync(id), 'unchanged', 'same text → no Gemini call')
  assert.equal(calls.length, before)

  await db.collection('transactions').doc(id).update({ notes: 'con clientes' })
  assert.equal(await sync(id), 'embedded', 'relevant edit re-embeds')
  assert.notEqual((await embeddingDoc(id)).get('textHash'), stored.textHash)

  await db.collection('transactions').doc(id).delete()
  assert.equal(await sync(id), 'deleted')
  assert.equal((await embeddingDoc(id)).exists, false)
})

test('mirror legs are never embedded and lose an existing vector', async () => {
  const id = `${workspaceId}-mirror`
  await db.collection(EMBEDDINGS_COLLECTION).doc(id).set({ workspaceId, textHash: 'old' })
  await db.collection('transactions').doc(id).set({ workspaceId, description: 'Espejo', type: 'transfer', amount: 5, mirrorOf: 'x' })
  const before = calls.length
  assert.equal(await sync(id), 'deleted')
  assert.equal(calls.length, before)
  assert.equal((await embeddingDoc(id)).exists, false)
  assert.equal(await sync(id), 'skipped')
})

test('a stale plan does not overwrite a newer transaction state', async () => {
  const id = `${workspaceId}-race`
  const ref = db.collection('transactions').doc(id)
  await ref.set({ workspaceId, description: 'Antes', type: 'expense', amount: 1 })
  const resolver = createNameResolver(db)
  const plan = await planEmbeddingSync(db, resolver, id, (await ref.get()).data())
  await ref.update({ description: 'Después' })
  assert.equal(await syncTransactionEmbedding({ db, names: resolver, embed: fakeEmbed }, id, undefined, plan), 'superseded')
  assert.equal((await embeddingDoc(id)).exists, false)

  await ref.delete()
  assert.equal(await syncTransactionEmbedding({ db, names: resolver, embed: fakeEmbed }, id, undefined, plan), 'superseded')
  assert.equal((await embeddingDoc(id)).exists, false, 'no orphan vector for a deleted transaction')
})

test('missing key is reported without throwing', async () => {
  const id = `${workspaceId}-nokey`
  await db.collection('transactions').doc(id).set({ workspaceId, description: 'Sin key', type: 'income', amount: 3 })
  assert.equal(await sync(id, null), 'no-key')
  assert.equal((await embeddingDoc(id)).exists, false)
})
