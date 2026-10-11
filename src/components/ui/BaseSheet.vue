<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div
        v-if="open"
        class="fixed inset-0 z-[60] flex items-end sm:items-center justify-center sm:p-4 bg-black/70 backdrop-blur-xs"
        @click.self="emit('close')"
      >
        <div
          ref="panelRef"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="title || $slots.header ? titleId : undefined"
          tabindex="-1"
          :class="[
            'sheet-panel relative flex flex-col w-full glass-panel border border-white/10 shadow-2xl outline-none',
            'rounded-t-3xl max-h-[92dvh] sm:rounded-2xl sm:max-h-[90dvh]',
            size === 'lg' ? 'sm:max-w-lg' : 'sm:max-w-md',
            panelClass
          ]"
        >
          <!-- Drag affordance (mobile only, decorative) -->
          <div class="sm:hidden flex justify-center pt-2" aria-hidden="true">
            <div class="w-10 h-1 rounded-full bg-white/15"></div>
          </div>

          <!-- Sticky header -->
          <header class="shrink-0 flex items-start justify-between gap-3 px-5 pt-3 pb-3 sm:px-6 sm:pt-5 border-b border-white/5">
            <div :id="titleId" class="min-w-0 flex-1 pt-2">
              <slot name="header">
                <h3 class="font-display font-bold text-xl sm:text-2xl text-text-primary truncate">{{ title }}</h3>
              </slot>
            </div>
            <button
              type="button"
              @click="emit('close')"
              aria-label="Cerrar"
              class="tap -mr-2 shrink-0 flex items-center justify-center rounded-xl text-text-secondary hover:text-text-primary hover:bg-white/5 active:bg-white/10 transition-all"
            >
              <XIcon class="w-5 h-5" />
            </button>
          </header>

          <!-- Scrollable body -->
          <div class="flex-1 min-h-0 overflow-y-auto overscroll-contain custom-scrollbar px-5 py-4 sm:px-6 sm:py-5">
            <slot />
          </div>

          <!-- Sticky footer -->
          <footer
            v-if="$slots.footer"
            class="shrink-0 px-5 pt-3 sm:px-6 sm:pb-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] border-t border-white/5"
          >
            <slot name="footer" />
          </footer>
          <div v-else class="sm:hidden shrink-0 pb-safe" aria-hidden="true"></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, toRef, useId, watch } from 'vue'
import { X as XIcon } from 'lucide-vue-next'
import { useBodyScrollLock } from './useBodyScrollLock'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    size?: 'md' | 'lg'
    /** Extra classes for the panel (e.g. a themed border or `mirror-ledger`). */
    panelClass?: string
  }>(),
  { title: undefined, size: 'md', panelClass: '' }
)

const emit = defineEmits<{ close: [] }>()

const titleId = `sheet-title-${useId()}`
const panelRef = ref<HTMLElement | null>(null)
let previouslyFocused: HTMLElement | null = null

useBodyScrollLock(toRef(props, 'open'))

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      previouslyFocused = document.activeElement as HTMLElement | null
      document.addEventListener('keydown', onKeydown)
      await nextTick()
      panelRef.value?.focus({ preventScroll: true })
    } else {
      document.removeEventListener('keydown', onKeydown)
      previouslyFocused?.focus?.({ preventScroll: true })
      previouslyFocused = null
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>
