import { collection, doc, getDoc, getDocs, query, where, type Firestore } from 'firebase/firestore'
import { EXPORT_COLLECTIONS, buildWorkspaceExport, type ExportCollection, type ExportRecord } from '@/lib/dataExport'

// Same workspaceId queries the stores use, so Firestore rules allow them for
// any member. The profile's `secure` subcollection (encrypted API key) is never read.
export async function fetchWorkspaceExport(db: Firestore, workspaceId: string, uid: string) {
  const toRecords = (snapshot: Awaited<ReturnType<typeof getDocs>>): ExportRecord[] =>
    snapshot.docs.map((document) => ({ id: document.id, ...(document.data() as Record<string, unknown>) }))

  const [workspaceSnap, profileSnap, collectionSnaps] = await Promise.all([
    getDoc(doc(db, 'workspaces', workspaceId)),
    getDoc(doc(db, 'users', uid)),
    Promise.all(EXPORT_COLLECTIONS.map((name) => getDocs(query(collection(db, name), where('workspaceId', '==', workspaceId)))))
  ])
  if (!workspaceSnap.exists()) throw new Error('No se encontró el espacio de trabajo activo.')

  const collections = Object.fromEntries(
    EXPORT_COLLECTIONS.map((name, index) => [name, toRecords(collectionSnaps[index])])
  ) as Record<ExportCollection, ExportRecord[]>

  const budgetCategoryCaps = Object.fromEntries(
    await Promise.all(
      collections.budgets.map(async (budget) => [
        budget.id,
        toRecords(await getDocs(collection(db, 'budgets', budget.id, 'categoryCaps')))
      ] as const)
    )
  )

  return buildWorkspaceExport({
    now: new Date(),
    workspace: { id: workspaceSnap.id, ...workspaceSnap.data() },
    profile: profileSnap.exists() ? profileSnap.data() : null,
    collections,
    budgetCategoryCaps
  })
}
