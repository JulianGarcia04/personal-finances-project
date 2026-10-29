<template>
  <div class="min-h-screen min-h-dvh px-4 pt-[calc(2rem+env(safe-area-inset-top))] pb-[calc(2rem+env(safe-area-inset-bottom))]">
    <article class="max-w-3xl mx-auto glass-panel rounded-3xl p-6 sm:p-8 md:p-10 border border-white/5">
      <slot name="back" />

      <p v-if="isDraft" class="mt-4 text-xs text-accent-rose font-medium bg-accent-rose/10 px-3 py-2 rounded-lg border border-accent-rose/20">
        Borrador: faltan los datos del responsable y la revisión legal.
      </p>

      <h1 class="mt-4 font-display font-bold text-2xl sm:text-3xl text-text-primary tracking-tight">{{ document.title }}</h1>
      <p class="mt-2 text-sm text-text-secondary">Vigente desde el {{ document.effectiveLabel }} · versión {{ document.version }}</p>

      <section v-for="section in document.sections" :key="section.heading" class="mt-8">
        <h2 class="font-display font-semibold text-lg text-text-primary">{{ section.heading }}</h2>
        <p
          v-for="(paragraph, index) in section.paragraphs"
          :key="index"
          class="mt-3 text-sm leading-relaxed text-text-secondary"
        >
          {{ paragraph }}
        </p>
      </section>
    </article>
  </div>
</template>

<script setup lang="ts">
import type { LegalDocument } from '@/lib/legal'

// Presentational: the app passes a router link as `back`, the static site a plain link.
defineProps<{ document: LegalDocument; isDraft: boolean }>()
</script>
