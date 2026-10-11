#!/usr/bin/env node
// Backfills transactionEmbeddings/{transactionId} and strips the legacy inline
// `transactions.embedding` field. Dry-run by default; resumable (fresh vectors are skipped).
//
//   pnpm --filter functions build
//   GEMINI_API_KEY=... node scripts/backfill-embeddings.mjs --project <id> [--apply] [--limit N]
//       [--concurrency 2] [--delay-ms 250] [--fake-embeddings (emulator only)]
//
// Credentials: Application Default Credentials (`gcloud auth application-default login`),
// or the Firestore emulator when FIRESTORE_EMULATOR_HOST is set. The Gemini key is read
// from GEMINI_API_KEY / GOOGLE_GENAI_API_KEY and is never printed.
//
// Legacy vectors are re-embedded rather than copied: they were built from the old text
// (no category/account, no retrieval prefix) and would rank poorly against prefixed queries.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const repositoryRoot = resolve(import.meta.dirname, '..')
const requireFunctions = createRequire(resolve(repositoryRoot, 'functions/package.json'))
const libPath = resolve(repositoryRoot, 'functions/lib/embeddings.js')

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(2)
}

let options
try {
  ({ values: options } = parseArgs({
    options: {
      project: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      limit: { type: 'string' },
      concurrency: { type: 'string', default: '2' },
      'delay-ms': { type: 'string', default: '250' },
      'fake-embeddings': { type: 'boolean', default: false }
    }
  }))
} catch (error) {
  fail(error.message)
}

const positiveInt = (value, name, max) => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || (max && parsed > max)) fail(`--${name} must be an integer between 0 and ${max ?? '∞'}`)
  return parsed
}

if (!options.project) fail('--project <id> is required')
if (options.apply && options['dry-run']) fail('use either --apply or --dry-run')
if (!existsSync(libPath)) fail('functions/lib/embeddings.js not found; run `pnpm --filter functions build` first')
const apply = options.apply
const limit = options.limit === undefined ? Infinity : positiveInt(options.limit, 'limit')
const concurrency = Math.max(1, positiveInt(options.concurrency, 'concurrency', 4))
const delayMs = positiveInt(options['delay-ms'], 'delay-ms')
const emulator = process.env.FIRESTORE_EMULATOR_HOST
if (options['fake-embeddings'] && !emulator) fail('--fake-embeddings is only allowed against the Firestore emulator')

const { initializeApp } = requireFunctions('firebase-admin/app')
const { getFirestore, FieldPath, FieldValue } = requireFunctions('firebase-admin/firestore')
const {
  EMBEDDING_DIM, EMBEDDINGS_COLLECTION, createGeminiEmbedder, createNameResolver, hashEmbeddingText,
  planEmbeddingSync, syncTransactionEmbedding
} = requireFunctions(libPath)

let embed = null
if (options['fake-embeddings']) {
  embed = async (input) => {
    const seed = parseInt(hashEmbeddingText(input).slice(0, 8), 16)
    return Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(seed + i))
  }
} else if (apply) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY
  if (!apiKey) fail('GEMINI_API_KEY (or GOOGLE_GENAI_API_KEY) must be set for --apply')
  embed = createGeminiEmbedder(apiKey)
}

const db = getFirestore(initializeApp({ projectId: options.project }))
const names = createNameResolver(db)
const counts = {
  scanned: 0, upToDate: 0, needsEmbedding: 0, needsDelete: 0, legacyFields: 0,
  embedded: 0, superseded: 0, deleted: 0, legacyFieldsStripped: 0, failed: 0, skippedByLimit: 0
}
let changes = 0
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

async function processTransaction(docSnap) {
  counts.scanned++
  const data = docSnap.data()
  const plan = await planEmbeddingSync(db, names, docSnap.id, data)
  const { action } = plan.decision
  if (action === 'embed') counts.needsEmbedding++
  else if (action === 'delete') counts.needsDelete++
  else if (plan.decision.reason === 'unchanged') counts.upToDate++
  if (plan.hasLegacyField) counts.legacyFields++
  if (!apply || (action === 'skip' && !plan.hasLegacyField)) return
  if (changes >= limit) {
    counts.skippedByLimit++
    return
  }
  changes++

  try {
    const outcome = action === 'skip' ? 'unchanged' : await syncTransactionEmbedding({ db, names, embed }, docSnap.id, data, plan)
    if (outcome === 'embedded') counts.embedded++
    if (outcome === 'deleted') counts.deleted++
    if (outcome === 'superseded') counts.superseded++
    // Strip the inline vector only once the transaction no longer depends on it.
    if (plan.hasLegacyField && outcome !== 'superseded') {
      await docSnap.ref.update({ embedding: FieldValue.delete() })
      counts.legacyFieldsStripped++
    }
    if (action === 'embed' && delayMs) await sleep(delayMs)
  } catch (error) {
    counts.failed++
    console.error(`failed ${docSnap.id}: ${String(error?.message ?? error).slice(0, 200)}`)
  }
}

console.log(`${apply ? 'APPLY' : 'DRY-RUN'} project=${options.project}${emulator ? ` emulator=${emulator}` : ''} concurrency=${concurrency}${Number.isFinite(limit) ? ` limit=${limit}` : ''}`)
let cursor = null
for (;;) {
  let query = db.collection('transactions').orderBy(FieldPath.documentId()).limit(200)
  if (cursor) query = query.startAfter(cursor)
  const page = await query.get()
  if (page.empty) break
  const queue = [...page.docs]
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) await processTransaction(queue.shift())
  }))
  cursor = page.docs[page.docs.length - 1].id
}

// Vectors whose transaction no longer exists (e.g. deleted while the trigger was down).
const orphans = []
const embeddingIds = (await db.collection(EMBEDDINGS_COLLECTION).select().get()).docs.map(d => d.id)
for (let i = 0; i < embeddingIds.length; i += 100) {
  const refs = embeddingIds.slice(i, i + 100).map(id => db.collection('transactions').doc(id))
  const snaps = await db.getAll(...refs)
  snaps.forEach(snap => { if (!snap.exists) orphans.push(snap.id) })
}
counts.orphans = orphans.length
if (apply) {
  for (const id of orphans) await db.collection(EMBEDDINGS_COLLECTION).doc(id).delete()
  counts.orphansDeleted = orphans.length
}

console.log(JSON.stringify(counts, null, 2))
if (!apply) console.log('Dry run only. Re-run with --apply to write.')
process.exit(counts.failed > 0 ? 1 : 0)
