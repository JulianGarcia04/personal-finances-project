<template>
  <span :class="['inline-flex items-center', layout === 'stacked' ? 'gap-3' : 'gap-2.5']">
    <svg :class="['shrink-0', markClass]" viewBox="10 10 44 44" aria-hidden="true">
      <defs>
        <linearGradient
          :id="gradientId"
          :x1="LYNOR_MARK_GRADIENT.from.x"
          :y1="LYNOR_MARK_GRADIENT.from.y"
          :x2="LYNOR_MARK_GRADIENT.to.x"
          :y2="LYNOR_MARK_GRADIENT.to.y"
          gradientUnits="userSpaceOnUse"
        >
          <stop v-for="stop in LYNOR_MARK_GRADIENT.stops" :key="stop.offset" :offset="stop.offset" :stop-color="stop.color" />
        </linearGradient>
      </defs>
      <path v-for="d in LYNOR_MARK_PATHS" :key="d" :d="d" :fill="`url(#${gradientId})`" />
    </svg>
    <span
      v-if="layout !== 'mark'"
      :class="['font-display font-bold tracking-tight', layout === 'stacked' ? 'flex flex-col leading-none gap-1' : 'flex items-baseline gap-1.5']"
    >
      <span class="text-text-primary">Lynor</span>
      <span class="text-accent-emerald">Finanzas</span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { useId } from 'vue'
import { LYNOR_MARK_GRADIENT, LYNOR_MARK_PATHS } from '@/lib/brand'

withDefaults(defineProps<{ layout?: 'inline' | 'stacked' | 'mark'; markClass?: string }>(), {
  layout: 'inline',
  markClass: 'w-8 h-8'
})

// Unique per instance: a gradient defined inside a hidden copy (the mobile header
// on desktop) would leave every other symbol that points at its id unpainted.
const gradientId = `lynor-mark-${useId()}`
</script>
