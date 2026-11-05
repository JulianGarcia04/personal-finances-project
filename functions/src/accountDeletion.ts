// Must stay first: applies global function options before onCall below.
import './options'
import * as admin from 'firebase-admin'
import { FieldValue, type DocumentReference, type Firestore, type WriteBatch } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { z } from 'zod'
import { EMBEDDINGS_COLLECTION } from './embeddings'

export const DELETE_CONFIRMATION = 'ELIMINAR'

/** Server-only record of the workspaces a deletion removes, so a retry can finish them. */
export const ACCOUNT_DELETIONS_COLLECTION = 'accountDeletions'

/** Collections whose documents belong to one workspace through their `workspaceId` field. */
const WORKSPACE_COLLECTIONS = [
  'accounts', 'transactions', 'categories', 'goals', 'budgets', 'chats',
  EMBEDDINGS_COLLECTION, 'budgetAlerts', 'statementImports'
] as const

/** Collections whose documents have subcollections (budgets/{id}/categoryCaps). */
const COLLECTIONS_WITH_SUBCOLLECTIONS = new Set<string>(['budgets'])

const BATCH_SIZE = 400

export type WorkspaceExit =
  | { kind: 'delete' }
  | { kind: 'leave'; members: string[]; transferTo: string | null }
  | { kind: 'not-member' }

/**
 * What happens to one workspace when `uid` deletes their account. The last member's workspace is
 * deleted. Otherwise `uid` leaves it and, if they own it, the oldest remaining member becomes the
 * owner: `members` keeps join order (creation puts the owner first, invites append).
 */
export function planWorkspaceExit(workspace: { ownerId?: unknown; members?: unknown }, uid: string): WorkspaceExit {
  const members = Array.isArray(workspace.members) ? workspace.members : []
  if (!members.includes(uid)) return { kind: 'not-member' }
  const remaining = members.filter(member => member !== uid)
  if (remaining.length === 0) return { kind: 'delete' }
  return { kind: 'leave', members: remaining, transferTo: workspace.ownerId === uid ? remaining[0] : null }
}

export type AccountDeletionDeps = {
  db: Firestore
  deleteStoragePrefix: (prefix: string) => Promise<void>
  deleteAuthUser: (uid: string) => Promise<void>
}

export type AccountDeletionResult = { deletedWorkspaces: number; leftWorkspaces: number }

type Outcome = 'deleted' | 'left' | 'skipped'

/**
 * Applies the exit plan in one transaction. With `remove`, the last member's workspace document
 * is deleted (and a missing one counts as deleted, for retries); without it, it is only reported.
 */
async function exitWorkspace(db: Firestore, ref: DocumentReference, uid: string, remove: boolean): Promise<Outcome> {
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) return remove ? 'deleted' : 'skipped'
    const plan = planWorkspaceExit(snapshot.data()!, uid)
    if (plan.kind === 'not-member') return 'skipped'
    if (plan.kind === 'leave') {
      transaction.update(ref, { members: plan.members, ...(plan.transferTo ? { ownerId: plan.transferTo } : {}) })
      return 'left'
    }
    if (remove) transaction.delete(ref)
    return 'deleted'
  })
}

async function commitInBatches(db: Firestore, writes: Array<(batch: WriteBatch) => void>): Promise<void> {
  for (let start = 0; start < writes.length; start += BATCH_SIZE) {
    const batch = db.batch()
    for (const write of writes.slice(start, start + BATCH_SIZE)) write(batch)
    await batch.commit()
  }
}

/**
 * Removes the links other workspaces keep into a deleted one: a bridge account mirroring into it
 * becomes an ordinary account with its balance, and a twin leg stops pointing at the deleted leg.
 */
async function detachLinks(db: Firestore, workspaceId: string, deleted: Set<string>, mirrorLegs: Array<{ id: string; mirrorOf: string }>) {
  const writes: Array<(batch: WriteBatch) => void> = []
  const bridges = await db.collection('accounts').where('mirror.workspaceId', '==', workspaceId).get()
  for (const bridge of bridges.docs) {
    if (!deleted.has(bridge.get('workspaceId'))) writes.push(batch => batch.update(bridge.ref, { mirror: null }))
  }
  for (let start = 0; start < mirrorLegs.length; start += 100) {
    const legs = mirrorLegs.slice(start, start + 100)
    const twins = await db.getAll(...legs.map(leg => db.collection('transactions').doc(leg.mirrorOf)))
    twins.forEach((twin, index) => {
      if (twin.exists && !deleted.has(twin.get('workspaceId')) && twin.get('mirrorOf') === legs[index].id) {
        writes.push(batch => batch.update(twin.ref, { mirrorOf: null }))
      }
    })
  }
  await commitInBatches(db, writes)
}

/** Deletes every document of the workspace, its files, and the links other workspaces keep into it. */
async function purgeWorkspace(deps: AccountDeletionDeps, workspaceId: string, deleted: Set<string>) {
  const { db } = deps
  const transactions = await db.collection('transactions').where('workspaceId', '==', workspaceId).get()
  const mirrorLegs = transactions.docs
    .filter(leg => typeof leg.get('mirrorOf') === 'string' && leg.get('mirrorOf'))
    .map(leg => ({ id: leg.id, mirrorOf: leg.get('mirrorOf') as string }))
  // Links go first: once the legs are gone, a retry could no longer find their twins.
  await detachLinks(db, workspaceId, deleted, mirrorLegs)

  for (const name of WORKSPACE_COLLECTIONS) {
    const snapshot = name === 'transactions'
      ? transactions
      : await db.collection(name).where('workspaceId', '==', workspaceId).select().get()
    if (COLLECTIONS_WITH_SUBCOLLECTIONS.has(name)) {
      for (const doc of snapshot.docs) await db.recursiveDelete(doc.ref)
    } else {
      await commitInBatches(db, snapshot.docs.map(doc => batch => batch.delete(doc.ref)))
    }
  }
  await deps.deleteStoragePrefix(`workspaces/${workspaceId}/`)
}

/**
 * Deletes the account of `uid`: leaves every shared workspace (passing ownership on), deletes the
 * workspaces where they are the last member with all their data, then their own data and Auth user.
 * What they recorded in shared workspaces stays there. Safe to call again after a failure.
 */
export async function deleteUserAccount(deps: AccountDeletionDeps, uid: string): Promise<AccountDeletionResult> {
  const { db } = deps
  const recordRef = db.collection(ACCOUNT_DELETIONS_COLLECTION).doc(uid)
  const [memberships, record] = await Promise.all([
    db.collection('workspaces').where('members', 'array-contains', uid).get(),
    recordRef.get()
  ])

  let leftWorkspaces = 0
  const candidates = new Set<string>(
    (Array.isArray(record.get('workspaceIds')) ? record.get('workspaceIds') : [])
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
  )
  for (const workspace of memberships.docs) {
    const outcome = await exitWorkspace(db, workspace.ref, uid, false)
    if (outcome === 'left') leftWorkspaces++
    if (outcome === 'deleted') candidates.add(workspace.id)
  }

  // Recorded before any workspace document disappears, so a retry still finds those workspaces.
  await recordRef.set({ uid, workspaceIds: [...candidates].sort(), updatedAt: FieldValue.serverTimestamp() })

  // Workspace documents go before their data: the rules then refuse client writes to them, and the
  // budget-alert trigger stops at the missing workspace while its transactions are deleted.
  const deleted = new Set<string>()
  for (const workspaceId of candidates) {
    const outcome = await exitWorkspace(db, db.collection('workspaces').doc(workspaceId), uid, true)
    if (outcome === 'left') leftWorkspaces++
    if (outcome === 'deleted') deleted.add(workspaceId)
  }
  for (const workspaceId of deleted) await purgeWorkspace(deps, workspaceId, deleted)

  const quotas = await db.collection('usageQuotas').where('uid', '==', uid).select().get()
  await commitInBatches(db, quotas.docs.map(doc => batch => batch.delete(doc.ref)))
  await db.recursiveDelete(db.collection('users').doc(uid))
  await deps.deleteStoragePrefix(`users/${uid}/`)
  await recordRef.delete()
  await deps.deleteAuthUser(uid)

  return { deletedWorkspaces: deleted.size, leftWorkspaces }
}

const deleteAccountRequestSchema = z.object({ confirmation: z.literal(DELETE_CONFIRMATION) })

export const deleteAccount = onCall({ timeoutSeconds: 540 }, async request => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'La autenticación es obligatoria.')
  if (!deleteAccountRequestSchema.safeParse(request.data).success) {
    throw new HttpsError('invalid-argument', `Escribe ${DELETE_CONFIRMATION} para confirmar la eliminación de la cuenta.`)
  }
  const uid = request.auth.uid
  try {
    const bucket = admin.storage().bucket()
    return await deleteUserAccount({
      db: admin.firestore(),
      deleteStoragePrefix: prefix => bucket.deleteFiles({ prefix }),
      deleteAuthUser: id => admin.auth().deleteUser(id)
    }, uid)
  } catch (error) {
    logger.error('deleteAccount failed', { uid, error })
    throw new HttpsError('internal', 'No se pudo eliminar la cuenta. Intenta de nuevo: lo que ya se eliminó no se repite.')
  }
})
