<template>
  <!-- Not a <form>: it is rendered inside other forms (budget sheet, transaction form). -->
  <div
    role="group"
    class="space-y-3 rounded-xl border border-accent-emerald/20 bg-slate-950/60 p-3"
    aria-label="Nueva categoría"
    @keydown.esc.stop.prevent="emit('cancel')"
  >
    <div class="flex items-center justify-between gap-2">
      <h5 class="text-xs font-semibold text-text-primary">Nueva categoría</h5>
      <span class="max-w-[60%] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border border-white/10 bg-slate-900/60 text-text-primary">
        <component :is="getCategoryIconComponent(icon)" class="w-3.5 h-3.5 shrink-0" :style="{ color }" />
        <span class="min-w-0 truncate">{{ name.trim() || 'Vista previa' }}</span>
      </span>
    </div>

    <label class="block space-y-1">
      <span class="block text-[11px] font-semibold text-text-secondary">Nombre</span>
      <input
        ref="nameInputRef"
        v-model="name"
        type="text"
        maxlength="30"
        required
        class="field"
        placeholder="Ej. Mascotas, Gimnasio"
        @keydown.enter.prevent="submit"
      />
    </label>

    <div class="space-y-1.5">
      <span class="block text-[11px] font-semibold text-text-secondary">Icono</span>
      <div class="grid grid-cols-7 gap-1.5">
        <button
          v-for="option in visibleIcons"
          :key="option.name"
          type="button"
          :title="option.label"
          :aria-label="option.label"
          :aria-pressed="icon === option.name"
          :class="[
            'min-h-10 rounded-lg flex items-center justify-center border transition-all cursor-pointer',
            icon === option.name
              ? 'border-accent-emerald/40 bg-accent-emerald/10 text-accent-emerald'
              : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-white/5'
          ]"
          @click="icon = option.name"
        >
          <component :is="getCategoryIconComponent(option.name)" class="w-4 h-4" />
        </button>
      </div>
      <button
        v-if="!showAllIcons"
        type="button"
        class="text-[11px] font-semibold text-accent-emerald hover:underline cursor-pointer"
        @click="showAllIcons = true"
      >
        Ver más iconos
      </button>
    </div>

    <div class="space-y-1.5">
      <span class="block text-[11px] font-semibold text-text-secondary">Color</span>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="option in CATEGORY_COLORS"
          :key="option"
          type="button"
          :aria-label="`Color ${option}`"
          :aria-pressed="color === option"
          :style="{ backgroundColor: option }"
          :class="[
            'w-8 h-8 rounded-full border transition-all cursor-pointer',
            color === option ? 'border-white scale-110 shadow-lg' : 'border-transparent hover:scale-105'
          ]"
          @click="color = option"
        ></button>
      </div>
    </div>

    <p v-if="error" role="alert" class="text-[11px] text-accent-rose">{{ error }}</p>

    <div class="flex gap-2">
      <button
        type="button"
        class="flex-1 min-h-10 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 text-xs font-semibold cursor-pointer"
        @click="emit('cancel')"
      >
        Cancelar
      </button>
      <button
        type="button"
        :disabled="saving"
        class="flex-1 min-h-10 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background text-xs font-semibold cursor-pointer disabled:opacity-50"
        @click="submit"
      >
        {{ saving ? 'Creando…' : 'Crear categoría' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import type { Category } from '@/types'
import { CategorySchema } from '@/schemas'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { CATEGORY_COLORS, CATEGORY_ICONS, getCategoryIconComponent } from '@/lib/categoryIcons'
import { findCategoryByName } from '@/lib/categoryPicker'

const props = withDefaults(defineProps<{
  initialName?: string
  type?: Category['type']
}>(), {
  initialName: '',
  type: 'expense'
})

const emit = defineEmits<{
  created: [category: Category]
  cancel: []
}>()

const transactionsStore = useTransactionsStore()

const name = ref(props.initialName.trim())
const icon = ref('HelpCircle')
// Start with a colour no existing category uses yet, so the new one stands out.
const color = ref(
  CATEGORY_COLORS.find(option => !transactionsStore.categories.some(category => category.color === option))
    ?? CATEGORY_COLORS[0]
)
const showAllIcons = ref(false)
const saving = ref(false)
const error = ref('')
const nameInputRef = ref<HTMLInputElement | null>(null)

const visibleIcons = computed(() => showAllIcons.value ? CATEGORY_ICONS : CATEGORY_ICONS.slice(0, 14))

onMounted(async () => {
  await nextTick()
  nameInputRef.value?.focus()
  nameInputRef.value?.select()
})

const submit = async () => {
  if (saving.value) return
  error.value = ''
  const draft = { name: name.value.trim(), icon: icon.value, color: color.value, type: props.type }
  const validation = CategorySchema.safeParse(draft)
  if (!validation.success) {
    error.value = validation.error.errors[0].message
    return
  }
  const existing = findCategoryByName(transactionsStore.categories, draft.name)
  if (existing) {
    error.value = `Ya existe una categoría llamada «${existing.name}».`
    return
  }
  saving.value = true
  try {
    emit('created', await transactionsStore.addCategory(draft))
  } catch {
    error.value = 'No se pudo crear la categoría. Inténtalo de nuevo.'
  } finally {
    saving.value = false
  }
}
</script>
