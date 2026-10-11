import { onBeforeUnmount, watch, type Ref } from 'vue'

// Reference-counted lock so stacked overlays (drawer + sheet) do not release each other's lock.
let lockCount = 0
let previousOverflow = ''

function lock() {
  if (lockCount === 0) {
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  lockCount++
}

function unlock() {
  if (lockCount === 0) return
  lockCount--
  if (lockCount === 0) {
    document.body.style.overflow = previousOverflow
  }
}

/** Locks body scroll while `active` is true; releases on unmount. */
export function useBodyScrollLock(active: Ref<boolean> | (() => boolean)) {
  let held = false

  watch(
    active,
    (value) => {
      if (value && !held) {
        lock()
        held = true
      } else if (!value && held) {
        unlock()
        held = false
      }
    },
    { immediate: true }
  )

  onBeforeUnmount(() => {
    if (held) {
      unlock()
      held = false
    }
  })
}
