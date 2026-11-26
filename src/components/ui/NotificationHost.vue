<script setup lang="ts">
import { computed, type Component } from 'vue'
import { CircleAlert, CircleCheck, Info, X as XIcon } from 'lucide-vue-next'
import ConfirmDialog from './ConfirmDialog.vue'
import { useNotificationsStore, type Toast, type ToastKind } from '@/stores/notificationsStore'

// Renders the app-wide toasts and confirmation. Mounted once in App.vue for every auth state.
const notifications = useNotificationsStore()

// Live regions exist before any toast arrives so screen readers announce additions.
// Errors interrupt (assertive alert); success and info wait for a pause (polite status).
const regions = computed<{ live: 'assertive' | 'polite'; role: 'alert' | 'status'; toasts: Toast[] }[]>(() => [
  { live: 'assertive', role: 'alert', toasts: notifications.toasts.filter(toast => toast.kind === 'error') },
  { live: 'polite', role: 'status', toasts: notifications.toasts.filter(toast => toast.kind !== 'error') }
])

const toastStyles: Record<ToastKind, { icon: Component; iconClass: string; borderClass: string }> = {
  success: { icon: CircleCheck, iconClass: 'text-accent-emerald', borderClass: 'border-accent-emerald/30' },
  error: { icon: CircleAlert, iconClass: 'text-accent-rose', borderClass: 'border-accent-rose/30' },
  info: { icon: Info, iconClass: 'text-text-secondary', borderClass: 'border-white/10' }
}
</script>

<template>
  <Teleport to="body">
    <!-- Below lg: top of the screen, clear of the notch and the bottom tab bar. From lg: bottom right. -->
    <div
      class="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[90] flex flex-col items-center gap-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] lg:inset-x-auto lg:top-auto lg:right-6 lg:bottom-6 lg:w-96 lg:items-end lg:p-0"
    >
      <div
        v-for="region in regions"
        :key="region.live"
        :role="region.role"
        :aria-live="region.live"
        class="flex w-full max-w-sm flex-col gap-2"
      >
        <TransitionGroup
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          enter-from-class="opacity-0 -translate-y-2 lg:translate-y-2"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          leave-to-class="opacity-0"
        >
          <div
            v-for="toast in region.toasts"
            :key="toast.id"
            :class="[
              'pointer-events-auto flex items-start gap-3 rounded-2xl glass-panel border backdrop-blur-md shadow-2xl pl-4 pr-1 py-1',
              toastStyles[toast.kind].borderClass
            ]"
          >
            <component
              :is="toastStyles[toast.kind].icon"
              :class="['mt-3 w-5 h-5 shrink-0', toastStyles[toast.kind].iconClass]"
              aria-hidden="true"
            />
            <p class="flex-1 min-w-0 py-3 text-sm text-text-primary break-words">{{ toast.message }}</p>
            <button
              type="button"
              aria-label="Cerrar notificación"
              class="tap shrink-0 flex items-center justify-center rounded-xl text-text-secondary hover:text-text-primary hover:bg-white/5 active:bg-white/10 transition-all"
              @click="notifications.dismiss(toast.id)"
            >
              <XIcon class="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </TransitionGroup>
      </div>
    </div>
  </Teleport>

  <ConfirmDialog :request="notifications.confirmation" @resolve="notifications.resolveConfirmation($event)" />
</template>
