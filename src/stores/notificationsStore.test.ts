import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createPinia, disposePinia } from 'pinia'
import {
  MAX_VISIBLE_TOASTS,
  TOAST_DURATIONS_MS,
  useNotificationsStore
} from './notificationsStore.ts'

// Real store over a fresh Pinia with mocked timers, so auto-dismiss is deterministic.
const loadStore = (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  return useNotificationsStore(pinia)
}
const visible = (store: ReturnType<typeof useNotificationsStore>) =>
  store.toasts.map(toast => [toast.kind, toast.message])

test('S7: success, error and info add a toast of their kind and return its id', t => {
  const store = loadStore(t)
  const ids = [store.success('Cuenta creada.'), store.error('No se pudo guardar.'), store.info('Sin cambios.')]
  assert.deepEqual(visible(store), [['success', 'Cuenta creada.'], ['error', 'No se pudo guardar.'], ['info', 'Sin cambios.']])
  assert.deepEqual(store.toasts.map(toast => toast.id), ids)
  assert.equal(new Set(ids).size, 3)
})

test('S7: toasts auto-dismiss after their duration and errors stay longer', t => {
  const store = loadStore(t)
  assert.ok(TOAST_DURATIONS_MS.error > TOAST_DURATIONS_MS.success, 'errors stay longer than success')
  assert.ok(TOAST_DURATIONS_MS.error > TOAST_DURATIONS_MS.info, 'errors stay longer than info')
  store.success('Guardado.')
  store.info('Aviso.')
  store.error('Falló.')
  t.mock.timers.tick(Math.max(TOAST_DURATIONS_MS.success, TOAST_DURATIONS_MS.info) - 1)
  assert.equal(store.toasts.length, 3, 'nothing leaves before its time')
  t.mock.timers.tick(1)
  assert.deepEqual(visible(store), [['error', 'Falló.']])
  t.mock.timers.tick(TOAST_DURATIONS_MS.error - Math.max(TOAST_DURATIONS_MS.success, TOAST_DURATIONS_MS.info))
  assert.deepEqual(store.toasts, [])
})

test('S7: a toast can be dismissed manually and its timer no longer touches the stack', t => {
  const store = loadStore(t)
  const id = store.error('Falló.')
  store.dismiss(id)
  assert.deepEqual(store.toasts, [])
  const again = store.error('Falló.')
  assert.notEqual(again, id, 'a new toast gets a new id')
  t.mock.timers.tick(TOAST_DURATIONS_MS.error - 1)
  assert.deepEqual(visible(store), [['error', 'Falló.']], 'the first timer was cleared')
  store.dismiss(12345)
  assert.equal(store.toasts.length, 1, 'dismissing an unknown id is a no-op')
})

test('S7: an identical message already on screen is not duplicated and its timer restarts', t => {
  const store = loadStore(t)
  const first = store.error('No se pudo guardar.')
  t.mock.timers.tick(TOAST_DURATIONS_MS.error - 1000)
  const second = store.error('No se pudo guardar.')
  assert.equal(second, first, 'the visible toast is reused')
  assert.deepEqual(visible(store), [['error', 'No se pudo guardar.']])
  t.mock.timers.tick(1000)
  assert.equal(store.toasts.length, 1, 'the repeat restarted the timer')
  t.mock.timers.tick(TOAST_DURATIONS_MS.error - 1000)
  assert.deepEqual(store.toasts, [])
  store.success('No se pudo guardar.')
  store.error('No se pudo guardar.')
  assert.equal(store.toasts.length, 2, 'the same text with another kind is a different toast')
})

test('S7: the visible stack is capped and the oldest toast leaves first', t => {
  const store = loadStore(t)
  const messages = Array.from({ length: MAX_VISIBLE_TOASTS + 2 }, (_, index) => `Aviso ${index + 1}`)
  messages.forEach(message => store.info(message))
  assert.equal(store.toasts.length, MAX_VISIBLE_TOASTS)
  assert.deepEqual(store.toasts.map(toast => toast.message), messages.slice(-MAX_VISIBLE_TOASTS))
  t.mock.timers.tick(TOAST_DURATIONS_MS.info)
  assert.deepEqual(store.toasts, [], 'dropped toasts leave no timers behind that could remove newer ones')
})

test('S7: confirm opens one request with Spanish defaults and resolves true when confirmed', async t => {
  const store = loadStore(t)
  assert.equal(store.confirmation, null)
  const answer = store.confirm({ title: '¿Eliminar cuenta?', message: 'No se puede deshacer.' })
  assert.deepEqual(
    { ...store.confirmation, id: undefined },
    { id: undefined, title: '¿Eliminar cuenta?', message: 'No se puede deshacer.', confirmLabel: 'Confirmar', cancelLabel: 'Cancelar', tone: 'default' }
  )
  store.resolveConfirmation(true)
  assert.equal(await answer, true)
  assert.equal(store.confirmation, null)
  store.resolveConfirmation(false)
  assert.equal(store.confirmation, null, 'resolving with nothing open is a no-op')
})

test('S7: confirm resolves false when cancelled and keeps custom labels and tone', async t => {
  const store = loadStore(t)
  const answer = store.confirm({ title: 'Eliminar', message: '¿Seguro?', confirmLabel: 'Eliminar', cancelLabel: 'Volver', tone: 'danger' })
  assert.equal(store.confirmation?.confirmLabel, 'Eliminar')
  assert.equal(store.confirmation?.cancelLabel, 'Volver')
  assert.equal(store.confirmation?.tone, 'danger')
  store.resolveConfirmation(false)
  assert.equal(await answer, false)
})

test('S7: a second confirm while one is open resolves false at once and leaves the open one untouched', async t => {
  const store = loadStore(t)
  const first = store.confirm({ title: 'Primera', message: 'A' })
  const openId = store.confirmation?.id
  assert.equal(await store.confirm({ title: 'Segunda', message: 'B' }), false, 'the duplicate is refused')
  assert.equal(store.confirmation?.id, openId)
  assert.equal(store.confirmation?.title, 'Primera')
  store.resolveConfirmation(true)
  assert.equal(await first, true)
  const third = store.confirm({ title: 'Tercera', message: 'C' })
  assert.equal(store.confirmation?.title, 'Tercera', 'a new request opens once the previous one is answered')
  store.resolveConfirmation(false)
  assert.equal(await third, false)
})
