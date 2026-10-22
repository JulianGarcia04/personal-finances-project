<template>
  <div class="space-y-2.5">
    <!-- Suggested: top spending categories not yet added -->
    <div v-if="suggestions.length" class="space-y-1.5">
      <span class="block text-[10px] font-semibold uppercase tracking-wider text-text-muted">Sugeridas por tu gasto reciente</span>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="category in suggestions"
          :key="category.id"
          type="button"
          class="tap inline-flex items-center gap-1.5 px-2.5 rounded-full border border-white/10 bg-slate-900/60 text-[11px] font-semibold text-text-secondary hover:text-text-primary hover:border-accent-emerald/40 transition-all cursor-pointer"
          :aria-label="`Agregar ${category.name}`"
          @click="choose(category)"
        >
          <PlusIcon class="w-3 h-3 text-accent-emerald" />
          <component :is="getCategoryIconComponent(category.icon)" class="w-3.5 h-3.5" :style="{ color: category.color }" />
          <span class="max-w-[9rem] truncate">{{ category.name }}</span>
        </button>
      </div>
    </div>

    <button
      v-if="!open"
      type="button"
      class="w-full min-h-11 inline-flex items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 text-xs font-semibold text-text-secondary hover:text-accent-emerald hover:border-accent-emerald/40 transition-all cursor-pointer"
      @click="openPicker"
    >
      <PlusIcon class="w-4 h-4" />
      {{ addLabel }}
    </button>

    <div v-else class="space-y-2 rounded-xl border border-white/10 bg-slate-950/50 p-2.5">
      <CategoryQuickCreate
        v-if="creating"
        :initial-name="query"
        :type="createType"
        @created="handleCreated"
        @cancel="closeCreate"
      />
      <template v-else>
        <div class="relative">
          <SearchIcon class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            ref="searchInputRef"
            v-model="query"
            type="text"
            role="combobox"
            aria-autocomplete="list"
            :aria-expanded="true"
            :aria-controls="listboxId"
            :aria-activedescendant="activeOptionId"
            aria-label="Buscar o crear categoría"
            placeholder="Buscar o crear categoría…"
            class="field pl-9"
            @keydown.down.prevent="move(1)"
            @keydown.up.prevent="move(-1)"
            @keydown.enter.prevent="activate(activeIndex)"
            @keydown.esc.stop.prevent="closePicker"
          />
        </div>

        <ul :id="listboxId" role="listbox" aria-label="Categorías" class="max-h-56 overflow-y-auto custom-scrollbar space-y-0.5">
          <li
            v-for="(category, index) in matches"
            :id="`${listboxId}-${index}`"
            :key="category.id"
            role="option"
            :aria-selected="index === activeIndex"
            :class="[
              'flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-xs font-medium cursor-pointer transition-colors',
              index === activeIndex ? 'bg-white/10 text-text-primary' : 'text-text-secondary hover:bg-white/5'
            ]"
            @mousedown.prevent
            @mouseenter="activeIndex = index"
            @click="activate(index)"
          >
            <span class="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center" :style="{ backgroundColor: category.color + '20', color: category.color }">
              <component :is="getCategoryIconComponent(category.icon)" class="w-3.5 h-3.5" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ category.name }}</span>
          </li>
          <li
            v-if="canCreate"
            :id="`${listboxId}-${matches.length}`"
            role="option"
            :aria-selected="activeIndex === matches.length"
            :class="[
              'flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-xs font-semibold cursor-pointer transition-colors text-accent-emerald',
              activeIndex === matches.length ? 'bg-accent-emerald/10' : 'hover:bg-accent-emerald/5'
            ]"
            @mousedown.prevent
            @mouseenter="activeIndex = matches.length"
            @click="activate(matches.length)"
          >
            <span class="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center border border-dashed border-accent-emerald/40">
              <PlusIcon class="w-3.5 h-3.5" />
            </span>
            <span class="min-w-0 flex-1 truncate">Crear «{{ query.trim() }}»</span>
          </li>
        </ul>

        <p v-if="alreadySelected" class="px-1 text-[11px] text-text-muted">«{{ alreadySelected.name }}» ya está agregada.</p>
        <p v-else-if="!matches.length && !canCreate" class="px-1 text-[11px] text-text-muted">
          Ya agregaste todas tus categorías. Escribe un nombre para crear una nueva.
        </p>

        <div class="flex justify-end">
          <button
            type="button"
            class="min-h-9 px-3 rounded-lg text-xs font-semibold text-text-secondary hover:text-text-primary hover:bg-white/5 cursor-pointer"
            @click="closePicker"
          >
            Listo
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { Plus as PlusIcon, Search as SearchIcon } from 'lucide-vue-next'
import type { Category } from '@/types'
import CategoryQuickCreate from '@/components/CategoryQuickCreate.vue'
import { getCategoryIconComponent } from '@/lib/categoryIcons'
import { filterCategories, findCategoryByName } from '@/lib/categoryPicker'

const props = withDefaults(defineProps<{
  categories: Category[]
  selectedIds: string[]
  suggestions?: Category[]
  createType?: Category['type']
  addLabel?: string
}>(), {
  suggestions: () => [],
  createType: 'expense',
  addLabel: 'Agregar categoría'
})

const emit = defineEmits<{ select: [categoryId: string] }>()

const listboxId = `category-picker-${useId()}`
const open = ref(false)
const creating = ref(false)
const query = ref('')
const activeIndex = ref(0)
const searchInputRef = ref<HTMLInputElement | null>(null)

const matches = computed(() => filterCategories(props.categories, query.value, props.selectedIds))
const exactMatch = computed(() => findCategoryByName(props.categories, query.value))
const alreadySelected = computed(() =>
  exactMatch.value && props.selectedIds.includes(exactMatch.value.id) ? exactMatch.value : undefined
)
const canCreate = computed(() => query.value.trim().length > 0 && !exactMatch.value)
const optionCount = computed(() => matches.value.length + (canCreate.value ? 1 : 0))
const activeOptionId = computed(() =>
  optionCount.value ? `${listboxId}-${activeIndex.value}` : undefined
)

watch(query, () => { activeIndex.value = 0 })

const focusSearch = async () => {
  await nextTick()
  searchInputRef.value?.focus()
}

const openPicker = () => {
  open.value = true
  void focusSearch()
}

const closePicker = () => {
  open.value = false
  creating.value = false
  query.value = ''
}

const move = (step: number) => {
  if (!optionCount.value) return
  activeIndex.value = (activeIndex.value + step + optionCount.value) % optionCount.value
}

// Stay open after choosing so several categories can be added in a row.
const choose = (category: Category) => {
  emit('select', category.id)
  query.value = ''
}

const activate = (index: number) => {
  if (index < matches.value.length) {
    choose(matches.value[index])
    void focusSearch()
  } else if (canCreate.value) {
    creating.value = true
  }
}

const handleCreated = (category: Category) => {
  creating.value = false
  choose(category)
  open.value = false
}

const closeCreate = () => {
  creating.value = false
  void focusSearch()
}
</script>
