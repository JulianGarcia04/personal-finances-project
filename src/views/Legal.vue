<template>
  <LegalDocument :document="document" :is-draft="isDraft">
    <template #back>
      <router-link
        :to="backTarget"
        class="inline-flex items-center min-h-11 text-sm text-accent-emerald hover:text-accent-emerald-hover font-semibold transition-colors"
      >
        ← Volver
      </router-link>
    </template>
  </LegalDocument>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAuthStore } from '@/stores/authStore'
import LegalDocument from '@/components/LegalDocument.vue'
import { LEGAL_DOCUMENTS, hasPendingPlaceholders, type LegalDocumentId } from '@/lib/legal'

const props = defineProps<{ doc: LegalDocumentId }>()

const authStore = useAuthStore()
const document = computed(() => LEGAL_DOCUMENTS[props.doc])
const isDraft = hasPendingPlaceholders()
const backTarget = computed(() => (authStore.isAuthenticated ? { name: 'Settings', query: { tab: 'data' } } : { name: 'Login' }))
</script>
