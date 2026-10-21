/* global importScripts, firebase, clients */
// Firebase Cloud Messaging service worker for Vault web push.
// The Firebase web config is passed by the app as query params when it
// registers this worker (see src/lib/push.ts); nothing project-specific is
// hardcoded here. Keep the SDK version in sync with the `firebase` package.

const DEFAULT_LINK = '/goals'

// Registered before the Firebase scripts so it runs first. Notifications the
// FCM SDK displayed itself (payload with `notification`) carry FCM_MSG; when
// they have an absolute fcmOptions.link / click_action the SDK opens it,
// otherwise we fall back to the relative `data.link` the server sends.
self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {}
  const fcm = data.FCM_MSG
  if (fcm && (event.action || (fcm.fcmOptions && fcm.fcmOptions.link) ||
      (fcm.notification && fcm.notification.click_action))) return
  if (fcm) event.stopImmediatePropagation()
  event.notification.close()
  const link = fcm ? fcm.data && fcm.data.link : data.link
  const target = new URL(link || DEFAULT_LINK, self.location.origin)
  if (target.origin !== self.location.origin) return
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if (new URL(client.url).origin === target.origin && 'focus' in client) {
        await client.focus()
        if ('navigate' in client) {
          try { await client.navigate(target.href) } catch { /* uncontrolled client */ }
        }
        return
      }
    }
    await clients.openWindow(target.href)
  })())
})

importScripts('https://www.gstatic.com/firebasejs/12.14.0/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/12.14.0/firebase-messaging-compat.js')

const params = new URL(self.location.href).searchParams
const config = {
  apiKey: params.get('apiKey'),
  authDomain: params.get('authDomain'),
  projectId: params.get('projectId'),
  storageBucket: params.get('storageBucket'),
  messagingSenderId: params.get('messagingSenderId'),
  appId: params.get('appId')
}

if (config.apiKey && config.projectId && config.messagingSenderId && config.appId) {
  firebase.initializeApp(config)
  const messaging = firebase.messaging()

  messaging.onBackgroundMessage((payload) => {
    // Payloads with a `notification` block are already shown by the SDK.
    if (payload.notification) return
    const data = payload.data || {}
    const title = data.title || 'Vault'
    return self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || undefined,
      data: { link: data.link || DEFAULT_LINK }
    })
  })
} else {
  console.warn('[firebase-messaging-sw] Missing Firebase config params; push disabled.')
}
