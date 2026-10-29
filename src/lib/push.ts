// Web push (Firebase Cloud Messaging) for budget alerts, one opt-in per device.
// Tokens live in users/{uid}/pushTokens/{token}; the server sends to them and
// prunes the ones FCM reports as invalid. FCM has no emulator, so in local
// development this only works with a real VAPID key and project config.
import {
  getMessaging, isSupported, getToken, deleteToken, onMessage,
  type Messaging
} from 'firebase/messaging'
import { doc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore'
import { app, auth, db, firebaseConfig } from '@/lib/firebase'

export type PushStatus = 'enabled' | 'disabled' | 'denied' | 'unsupported' | 'missing-vapid'

const VAPID_KEY: string = import.meta.env.VITE_FIREBASE_VAPID_KEY || ''
const SW_PATH = '/firebase-messaging-sw.js'
const SW_SCOPE = '/firebase-cloud-messaging-push-scope'
const TOKEN_STORAGE_KEY = 'vault.pushToken'

let messagingPromise: Promise<Messaging | null> | null = null
let foregroundUnsubscribe: (() => void) | null = null

// Stored as "<uid> <token>" so a browser shared by several users never reports
// another user's registration as this user's.
function readStoredToken(): string | null {
  try {
    const [owner, token] = (localStorage.getItem(TOKEN_STORAGE_KEY) || '').split(' ')
    return owner && token && owner === auth.currentUser?.uid ? token : null
  } catch {
    return null
  }
}

function writeStoredToken(token: string | null) {
  try {
    const uid = auth.currentUser?.uid
    if (token && uid) localStorage.setItem(TOKEN_STORAGE_KEY, `${uid} ${token}`)
    else localStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    // Storage can be unavailable (private mode); the token doc is the source of truth.
  }
}

/** True when the signed-in user registered this device for push. */
export function hasPushRegistration(): boolean {
  return readStoredToken() !== null
}

function hasBrowserPushApis(): boolean {
  return typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
}

function getMessagingLazy(): Promise<Messaging | null> {
  if (!messagingPromise) {
    messagingPromise = isSupported()
      .then(supported => (supported ? getMessaging(app) : null))
      .catch(() => null)
  }
  return messagingPromise
}

export async function isPushSupported(): Promise<boolean> {
  if (!VAPID_KEY || !hasBrowserPushApis()) return false
  return (await getMessagingLazy()) !== null
}

export async function getPushStatus(): Promise<PushStatus> {
  if (!hasBrowserPushApis() || !(await getMessagingLazy())) return 'unsupported'
  if (!VAPID_KEY) return 'missing-vapid'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission === 'granted' && readStoredToken()) return 'enabled'
  return 'disabled'
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  // The worker reads the (public) web config from its own URL.
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(firebaseConfig)) {
    if (value) params.set(key, String(value))
  }
  const registration = await navigator.serviceWorker.register(`${SW_PATH}?${params}`, { scope: SW_SCOPE })
  await navigator.serviceWorker.ready.catch(() => undefined)
  return registration
}

async function currentToken(messaging: Messaging): Promise<string> {
  const serviceWorkerRegistration = await registerServiceWorker()
  return getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration })
}

/** Asks for permission, registers this device's FCM token and stores it. */
export async function enablePush(uid: string): Promise<PushStatus> {
  if (!VAPID_KEY) return 'missing-vapid'
  const messaging = hasBrowserPushApis() ? await getMessagingLazy() : null
  if (!messaging) return 'unsupported'

  const permission = await Notification.requestPermission()
  if (permission === 'denied') return 'denied'
  if (permission !== 'granted') return 'disabled'

  const token = await currentToken(messaging)
  if (!token) throw new Error('No se pudo obtener el token de notificaciones.')

  const previous = readStoredToken()
  if (previous && previous !== token) {
    await deleteDoc(doc(db, 'users', uid, 'pushTokens', previous)).catch(() => undefined)
  }
  await setDoc(doc(db, 'users', uid, 'pushTokens', token), {
    token,
    userAgent: navigator.userAgent.slice(0, 1024),
    createdAt: serverTimestamp()
  })
  writeStoredToken(token)
  onForegroundMessage()
  return 'enabled'
}

/** Unregisters this device: deletes the FCM token and its Firestore doc. */
export async function disablePush(uid: string): Promise<PushStatus> {
  const messaging = hasBrowserPushApis() ? await getMessagingLazy() : null
  let token = readStoredToken()

  if (messaging && Notification.permission === 'granted') {
    try {
      // Binds our SW registration (getToken returns the cached token) so
      // deleteToken does not fall back to the default, config-less worker.
      const fresh = await currentToken(messaging)
      if (token && fresh && fresh !== token) {
        await deleteDoc(doc(db, 'users', uid, 'pushTokens', fresh)).catch(() => undefined)
      }
      token = token || fresh
      await deleteToken(messaging)
    } catch (err) {
      console.warn('No se pudo revocar el token de notificaciones:', err)
    }
  }
  if (token) await deleteDoc(doc(db, 'users', uid, 'pushTokens', token))
  writeStoredToken(null)
  foregroundUnsubscribe?.()
  foregroundUnsubscribe = null
  return getPushStatus()
}

/**
 * While the tab is visible FCM delivers to the page instead of the worker,
 * so mirror the notification through the SW registration. Idempotent.
 */
export async function onForegroundMessage(): Promise<void> {
  if (foregroundUnsubscribe || !readStoredToken()) return
  const messaging = hasBrowserPushApis() ? await getMessagingLazy() : null
  if (!messaging || foregroundUnsubscribe) return
  foregroundUnsubscribe = onMessage(messaging, async (payload) => {
    if (Notification.permission !== 'granted') return
    const data = payload.data || {}
    const title = payload.notification?.title || data.title || 'Lynor Finanzas'
    const body = payload.notification?.body || data.body || ''
    const link = payload.fcmOptions?.link || data.link || '/goals'
    try {
      const registration = await navigator.serviceWorker.getRegistration(SW_SCOPE)
      await registration?.showNotification(title, {
        body,
        icon: '/icon-192.png',
        tag: data.tag || undefined,
        data: { link }
      })
    } catch (err) {
      console.warn('No se pudo mostrar la notificación:', err)
    }
  })
}
