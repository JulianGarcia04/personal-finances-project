import { defineStore } from 'pinia'

/**
 * App-wide toasts and confirmation modal, rendered by `NotificationHost` (mounted once in `App.vue`).
 *
 * Toasts: `success`, `error` and `info` show a message that auto-dismisses after
 * `TOAST_DURATIONS_MS[kind]` (errors stay longer) or when dismissed by hand. An identical
 * message of the same kind that is still visible is not duplicated: its timer restarts.
 * At most `MAX_VISIBLE_TOASTS` stay visible; a new one pushes out the oldest.
 *
 * Confirmation: `confirm(options)` opens a modal and resolves `true` (confirm) or `false`
 * (cancel, Escape or backdrop). Only one is open at a time: a request made while another is
 * open resolves `false` at once and is never shown, so a double tap cannot confirm twice.
 */

export type ToastKind = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

export type ConfirmTone = 'danger' | 'default'

export interface ConfirmOptions {
  title: string
  message: string
  /** Defaults to "Confirmar". */
  confirmLabel?: string
  /** Defaults to "Cancelar". */
  cancelLabel?: string
  /** `danger` styles the confirm action as destructive and focuses the cancel action first. */
  tone?: ConfirmTone
}

export interface ConfirmationRequest extends Required<ConfirmOptions> {
  id: number
}

export const TOAST_DURATIONS_MS: Readonly<Record<ToastKind, number>> = { success: 4000, info: 4000, error: 8000 }
export const MAX_VISIBLE_TOASTS = 3

interface NotificationsState {
  toasts: Toast[]
  confirmation: ConfirmationRequest | null
}

// Timers and resolvers are not state: they never render and cannot be serialized.
let nextId = 1
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()
const confirmationResolvers = new Map<number, (confirmed: boolean) => void>()

const clearToastTimer = (id: number) => {
  clearTimeout(toastTimers.get(id))
  toastTimers.delete(id)
}

export const useNotificationsStore = defineStore('notifications', {
  state: (): NotificationsState => ({
    toasts: [],
    confirmation: null
  }),

  actions: {
    /** Shows a success toast and returns its id. */
    success(message: string): number {
      return this.showToast('success', message)
    },

    /** Shows an error toast (announced assertively, stays longer) and returns its id. */
    error(message: string): number {
      return this.showToast('error', message)
    },

    /** Shows a neutral notice and returns its id. */
    info(message: string): number {
      return this.showToast('info', message)
    },

    showToast(kind: ToastKind, message: string): number {
      const existing = this.toasts.find(toast => toast.kind === kind && toast.message === message)
      const id = existing?.id ?? nextId++
      if (!existing) {
        this.toasts.push({ id, kind, message })
        while (this.toasts.length > MAX_VISIBLE_TOASTS) {
          const oldest = this.toasts.shift()
          if (oldest) clearToastTimer(oldest.id)
        }
      }
      clearToastTimer(id)
      toastTimers.set(id, setTimeout(() => this.dismiss(id), TOAST_DURATIONS_MS[kind]))
      return id
    },

    /** Removes a toast; unknown ids are ignored. */
    dismiss(id: number) {
      clearToastTimer(id)
      this.toasts = this.toasts.filter(toast => toast.id !== id)
    },

    /** Asks the user to confirm; resolves `false` at once if another confirmation is open. */
    confirm(options: ConfirmOptions): Promise<boolean> {
      if (this.confirmation) return Promise.resolve(false)
      const id = nextId++
      this.confirmation = {
        id,
        title: options.title,
        message: options.message,
        confirmLabel: options.confirmLabel ?? 'Confirmar',
        cancelLabel: options.cancelLabel ?? 'Cancelar',
        tone: options.tone ?? 'default'
      }
      return new Promise<boolean>(resolve => { confirmationResolvers.set(id, resolve) })
    },

    /** Answers the open confirmation (used by the host); a no-op when none is open. */
    resolveConfirmation(confirmed: boolean) {
      const open = this.confirmation
      if (!open) return
      this.confirmation = null
      const resolve = confirmationResolvers.get(open.id)
      confirmationResolvers.delete(open.id)
      resolve?.(confirmed)
    }
  }
})
