<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, useId, useTemplateRef, watch } from 'vue'
import { TriangleAlert } from 'lucide-vue-next'
import { useBodyScrollLock } from './useBodyScrollLock'
import type { ConfirmationRequest } from '@/stores/notificationsStore'

// Promise-backed confirmation modal following the BaseSheet pattern, stacked above sheets (z-60)
// and the onboarding overlay (z-70) because it is often requested from inside a sheet.
const props = defineProps<{ request: ConfirmationRequest | null }>()
const emit = defineEmits<{ resolve: [confirmed: boolean] }>()

const titleId = `confirm-title-${useId()}`
const messageId = `confirm-message-${useId()}`
const cancelButton = useTemplateRef<HTMLButtonElement>('cancelButton')
const confirmButton = useTemplateRef<HTMLButtonElement>('confirmButton')
const isDanger = computed(() => props.request?.tone === 'danger')
let restoreFocusTo: HTMLElement | null = null

useBodyScrollLock(() => props.request !== null)

// Capture phase on the document runs before BaseSheet's listener, so Escape answers only the
// confirmation and the sheet underneath stays open.
const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    emit('resolve', false)
  } else if (event.key === 'Tab') {
    const actions = [cancelButton.value, confirmButton.value].filter((node): node is HTMLButtonElement => node !== null)
    if (actions.length === 0) return
    event.preventDefault()
    const current = actions.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.shiftKey ? (current <= 0 ? actions.length - 1 : current - 1) : (current + 1) % actions.length
    actions[next].focus()
  }
}

watch(
  () => props.request?.id ?? null,
  async (id, previousId) => {
    if (id !== null) {
      if (previousId == null) {
        restoreFocusTo = document.activeElement as HTMLElement | null
        document.addEventListener('keydown', onKeydown, true)
      }
      await nextTick()
      // Destructive requests start on the safe action.
      const initial = isDanger.value ? cancelButton.value : confirmButton.value
      initial?.focus({ preventScroll: true })
    } else if (previousId != null) {
      document.removeEventListener('keydown', onKeydown, true)
      restoreFocusTo?.focus?.({ preventScroll: true })
      restoreFocusTo = null
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div
        v-if="request"
        class="fixed inset-0 z-[80] flex items-end sm:items-center justify-center sm:p-4 bg-black/70 backdrop-blur-xs"
        @click.self="emit('resolve', false)"
      >
        <div
          role="alertdialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          :aria-describedby="messageId"
          tabindex="-1"
          class="sheet-panel relative w-full sm:max-w-md glass-panel border border-white/10 shadow-2xl outline-none rounded-t-3xl sm:rounded-2xl px-5 pt-6 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:p-6"
        >
          <div class="flex items-start gap-3">
            <span
              v-if="isDanger"
              class="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-accent-rose/10 text-accent-rose"
              aria-hidden="true"
            >
              <TriangleAlert class="w-5 h-5" />
            </span>
            <div class="min-w-0 flex-1">
              <h2 :id="titleId" class="font-display font-bold text-lg sm:text-xl text-text-primary break-words">{{ request.title }}</h2>
              <p :id="messageId" class="mt-2 text-sm text-text-secondary whitespace-pre-line break-words">{{ request.message }}</p>
            </div>
          </div>

          <div class="mt-6 flex flex-col-reverse sm:flex-row gap-3">
            <button
              ref="cancelButton"
              type="button"
              class="flex-1 min-h-11 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all"
              @click="emit('resolve', false)"
            >
              {{ request.cancelLabel }}
            </button>
            <button
              ref="confirmButton"
              type="button"
              :class="[
                'flex-1 min-h-11 py-2.5 rounded-xl font-display font-semibold text-sm cursor-pointer transition-all',
                isDanger
                  ? 'bg-accent-rose hover:bg-accent-rose-hover text-white shadow-glow-rose'
                  : 'bg-accent-emerald hover:bg-accent-emerald-hover text-background shadow-glow-emerald'
              ]"
              @click="emit('resolve', true)"
            >
              {{ request.confirmLabel }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
