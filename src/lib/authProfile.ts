// Pure builders and messages shared by every sign-in path (email and Google).

export const PASSWORD_RESET_NOTICE = 'Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña.'

const DEFAULT_CURRENCY = 'USD'

export function buildPersonalWorkspace(uid: string, workspaceId: string, now: Date) {
  return {
    id: workspaceId,
    name: 'Personal',
    ownerId: uid,
    members: [uid],
    currency: DEFAULT_CURRENCY,
    createdAt: now.toISOString()
  }
}

export function buildUserProfile(input: {
  uid: string
  email: string | null
  displayName: string
  workspaceId: string
  now: Date
  legalConsent?: unknown
}) {
  return {
    uid: input.uid,
    email: input.email,
    displayName: input.displayName,
    currency: DEFAULT_CURRENCY,
    createdAt: input.now,
    activeWorkspaceId: input.workspaceId,
    workspaces: [input.workspaceId],
    ...(input.legalConsent === undefined ? {} : { legalConsent: input.legalConsent })
  }
}

export function resolveDisplayName(displayName: string | null | undefined, email: string | null | undefined): string {
  return displayName || (email ? email.split('@')[0] : 'Usuario')
}

export type AuthFlow = 'email' | 'google' | 'reset'

// Email sign-in and signup keep the messages they always showed.
const EMAIL_MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'Correo o contraseña incorrectos.',
  'auth/email-already-in-use': 'El correo electrónico ya está registrado.',
  'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.'
}

// Google sign-in and password recovery also translate the failures they hit.
const GOOGLE_AND_RESET_MESSAGES: Record<string, string> = {
  ...EMAIL_MESSAGES,
  'auth/invalid-email': 'El correo electrónico no es válido.',
  'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.',
  'auth/popup-blocked': 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes e inténtalo de nuevo.',
  'auth/account-exists-with-different-credential': 'Ya existe una cuenta con este correo. Ingresa con tu correo y contraseña.',
  // The user closed or replaced the Google popup: nothing to report.
  'auth/popup-closed-by-user': '',
  'auth/cancelled-popup-request': ''
}

/** User-facing message for an auth failure; empty when there is nothing to show. */
export function authErrorMessage(error: unknown, flow: AuthFlow): string {
  const messages = flow === 'email' ? EMAIL_MESSAGES : GOOGLE_AND_RESET_MESSAGES
  const err = (error ?? {}) as { code?: string; message?: string }
  if (err.code && err.code in messages) return messages[err.code]
  return err.message || 'Ocurrió un error inesperado.'
}
