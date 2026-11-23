/** Shown instead of a Firestore permission error when a movement's account no longer exists. */
export const DELETED_ACCOUNT_HISTORY_MESSAGE =
  'La cuenta de este movimiento fue eliminada. Se conserva como historial y no se puede editar ni eliminar.'

interface MovementAccountReference {
  workspaceId?: string | null
  type?: string | null
  accountId?: string | null
  toAccountId?: string | null
}

/**
 * True when the movement's source account, or a transfer's destination, is missing from the
 * loaded accounts of the movement's own workspace. `loadedWorkspaceId` is the workspace whose
 * accounts are fully loaded and active (null while loading or switching): nothing counts as
 * deleted until then, and a movement from another workspace is never judged against them.
 */
export function referencesDeletedAccount(
  movement: MovementAccountReference,
  accounts: ReadonlyArray<{ id: string }>,
  loadedWorkspaceId: string | null
): boolean {
  if (!loadedWorkspaceId || movement.workspaceId !== loadedWorkspaceId) return false
  const accountIds = new Set(accounts.map(account => account.id))
  if (typeof movement.accountId !== 'string' || !accountIds.has(movement.accountId)) return true
  return movement.type === 'transfer' && typeof movement.toAccountId === 'string' &&
    movement.toAccountId.length > 0 && !accountIds.has(movement.toAccountId)
}
