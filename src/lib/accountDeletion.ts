// Word the user types to confirm deleting their account. The server function requires it too.
export const ACCOUNT_DELETION_CONFIRMATION = 'ELIMINAR'

export function isDeletionConfirmed(input: string): boolean {
  return input.trim().toUpperCase() === ACCOUNT_DELETION_CONFIRMATION
}
