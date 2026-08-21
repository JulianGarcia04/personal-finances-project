<template>
  <div class="max-w-6xl mx-auto space-y-8">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h2 class="font-display font-bold text-3xl text-text-primary tracking-tight">Cuentas Financieras</h2>
        <p class="text-text-secondary text-sm mt-1">Registra tus cuentas bancarias, tarjetas de crédito y efectivo.</p>
      </div>
      <button 
        @click="showAddModal = true"
        class="flex items-center justify-center space-x-2 px-5 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer transition-all duration-200"
      >
        <PlusIcon class="w-4 h-4" />
        <span>Agregar Cuenta</span>
      </button>
    </div>

    <!-- Summary of net worth by currency -->
    <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
      <div 
        v-for="(total, cur) in accountsStore.netWorthByCurrency" 
        :key="cur"
        class="glass-panel rounded-2xl p-4 sm:p-6 relative overflow-hidden group hover:border-white/10 transition-all"
      >
        <div class="absolute top-0 right-0 w-32 h-32 bg-accent-emerald/5 rounded-full blur-2xl pointer-events-none"></div>
        <span class="text-xs font-semibold text-text-secondary uppercase tracking-widest">Patrimonio Neto ({{ cur }})</span>
        <h3 :class="['font-display font-bold text-3xl mt-2', total >= 0 ? 'text-accent-emerald' : 'text-accent-rose']">
          {{ formatCurrency(total, cur) }}
        </h3>
      </div>
      <div v-if="Object.keys(accountsStore.netWorthByCurrency).length === 0" class="glass-panel rounded-2xl p-6 col-span-full text-center">
        <p class="text-text-muted text-sm py-4">No hay cuentas registradas. Agrega una para comenzar.</p>
      </div>
    </div>

    <!-- Accounts Cards Grid -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <div 
        v-for="account in accountsStore.accounts" 
        :key="account.id"
        :class="['glass-panel rounded-2xl p-4 sm:p-6 flex flex-col justify-between min-h-52 transition-all relative overflow-hidden group border border-white/5', account.mirror ? 'mirror-ledger glow-card-violet' : getGlowClass(account.type)]"
      >
        <!-- Background light blur -->
        <div :class="['absolute top-0 right-0 w-24 h-24 rounded-full blur-xl opacity-20 pointer-events-none', account.mirror ? 'bg-accent-violet' : getOrbBgClass(account.type)]"></div>

        <!-- Card Top Details -->
        <div>
          <div class="flex items-start justify-between">
            <div :class="['p-3 rounded-xl border', account.mirror ? 'bg-accent-violet/10 border-accent-violet/25' : 'bg-white/5 border-white/5']">
              <component
                :is="account.mirror ? MirrorIcon : getAccountIcon(account.type)"
                :class="['w-6 h-6', account.mirror ? 'text-accent-violet' : 'text-text-secondary']"
              />
            </div>
            
            <div class="flex items-center space-x-1">
              <button
                @click="openEditModal(account)"
                class="opacity-0 group-hover:opacity-100 p-2 rounded-lg text-text-muted hover:text-accent-emerald hover:bg-white/5 transition-all"
                title="Editar Cuenta"
              >
                <PencilIcon class="w-4 h-4" />
              </button>
              <button
                @click="handleDelete(account.id, account.name)"
                class="opacity-0 group-hover:opacity-100 p-2 rounded-lg text-text-muted hover:text-accent-rose hover:bg-white/5 transition-all"
                title="Eliminar Cuenta"
              >
                <TrashIcon class="w-4 h-4" />
              </button>
            </div>
          </div>

          <h4 class="font-display font-bold text-lg text-text-primary mt-4 truncate">{{ account.name }}</h4>
          <p
            v-if="account.mirror"
            class="text-[11px] text-accent-violet/90 uppercase tracking-wide mt-1 flex items-center gap-1.5"
            :title="`Espejo en ${mirrorWorkspaceName(account)}`"
          >
            <MirrorIcon class="w-3 h-3 shrink-0" />
            <span class="truncate">Puente → {{ mirrorWorkspaceName(account) }}</span>
          </p>
          <p v-else class="text-xs text-text-secondary uppercase tracking-wide mt-1">{{ formatType(account.type) }}</p>
          <div v-if="account.type === 'credit'" class="flex items-center gap-3 text-[10px] text-text-muted mt-3">
            <span>Corte: <strong class="text-text-secondary">{{ account.statementClosingDay ? `día ${account.statementClosingDay}` : '—' }}</strong></span>
            <span>Pago: <strong class="text-text-secondary">{{ account.paymentDueDay ? `día ${account.paymentDueDay}` : '—' }}</strong></span>
          </div>
        </div>

        <!-- Card Bottom Details -->
        <div :class="['pt-3 flex items-end justify-between mt-4', account.mirror ? 'mirror-perforation' : 'border-t border-border/50']">
          <div>
            <span class="text-[10px] text-text-muted font-medium block">{{ balanceLabel(account) }}</span>
            <span :class="['font-display font-bold text-xl mt-1 block', balanceToneClass(account)]">
              {{ formatCurrency(account.mirror ? Math.abs(account.balance) : account.balance, account.currency) }}
            </span>
          </div>

          <!-- Liquidar: solo cuando el puente tiene deuda pendiente -->
          <button
            v-if="account.mirror && account.balance < 0"
            @click="openSettleModal(account)"
            class="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-accent-violet/10 border border-accent-violet/30 text-accent-violet hover:bg-accent-violet/20 hover:border-accent-violet/50 text-xs font-display font-semibold cursor-pointer transition-all"
            title="Pasar la plata y saldar la deuda en los dos workspaces"
          >
            <SettleIcon class="w-3.5 h-3.5" />
            <span>Liquidar</span>
          </button>

          <div v-else-if="account.type === 'credit' && account.limit > 0" class="text-right">
            <span class="text-[10px] text-text-muted font-medium block">CUPO DISPONIBLE</span>
            <span class="text-xs text-text-secondary font-semibold mt-1 block">
              {{ formatCurrency(Math.max(0, account.limit + account.balance), account.currency) }}
            </span>
            <div class="w-24 ml-auto mt-1.5 h-1.5 rounded-full bg-slate-800 overflow-hidden" :title="`Utilización: ${creditUtilization(account)}%`">
              <div
                :class="['h-full rounded-full transition-all', creditUtilization(account) >= 80 ? 'bg-accent-rose' : creditUtilization(account) >= 50 ? 'bg-accent-amber' : 'bg-accent-emerald']"
                :style="{ width: Math.min(100, creditUtilization(account)) + '%' }"
              ></div>
            </div>
            <span class="text-[9px] text-text-muted block mt-0.5">{{ creditUtilization(account) }}% usado</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Add Account Modal -->
    <div 
      v-if="showAddModal" 
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
    >
      <div class="w-full max-w-md glass-panel rounded-3xl p-4 sm:p-6 md:p-8 shadow-2xl relative border border-white/10 animate-scale-up max-h-[90vh] overflow-y-auto">
        <!-- Close Button -->
        <button 
          @click="closeAddModal"
          class="absolute top-4 right-4 p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/5 transition-all"
        >
          <XIcon class="w-5 h-5" />
        </button>

        <h3 class="font-display font-bold text-2xl text-text-primary mb-2">Agregar Cuenta</h3>
        <p class="text-text-secondary text-xs mb-6">Configura los detalles de tu nueva cuenta bancaria o de efectivo.</p>

        <form @submit.prevent="saveAccount" class="space-y-4">
          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Nombre de la Cuenta</label>
            <input 
              v-model="newAcc.name" 
              type="text" 
              required
              placeholder="Ej. Tarjeta Visa Oro, Ahorros Bancolombia"
              class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-emerald"
            />
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Tipo de Cuenta</label>
              <select 
                v-model="newAcc.type"
                class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              >
                <option value="checking">Corriente</option>
                <option value="savings">Ahorros</option>
                <option value="credit">Tarjeta Crédito</option>
                <option value="cash">Efectivo</option>
              </select>
            </div>

            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Moneda Base</label>
              <input 
                v-model="newAcc.currency"
                type="text"
                required
                placeholder="COP, USD, EUR"
                class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary uppercase focus:outline-none focus:border-accent-emerald"
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Saldo Inicial</label>
              <input 
                v-model.number="newAcc.balance"
                type="number"
                step="any"
                required
                class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              />
            </div>

            <div v-if="newAcc.type === 'credit'" class="space-y-1 animate-fade-in">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Cupo/Límite de Crédito</label>
              <input 
                v-model.number="newAcc.limit"
                type="number"
                step="any"
                class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              />
            </div>
          </div>

          <div v-if="newAcc.type === 'credit'" class="space-y-2 animate-fade-in">
            <div class="grid grid-cols-2 gap-4">
              <div class="space-y-1">
                <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Día de corte</label>
                <input
                  v-model.number="newAcc.statementClosingDay"
                  type="number"
                  min="1"
                  max="31"
                  step="1"
                  placeholder="Ej. 15"
                  class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
                />
              </div>
              <div class="space-y-1">
                <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Día límite de pago</label>
                <input
                  v-model.number="newAcc.paymentDueDay"
                  type="number"
                  min="1"
                  max="31"
                  step="1"
                  placeholder="Ej. 30"
                  class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
                />
              </div>
            </div>
            <p class="text-[10px] text-text-muted">Se repiten cada mes. Son opcionales.</p>
          </div>

          <!-- Buttons -->
          <div class="flex space-x-3 pt-4">
            <button 
              type="button" 
              @click="closeAddModal"
              class="w-1/2 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all"
            >
              Cancelar
            </button>
            <button 
              type="submit" 
              :disabled="loading"
              class="w-1/2 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50"
            >
              <span>Guardar</span>
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- Edit Account Modal -->
    <div
      v-if="showEditModal"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
    >
      <div class="w-full max-w-md glass-panel rounded-3xl p-4 sm:p-6 md:p-8 shadow-2xl relative border border-white/10 animate-scale-up max-h-[90vh] overflow-y-auto">
        <button
          @click="showEditModal = false"
          class="absolute top-4 right-4 p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/5 transition-all"
        >
          <XIcon class="w-5 h-5" />
        </button>

        <h3 class="font-display font-bold text-2xl text-text-primary mb-2">Editar Cuenta</h3>
        <p class="text-text-secondary text-xs mb-6">El saldo solo cambia con transacciones; aquí editas la configuración.</p>

        <form @submit.prevent="saveEditedAccount" class="space-y-4">
          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Nombre de la Cuenta</label>
            <input
              v-model="editAcc.name"
              type="text"
              required
              class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-emerald"
            />
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Tipo de Cuenta</label>
              <select
                v-model="editAcc.type"
                class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              >
                <option value="checking">Corriente</option>
                <option value="savings">Ahorros</option>
                <option value="credit">Tarjeta Crédito</option>
                <option value="cash">Efectivo</option>
              </select>
            </div>

            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Moneda Base</label>
              <input
                v-model="editAcc.currency"
                type="text"
                required
                placeholder="COP, USD, EUR"
                class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary uppercase focus:outline-none focus:border-accent-emerald"
              />
            </div>
          </div>

          <div v-if="editAcc.type === 'credit'" class="space-y-1 animate-fade-in">
            <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Cupo/Límite de Crédito</label>
            <input
              v-model.number="editAcc.limit"
              type="number"
              step="any"
            class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
          />
          </div>

          <div v-if="editAcc.type === 'credit'" class="space-y-2 animate-fade-in">
            <div class="grid grid-cols-2 gap-4">
              <div class="space-y-1">
                <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Día de corte</label>
                <input
                  v-model.number="editAcc.statementClosingDay"
                  type="number"
                  min="1"
                  max="31"
                  step="1"
                  placeholder="Ej. 15"
                  class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
                />
              </div>
              <div class="space-y-1">
                <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Día límite de pago</label>
                <input
                  v-model.number="editAcc.paymentDueDay"
                  type="number"
                  min="1"
                  max="31"
                  step="1"
                  placeholder="Ej. 30"
                  class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
                />
              </div>
            </div>
            <p class="text-[10px] text-text-muted">Se repiten cada mes. Son opcionales.</p>
          </div>

          <!-- Espejo entre workspaces (cuenta puente) -->
          <div v-if="otherWorkspaces.length" class="rounded-2xl border border-accent-violet/20 bg-accent-violet/[0.04] p-4 space-y-3.5">
            <div class="flex items-start gap-2.5">
              <div class="p-1.5 rounded-lg bg-accent-violet/10 border border-accent-violet/25 shrink-0 mt-0.5">
                <MirrorIcon class="w-3.5 h-3.5 text-accent-violet" />
              </div>
              <div>
                <h4 class="font-display font-semibold text-sm text-text-primary">Cuenta puente</h4>
                <p class="text-[11px] text-text-secondary leading-relaxed mt-0.5">
                  Un gasto contra esta cuenta consume el presupuesto de acá, pero la plata sale de otro workspace.
                  La contrapartida se registra allá sola, como transferencia.
                </p>
              </div>
            </div>

            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Workspace que pone la plata</label>
              <select
                v-model="editMirror.workspaceId"
                @change="loadMirrorAccounts()"
                class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-violet"
              >
                <option value="">Sin espejo — cuenta normal</option>
                <option v-for="ws in otherWorkspaces" :key="ws.id" :value="ws.id">{{ ws.name }}</option>
              </select>
            </div>

            <div v-if="editMirror.workspaceId" class="space-y-3.5 animate-fade-in">
              <p v-if="loadingMirrorAccounts" class="text-[11px] text-text-muted">Cargando cuentas…</p>
              <p v-else-if="mirrorAccounts.length < 2" class="text-[11px] text-accent-rose">
                Ese workspace necesita al menos dos cuentas: la que paga y una de "por cobrar".
              </p>
              <template v-else>
                <div class="space-y-1">
                  <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Cuenta que paga (allá)</label>
                  <select
                    v-model="editMirror.sourceAccountId"
                    class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-violet"
                  >
                    <option value="" disabled>Ej. tu tarjeta de crédito</option>
                    <option v-for="acc in mirrorAccounts" :key="acc.id" :value="acc.id" :disabled="acc.id === editMirror.accountId">
                      {{ acc.name }} ({{ acc.currency }})
                    </option>
                  </select>
                </div>

                <div class="space-y-1">
                  <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Cuenta "por cobrar" (allá)</label>
                  <select
                    v-model="editMirror.accountId"
                    class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-violet"
                  >
                    <option value="" disabled>Ej. "Por cobrar – Casa", saldo 0</option>
                    <option v-for="acc in mirrorAccounts" :key="acc.id" :value="acc.id" :disabled="acc.id === editMirror.sourceAccountId">
                      {{ acc.name }} ({{ acc.currency }})
                    </option>
                  </select>
                </div>

                <!-- Previsualización del cableado: hace legible qué va a pasar -->
                <div v-if="mirrorPreview" class="mirror-perforation pt-3 text-[11px] leading-relaxed">
                  <span class="text-text-muted">Un gasto de </span>
                  <span class="text-text-primary font-semibold">{{ formatCurrency(100000, editAcc.currency.toUpperCase()) }}</span>
                  <span class="text-text-muted"> acá →</span>
                  <span class="text-accent-rose"> −{{ mirrorPreview.source }}</span>
                  <span class="text-text-muted"> y </span>
                  <span class="text-accent-emerald">+{{ mirrorPreview.receivable }}</span>
                  <span class="text-text-muted"> en {{ mirrorPreview.workspace }}.</span>
                </div>
              </template>
            </div>
          </div>

          <div class="flex space-x-3 pt-4">
            <button
              type="button"
              @click="showEditModal = false"
              class="w-1/2 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all"
            >
              Cancelar
            </button>
            <button
              type="submit"
              :disabled="loading"
              class="w-1/2 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50"
            >
              <span>Guardar</span>
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- Settle Mirror Modal -->
    <div
      v-if="settleAccount"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
    >
      <div class="w-full max-w-md glass-panel mirror-ledger rounded-3xl p-4 sm:p-6 md:p-8 shadow-2xl relative border border-accent-violet/25 animate-scale-up max-h-[90vh] overflow-y-auto">
        <div class="absolute -top-10 -right-10 w-40 h-40 rounded-full bg-accent-violet/10 blur-3xl pointer-events-none"></div>

        <button
          @click="settleAccount = null"
          class="absolute top-4 right-4 p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/5 transition-all"
        >
          <XIcon class="w-5 h-5" />
        </button>

        <h3 class="font-display font-bold text-2xl text-text-primary mb-1">Liquidar puente</h3>
        <p class="text-text-secondary text-xs mb-5">
          La plata pasa de verdad de este workspace a {{ mirrorWorkspaceName(settleAccount) }}. No toca presupuestos.
        </p>

        <!-- Deuda pendiente, protagonista -->
        <div class="mb-6 rounded-2xl border border-accent-violet/25 bg-accent-violet/[0.06] px-5 py-4">
          <span class="text-[10px] font-semibold text-accent-violet/80 uppercase tracking-widest block">Pendiente de reembolso</span>
          <span class="font-display font-bold text-3xl text-text-primary mt-1 block tracking-tight">
            {{ formatCurrency(settleDebt, settleAccount.currency) }}
          </span>
        </div>

        <form @submit.prevent="saveSettlement" class="space-y-4">
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Monto a liquidar</label>
              <input
                v-model.number="settleForm.amount"
                type="number"
                step="any"
                required
                class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-violet"
              />
            </div>
            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Fecha</label>
              <input
                v-model="settleForm.date"
                type="date"
                required
                class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-violet"
              />
            </div>
          </div>

          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Sale de (este workspace)</label>
            <select
              v-model="settleForm.fromAccountId"
              required
              class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-violet"
            >
              <option value="" disabled>Selecciona cuenta</option>
              <option v-for="acc in settleSourceAccounts" :key="acc.id" :value="acc.id">
                {{ acc.name }} ({{ formatCurrency(acc.balance, acc.currency) }})
              </option>
            </select>
          </div>

          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Entra a ({{ mirrorWorkspaceName(settleAccount) }})</label>
            <select
              v-model="settleForm.toAccountId"
              required
              class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-violet"
            >
              <option value="" disabled>{{ loadingMirrorAccounts ? 'Cargando cuentas…' : 'Selecciona cuenta' }}</option>
              <option v-for="acc in settleDestinationAccounts" :key="acc.id" :value="acc.id">
                {{ acc.name }} ({{ acc.currency }})
              </option>
            </select>
          </div>

          <div class="flex space-x-3 pt-2">
            <button
              type="button"
              @click="settleAccount = null"
              class="w-1/2 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all"
            >
              Cancelar
            </button>
            <button
              type="submit"
              :disabled="loading"
              class="w-1/2 py-2.5 rounded-xl bg-accent-violet hover:bg-accent-violet/80 text-white font-display font-semibold text-sm cursor-pointer disabled:opacity-50 transition-all"
              style="box-shadow: var(--shadow-glow-violet)"
            >
              <span>Liquidar</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAccountsStore } from '@/stores/accountsStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { useAuthStore } from '@/stores/authStore'
import { Account, AccountType } from '@/types'
import { AccountSchema } from '@/schemas'
import {
  Plus as PlusIcon,
  Trash2 as TrashIcon,
  X as XIcon,
  Pencil as PencilIcon,
  PiggyBank as SavingsIcon,
  CreditCard as CreditIcon,
  Wallet as CashIcon,
  Building as BankIcon,
  ArrowLeftRight as MirrorIcon,
  Banknote as SettleIcon
} from 'lucide-vue-next'

const accountsStore = useAccountsStore()
const workspacesStore = useWorkspacesStore()
const transactionsStore = useTransactionsStore()
const authStore = useAuthStore()

const showAddModal = ref(false)
const showEditModal = ref(false)
const loading = ref(false)
const newAcc = ref<{
  name: string;
  type: AccountType;
  balance: number;
  limit: number;
  currency: string;
  statementClosingDay: number | null;
  paymentDueDay: number | null;
}>({
  name: '',
  type: 'savings',
  balance: 0,
  limit: 0,
  currency: 'COP',
  statementClosingDay: null,
  paymentDueDay: null
})

onMounted(async () => {
  await Promise.all([accountsStore.fetchAccounts(), workspacesStore.fetchMyWorkspaces()])
})

// --- Cuentas puente (espejo entre workspaces) ---

const otherWorkspaces = computed(() =>
  workspacesStore.workspaces.filter(ws => ws.id !== authStore.activeWorkspaceId)
)

const mirrorWorkspaceName = (account: Account) =>
  workspacesStore.workspaces.find(ws => ws.id === account.mirror?.workspaceId)?.name || 'otro workspace'

// El saldo de un puente no es plata: es deuda. Se muestra en absoluto con etiqueta explícita.
const balanceLabel = (account: Account) => {
  if (!account.mirror) return 'SALDO DISPONIBLE'
  if (account.balance < 0) return 'TE DEBEN'
  if (account.balance > 0) return 'DEBES'
  return 'SALDADO'
}

const balanceToneClass = (account: Account) => {
  if (account.mirror) return account.balance === 0 ? 'text-text-secondary' : 'text-accent-violet'
  return account.balance >= 0 ? 'text-accent-emerald' : 'text-accent-rose'
}

const emptyMirror = () => ({ workspaceId: '', accountId: '', sourceAccountId: '' })
const editMirror = ref(emptyMirror())
const mirrorAccounts = ref<Account[]>([])
const loadingMirrorAccounts = ref(false)

const loadMirrorAccounts = async (workspaceId: string = editMirror.value.workspaceId) => {
  if (!workspaceId) {
    mirrorAccounts.value = []
    return
  }
  loadingMirrorAccounts.value = true
  try {
    mirrorAccounts.value = await accountsStore.fetchAccountsByWorkspace(workspaceId)
  } catch (err) {
    console.error('Error cargando cuentas del workspace espejo:', err)
    mirrorAccounts.value = []
  } finally {
    loadingMirrorAccounts.value = false
  }
}

const mirrorPreview = computed(() => {
  const { workspaceId, sourceAccountId, accountId } = editMirror.value
  if (!workspaceId || !sourceAccountId || !accountId) return null
  const source = mirrorAccounts.value.find(acc => acc.id === sourceAccountId)
  const receivable = mirrorAccounts.value.find(acc => acc.id === accountId)
  if (!source || !receivable) return null
  return {
    source: source.name,
    receivable: receivable.name,
    workspace: workspacesStore.workspaces.find(ws => ws.id === workspaceId)?.name || 'el otro workspace'
  }
})

const closeAddModal = () => {
  showAddModal.value = false
  newAcc.value = {
    name: '',
    type: 'savings',
    balance: 0,
    limit: 0,
    currency: 'COP',
    statementClosingDay: null,
    paymentDueDay: null
  }
}

const saveAccount = async () => {
  // Zod Validation
  const validation = AccountSchema.safeParse({
    name: newAcc.value.name,
    type: newAcc.value.type,
    balance: newAcc.value.balance,
    limit: newAcc.value.limit,
    currency: newAcc.value.currency.toUpperCase(),
    statementClosingDay: newAcc.value.statementClosingDay || null,
    paymentDueDay: newAcc.value.paymentDueDay || null
  })

  if (!validation.success) {
    alert(validation.error.errors[0].message)
    return
  }

  loading.value = true
  try {
    await accountsStore.addAccount({
      name: newAcc.value.name,
      type: newAcc.value.type,
      balance: newAcc.value.balance,
      limit: newAcc.value.limit,
      currency: newAcc.value.currency.toUpperCase(),
      statementClosingDay: newAcc.value.statementClosingDay || null,
      paymentDueDay: newAcc.value.paymentDueDay || null
    })
    closeAddModal()
  } catch (err) {
    console.error('Error al guardar cuenta:', err)
  } finally {
    loading.value = false
  }
}

const editAcc = ref<{
  name: string;
  type: AccountType;
  limit: number;
  currency: string;
  statementClosingDay: number | null;
  paymentDueDay: number | null;
}>({ name: '', type: 'savings', limit: 0, currency: 'COP', statementClosingDay: null, paymentDueDay: null })
const editingAccountId = ref('')

const openEditModal = (account: Account) => {
  editingAccountId.value = account.id
  editAcc.value = {
    name: account.name,
    type: account.type,
    limit: account.limit,
    currency: account.currency,
    statementClosingDay: account.statementClosingDay ?? null,
    paymentDueDay: account.paymentDueDay ?? null
  }
  editMirror.value = account.mirror ? { ...account.mirror } : emptyMirror()
  mirrorAccounts.value = []
  if (editMirror.value.workspaceId) loadMirrorAccounts()
  showEditModal.value = true
}

const saveEditedAccount = async () => {
  const currency = editAcc.value.currency.toUpperCase()
  // Validar con el mismo schema (balance queda por fuera, no se edita)
  const validation = AccountSchema.pick({ name: true, type: true, limit: true, currency: true, statementClosingDay: true, paymentDueDay: true }).safeParse({
    ...editAcc.value,
    currency,
    statementClosingDay: editAcc.value.statementClosingDay || null,
    paymentDueDay: editAcc.value.paymentDueDay || null
  })
  if (!validation.success) {
    alert(validation.error.errors[0].message)
    return
  }

  // El espejo se guarda completo o no se guarda: un espejo a medias escribiría
  // la contrapartida en una cuenta equivocada.
  const { workspaceId, sourceAccountId, accountId } = editMirror.value
  if (workspaceId && !(sourceAccountId && accountId)) {
    alert('Para el espejo debes elegir la cuenta que paga y la cuenta por cobrar.')
    return
  }
  if (workspaceId && sourceAccountId === accountId) {
    alert('La cuenta que paga y la cuenta por cobrar deben ser distintas.')
    return
  }

  loading.value = true
  try {
    await accountsStore.updateAccount(editingAccountId.value, {
      ...editAcc.value,
      currency,
      statementClosingDay: editAcc.value.statementClosingDay || null,
      paymentDueDay: editAcc.value.paymentDueDay || null
    })
    await accountsStore.setAccountMirror(
      editingAccountId.value,
      workspaceId ? { workspaceId, sourceAccountId, accountId } : null
    )
    showEditModal.value = false
  } catch (err: any) {
    console.error('Error al actualizar cuenta:', err)
    alert(err?.message || 'No se pudo actualizar la cuenta')
  } finally {
    loading.value = false
  }
}

// --- Liquidación del puente ---

const settleAccount = ref<Account | null>(null)
const settleForm = ref({ amount: 0, fromAccountId: '', toAccountId: '', date: '' })

const settleDebt = computed(() => (settleAccount.value ? -settleAccount.value.balance : 0))

const settleSourceAccounts = computed(() =>
  accountsStore.accounts.filter(acc => acc.id !== settleAccount.value?.id && !acc.mirror)
)

const settleDestinationAccounts = computed(() =>
  mirrorAccounts.value.filter(acc => acc.id !== settleAccount.value?.mirror?.accountId)
)

const openSettleModal = async (account: Account) => {
  settleAccount.value = account
  settleForm.value = {
    amount: -account.balance,
    fromAccountId: '',
    toAccountId: '',
    date: new Date().toISOString().substring(0, 10)
  }
  await loadMirrorAccounts(account.mirror?.workspaceId)
}

const saveSettlement = async () => {
  if (!settleAccount.value) return
  loading.value = true
  try {
    await transactionsStore.settleMirror({
      bridgeAccountId: settleAccount.value.id,
      amount: Number(settleForm.value.amount),
      fromAccountId: settleForm.value.fromAccountId,
      toAccountId: settleForm.value.toAccountId,
      date: new Date(settleForm.value.date + 'T12:00:00')
    })
    settleAccount.value = null
  } catch (err: any) {
    console.error('Error al liquidar:', err)
    alert(err?.message || 'No se pudo liquidar el puente')
  } finally {
    loading.value = false
  }
}

// % de cupo usado de una tarjeta de crédito (balance negativo = deuda)
const creditUtilization = (account: Account) => {
  if (account.type !== 'credit' || !account.limit || account.limit <= 0) return 0
  const used = account.balance < 0 ? -account.balance : 0
  return Math.round((used / account.limit) * 100)
}

const handleDelete = async (id: string, name: string) => {
  if (confirm(`¿Estás seguro de que deseas eliminar la cuenta "${name}"? Todas las transacciones asociadas ya no estarán vinculadas.`)) {
    try {
      await accountsStore.deleteAccount(id)
    } catch (err: any) {
      console.error('Error al borrar cuenta:', err)
      alert(err?.message || 'No se pudo borrar la cuenta')
    }
  }
}

// Helpers visuales
const getGlowClass = (type: AccountType) => {
  if (type === 'savings') return 'glow-card-emerald'
  if (type === 'credit') return 'glow-card-rose'
  return 'glow-card-amber'
}

const getOrbBgClass = (type: AccountType) => {
  if (type === 'savings') return 'bg-accent-emerald'
  if (type === 'credit') return 'bg-accent-rose'
  return 'bg-accent-amber'
}

const getAccountIcon = (type: AccountType) => {
  if (type === 'savings') return SavingsIcon
  if (type === 'credit') return CreditIcon
  if (type === 'cash') return CashIcon
  return BankIcon
}

const formatType = (type: AccountType) => {
  const types: Record<AccountType, string> = {
    checking: 'Cuenta Corriente',
    savings: 'Cuenta de Ahorros',
    credit: 'Tarjeta de Crédito',
    cash: 'Efectivo / Cash'
  }
  return types[type] || 'Otro'
}

const formatCurrency = (val: number, currency: string) => {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: currency || 'COP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(val)
}
</script>

<style scoped>
.animate-scale-up {
  animation: scaleUp 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes scaleUp {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
