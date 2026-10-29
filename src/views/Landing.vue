<template>
  <div class="min-h-screen min-h-dvh relative overflow-hidden">
    <div class="absolute top-24 left-1/4 w-96 h-96 bg-accent-emerald/5 rounded-full blur-[100px] pointer-events-none"></div>
    <div class="absolute top-1/3 right-1/4 w-96 h-96 bg-accent-violet/5 rounded-full blur-[100px] pointer-events-none"></div>

    <!-- Header -->
    <header class="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 pt-[calc(1rem+env(safe-area-inset-top))] flex items-center justify-between">
      <LynorLogo class="text-lg" />
      <a
        :href="loginHref"
        class="min-h-11 px-4 flex items-center text-sm font-semibold text-text-secondary hover:text-text-primary transition-colors"
      >
        Iniciar sesión
      </a>
    </header>

    <main class="relative z-10 max-w-6xl mx-auto px-4 sm:px-6">
      <!-- Hero -->
      <section class="pt-14 sm:pt-20 pb-16 text-center max-w-3xl mx-auto">
        <p class="inline-flex items-center gap-2 text-xs font-semibold text-accent-emerald bg-accent-emerald/10 border border-accent-emerald/20 rounded-full px-3 py-1">
          Gratis durante la beta
        </p>
        <h1 class="mt-6 font-display font-extrabold text-4xl sm:text-5xl md:text-6xl tracking-tight text-text-primary leading-tight">
          Tus finanzas personales y las de pareja, claras y en un solo lugar
        </h1>
        <p class="mt-6 text-base sm:text-lg text-text-secondary leading-relaxed">
          Registra cuentas, bolsillos y tarjetas con cuotas. Comparte los gastos de la casa con tu pareja y sepan siempre quién le debe a quién, sin hojas de cálculo.
        </p>
        <div class="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
          <a
            :href="signupHref"
            class="min-h-11 px-6 py-3.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald transition-colors flex items-center justify-center"
          >
            Crear cuenta gratis
          </a>
          <a
            href="#como-funciona"
            class="min-h-11 px-6 py-3.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-text-primary font-semibold text-sm transition-colors flex items-center justify-center"
          >
            Cómo funciona
          </a>
        </div>
      </section>

      <!-- Features -->
      <section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 pb-16">
        <article
          v-for="feature in features"
          :key="feature.title"
          class="glass-panel rounded-2xl p-5 sm:p-6 border border-white/5"
        >
          <span class="w-10 h-10 rounded-xl bg-accent-emerald/10 border border-accent-emerald/20 flex items-center justify-center">
            <component :is="feature.icon" class="w-5 h-5 text-accent-emerald" />
          </span>
          <h2 class="mt-4 font-display font-semibold text-lg text-text-primary">{{ feature.title }}</h2>
          <p class="mt-2 text-sm text-text-secondary leading-relaxed">{{ feature.body }}</p>
        </article>
      </section>

      <!-- How it works -->
      <section id="como-funciona" class="pb-16 scroll-mt-8">
        <h2 class="font-display font-bold text-2xl sm:text-3xl text-text-primary text-center">Cómo funciona</h2>
        <ol class="mt-8 grid gap-4 sm:grid-cols-3">
          <li v-for="(step, index) in steps" :key="step.title" class="glass-panel rounded-2xl p-5 sm:p-6 border border-white/5">
            <span class="font-display font-extrabold text-3xl text-accent-emerald/60">{{ index + 1 }}</span>
            <h3 class="mt-2 font-display font-semibold text-text-primary">{{ step.title }}</h3>
            <p class="mt-2 text-sm text-text-secondary leading-relaxed">{{ step.body }}</p>
          </li>
        </ol>
      </section>

      <!-- Closing CTA -->
      <section class="pb-16">
        <div class="glass-panel rounded-3xl p-6 sm:p-10 border border-white/5 text-center">
          <h2 class="font-display font-bold text-2xl sm:text-3xl text-text-primary">Empieza hoy, sin costo</h2>
          <p class="mt-3 text-sm sm:text-base text-text-secondary max-w-xl mx-auto leading-relaxed">
            Lynor Finanzas está en beta y es gratis. Tus datos son tuyos: puedes exportarlos cuando quieras.
          </p>
          <a
            :href="signupHref"
            class="mt-6 inline-flex min-h-11 px-6 py-3.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald transition-colors items-center justify-center"
          >
            Crear cuenta gratis
          </a>
        </div>
      </section>
    </main>

    <footer class="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] flex flex-col sm:flex-row gap-2 sm:gap-6 items-center justify-between text-xs text-text-muted">
      <span>© 2026 Lynor Finanzas</span>
      <nav class="flex gap-4">
        <a href="/terminos" class="min-h-11 flex items-center hover:text-text-secondary">Términos</a>
        <a href="/privacidad" class="min-h-11 flex items-center hover:text-text-secondary">Privacidad</a>
      </nav>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { Users, CreditCard, Sparkles, PiggyBank, MessageCircle, Download } from 'lucide-vue-next'
import LynorLogo from '@/components/LynorLogo.vue'

// Plain links, no router: the static landing site renders this same component,
// with `appUrl` pointing at the app's origin ('' inside the app itself).
const props = withDefaults(defineProps<{ appUrl?: string }>(), { appUrl: '' })
const signupHref = `${props.appUrl}/login?modo=registro`
const loginHref = `${props.appUrl}/login`

const features = [
  {
    icon: Users,
    title: 'Gastos de pareja sin cuentas raras',
    body: 'Un espacio compartido para la casa y uno personal para cada uno. Lynor Finanzas lleva quién pagó qué y cuánto se deben, y lo liquidan cuando quieran.'
  },
  {
    icon: CreditCard,
    title: 'Hecho para cómo pagamos en Colombia',
    body: 'Bolsillos, tarjetas de crédito con cuotas que caen en el mes en que las pagas, y pesos junto a otras monedas.'
  },
  {
    icon: Sparkles,
    title: 'Importa tus extractos con IA',
    body: 'Sube el extracto del banco o pega las notificaciones, y Lynor Finanzas los convierte en movimientos que revisas antes de guardar.'
  },
  {
    icon: PiggyBank,
    title: 'Presupuestos y metas',
    body: 'Presupuestos mensuales y por evento, metas de ahorro y alertas cuando te acercas al límite.'
  },
  {
    icon: MessageCircle,
    title: 'Un asesor que conoce tus números',
    body: 'Pregunta "¿cuánto gastamos en mercado este mes?" y recibe la respuesta con tus propios datos.'
  },
  {
    icon: Download,
    title: 'Tus datos son tuyos',
    body: 'Cada espacio solo lo ven sus miembros, y puedes descargar toda tu información cuando quieras.'
  }
]

const steps = [
  { title: 'Crea tu cuenta', body: 'Con tu correo o tu cuenta de Google. Lynor Finanzas crea tu espacio personal.' },
  { title: 'Invita a tu pareja', body: 'Creen un espacio compartido para los gastos de la casa; cada uno conserva el suyo.' },
  { title: 'Registra o importa', body: 'Anota tus movimientos o importa tus extractos, y mira en qué se va la plata.' }
]
</script>
