<template>
  <div class="max-w-6xl mx-auto space-y-8">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h2 class="font-display font-bold text-2xl sm:text-3xl text-text-primary tracking-tight">Cuentas Financieras</h2>
        <p class="text-text-secondary text-sm mt-1">Registra tus cuentas bancarias, tarjetas de crédito y efectivo.</p>
      </div>
      <button 
        @click="openNewAccountModal"
        class="flex items-center justify-center space-x-2 min-h-11 px-5 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer transition-all duration-200"
      >
        <PlusIcon class="w-4 h-4" />
        <span>Agregar Cuenta</span>
      </button>
    </div>

    <!-- Summary of net worth by currency -->
    <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 sm:gap-6">
      <div 
        v-for="(total, cur) in accountsStore.netWorthByCurrency" 
        :key="cur"
        class="glass-panel rounded-2xl p-4 sm:p-6 relative overflow-hidden group hover:border-white/10 transition-all"
      >
        <div class="absolute top-0 right-0 w-32 h-32 bg-accent-emerald/5 rounded-full blur-2xl pointer-events-none"></div>
        <span class="text-xs font-semibold text-text-secondary uppercase tracking-widest">Patrimonio Neto ({{ cur }})</span>
        <h3 :class="['min-w-0 font-display font-bold text-xl min-[400px]:text-2xl sm:text-3xl mt-2 tabular-nums', total >= 0 ? 'text-accent-emerald' : 'text-accent-rose']" :title="formatCurrency(total, cur)">
          <span class="whitespace-nowrap">{{ splitMoney(formatCurrency(total, cur))[0] }}</span> <span class="inline-block max-w-full truncate align-bottom whitespace-nowrap">{{ splitMoney(formatCurrency(total, cur))[1] }}</span>
        </h3>
      </div>
      <div v-if="Object.keys(accountsStore.netWorthByCurrency).length === 0" class="glass-panel rounded-2xl p-6 col-span-full text-center">
        <p class="text-text-muted text-sm py-4">No hay cuentas registradas. Agrega una para comenzar.</p>
      </div>
    </div>

    <!-- Accounts Cards Grid -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
      <div v-for="group in accountGroups" :key="group.account.id" class="space-y-3 min-w-0">
        <div
          v-for="account in [group.account]"
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
            
            <div class="flex items-center -mr-2 -mt-1">
              <button
                @click="openEditModal(account)"
                :aria-label="`Editar cuenta ${account.name}`"
                class="tap flex items-center justify-center hover-device:opacity-0 hover-device:group-hover:opacity-100 hover-device:group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-emerald rounded-lg active:bg-white/10 text-text-muted hover:text-accent-emerald hover:bg-white/5 transition-all"
                title="Editar Cuenta"
              >
                <PencilIcon class="w-4 h-4" />
              </button>
              <button
                @click="handleDelete(account.id, account.name)"
                :aria-label="`Eliminar cuenta ${account.name}`"
                class="tap flex items-center justify-center hover-device:opacity-0 hover-device:group-hover:opacity-100 hover-device:group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-rose rounded-lg active:bg-white/10 text-text-muted hover:text-accent-rose hover:bg-white/5 transition-all"
                title="Eliminar Cuenta"
              >
                <TrashIcon class="w-4 h-4" />
              </button>
            </div>
          </div>

          <h4 class="font-display font-bold text-lg text-text-primary mt-4 truncate">{{ account.name }}</h4>
          <p v-if="group.isOrphan" class="text-[11px] text-accent-amber mt-1 break-words" role="note">
            Bolsillo sin grupo. Conserva este identificador: <span class="break-all">{{ account.id }}</span>
          </p>
          <p
            v-if="account.mirror"
            class="text-[11px] text-accent-violet/90 uppercase tracking-wide mt-1 flex items-center gap-1.5"
            :title="`Espejo en ${mirrorWorkspaceName(account)}`"
          >
            <MirrorIcon class="w-3 h-3 shrink-0" />
            <span class="truncate">Puente → {{ mirrorWorkspaceName(account) }}</span>
          </p>
          <p v-else class="text-xs text-text-secondary uppercase tracking-wide mt-1">{{ formatType(account.type) }}</p>
          <div v-if="account.type === 'credit'" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted mt-3">
            <span>Corte: <strong class="text-text-secondary">{{ account.statementClosingDay ? `día ${account.statementClosingDay}` : '—' }}</strong></span>
            <span>Pago: <strong class="text-text-secondary">{{ account.paymentDueDay ? `día ${account.paymentDueDay}` : '—' }}</strong></span>
          </div>

          <div v-if="account.type === 'credit' && (account.statementClosingDay || account.paymentDueDay)" class="flex flex-col gap-0.5 text-[11px] text-text-muted mt-1.5">
            <span v-if="account.statementClosingDay">{{ closingDaysUntil(account) === 0 ? 'Corte hoy' : `Corte en ${closingDaysUntil(account)} días` }}</span>
            <span v-if="account.paymentDueDay">{{ dueDaysUntil(account) === 0 ? 'Vence hoy' : `Vence en ${dueDaysUntil(account)} días` }}</span>
            <span v-if="account.statementClosingDay">A pagar este corte: <strong class="text-text-secondary tabular-nums">{{ formatCurrency(cycleChargeAmount(account), account.currency) }}</strong></span>
          </div>
        </div>

        <!-- Card Bottom Details -->
        <div :class="['pt-4 flex items-end justify-between gap-3 mt-5', account.mirror ? 'mirror-perforation' : 'border-t border-white/5']">
          <div class="min-w-0">
            <span class="text-[11px] text-text-muted font-medium block">{{ balanceLabel(account) }}</span>
            <span :class="['font-display font-bold text-lg min-[400px]:text-xl mt-1 block tabular-nums', balanceToneClass(account)]" :title="formatCurrency(account.mirror ? Math.abs(account.balance) : account.balance, account.currency)">
              <span class="whitespace-nowrap">{{ splitMoney(formatCurrency(account.mirror ? Math.abs(account.balance) : account.balance, account.currency))[0] }}</span> <span class="inline-block max-w-full truncate align-bottom whitespace-nowrap">{{ splitMoney(formatCurrency(account.mirror ? Math.abs(account.balance) : account.balance, account.currency))[1] }}</span>
            </span>
          </div>

          <!-- Liquidar: solo cuando el puente tiene deuda pendiente -->
          <button
            v-if="account.mirror && account.balance < 0"
            @click="openSettleModal(account)"
            class="shrink-0 flex items-center gap-1.5 min-h-11 px-3 py-2 rounded-xl bg-accent-violet/10 border border-accent-violet/30 text-accent-violet hover:bg-accent-violet/20 hover:border-accent-violet/50 text-xs font-display font-semibold cursor-pointer transition-all"
            title="Pasar la plata y saldar la deuda en los dos workspaces"
          >
            <SettleIcon class="w-3.5 h-3.5" />
            <span>Liquidar</span>
          </button>

          <div v-else-if="account.type === 'credit' && account.limit > 0" class="text-right shrink-0">
            <span class="text-[11px] text-text-muted font-medium block">CUPO DISPONIBLE</span>
            <span class="text-xs text-text-secondary font-semibold mt-1 block tabular-nums">
              {{ formatCurrency(Math.max(0, account.limit + account.balance), account.currency) }}
            </span>
            <div class="w-24 ml-auto mt-1.5 h-1.5 rounded-full bg-slate-800 overflow-hidden" :title="`Utilización: ${creditUtilization(account)}%`">
              <div
                :class="['h-full rounded-full transition-all', creditUtilization(account) >= 80 ? 'bg-accent-rose' : creditUtilization(account) >= 50 ? 'bg-accent-amber' : 'bg-accent-emerald']"
                :style="{ width: Math.min(100, creditUtilization(account)) + '%' }"
              ></div>
            </div>
            <span class="text-[11px] text-text-muted block mt-0.5 tabular-nums">{{ creditUtilization(account) }}% usado</span>
          </div>

          <button
            v-else-if="canCreatePocket(account)"
            type="button"
            @click="openPocketModal(account)"
            :aria-label="`Agregar bolsillo a ${account.name}`"
            class="shrink-0 flex items-center gap-1.5 min-h-11 px-3 py-2 rounded-xl bg-accent-emerald/10 border border-accent-emerald/25 text-accent-emerald hover:bg-accent-emerald/15 hover:border-accent-emerald/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-emerald text-xs font-display font-semibold transition-all"
            title="Separar parte del saldo en un bolsillo"
          >
            <SavingsIcon class="w-3.5 h-3.5" />
            <span>Bolsillo</span>
          </button>
        </div>
        </div>

        <div v-if="!group.isOrphan && group.pockets.length" class="rounded-2xl border border-accent-emerald/15 bg-slate-950/35 p-3 sm:p-4 space-y-3">
          <div class="grid grid-cols-1 min-[400px]:grid-cols-3 gap-2 border-b border-white/5 pb-3 min-[400px]:text-center">
            <div class="min-w-0 flex items-baseline justify-between gap-3 min-[400px]:block">
              <p class="text-[11px] text-text-muted uppercase tracking-wide">Disponible</p>
              <p class="min-w-0 text-xs sm:text-sm font-semibold text-text-primary tabular-nums" :title="formatCurrency(accountPocketTotals(group.account.id).availableBalance, group.account.currency)"><span class="whitespace-nowrap">{{ splitMoney(formatCurrency(accountPocketTotals(group.account.id).availableBalance, group.account.currency))[0] }}</span> <span class="inline-block max-w-full truncate align-bottom whitespace-nowrap">{{ splitMoney(formatCurrency(accountPocketTotals(group.account.id).availableBalance, group.account.currency))[1] }}</span></p>
            </div>
            <div class="min-w-0 flex items-baseline justify-between gap-3 min-[400px]:block">
              <p class="text-[11px] text-text-muted uppercase tracking-wide">En bolsillos</p>
              <p class="min-w-0 text-xs sm:text-sm font-semibold text-accent-emerald tabular-nums" :title="formatCurrency(accountPocketTotals(group.account.id).pocketBalance, group.account.currency)"><span class="whitespace-nowrap">{{ splitMoney(formatCurrency(accountPocketTotals(group.account.id).pocketBalance, group.account.currency))[0] }}</span> <span class="inline-block max-w-full truncate align-bottom whitespace-nowrap">{{ splitMoney(formatCurrency(accountPocketTotals(group.account.id).pocketBalance, group.account.currency))[1] }}</span></p>
            </div>
            <div class="min-w-0 flex items-baseline justify-between gap-3 min-[400px]:block">
              <p class="text-[11px] text-text-muted uppercase tracking-wide">Total del banco</p>
              <p class="min-w-0 text-xs sm:text-sm font-semibold text-text-primary tabular-nums" :title="formatCurrency(accountPocketTotals(group.account.id).totalBalance, group.account.currency)"><span class="whitespace-nowrap">{{ splitMoney(formatCurrency(accountPocketTotals(group.account.id).totalBalance, group.account.currency))[0] }}</span> <span class="inline-block max-w-full truncate align-bottom whitespace-nowrap">{{ splitMoney(formatCurrency(accountPocketTotals(group.account.id).totalBalance, group.account.currency))[1] }}</span></p>
            </div>
          </div>
          <p class="text-[11px] text-text-muted leading-relaxed">
            El patrimonio neto ya suma el saldo disponible y cada bolsillo una sola vez.
          </p>
          <div
            v-for="pocket in group.pockets"
            :key="pocket.id"
            class="rounded-xl border border-white/5 bg-white/[0.025] px-3 py-3 flex flex-col gap-3"
          >
            <div class="min-w-0">
              <p class="text-xs font-semibold text-text-primary truncate">{{ getAccountDisplayLabel(pocket, accountsStore.accounts) }}</p>
              <p class="text-[11px] text-text-muted mt-1 break-all">Ahorros · {{ pocket.currency }} · ID {{ pocket.id }}</p>
              <p class="min-w-0 text-sm font-display font-semibold text-accent-emerald mt-1 tabular-nums" :title="formatCurrency(pocket.balance, pocket.currency)"><span class="whitespace-nowrap">{{ splitMoney(formatCurrency(pocket.balance, pocket.currency))[0] }}</span> <span class="inline-block max-w-full truncate align-bottom whitespace-nowrap">{{ splitMoney(formatCurrency(pocket.balance, pocket.currency))[1] }}</span></p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button
                type="button"
                @click="openPocketMovement(group.account, pocket, 'fund')"
                :aria-label="`Agregar dinero a ${pocket.name}`"
                class="min-h-11 px-3 py-2 rounded-lg border border-accent-emerald/20 text-accent-emerald hover:bg-accent-emerald/10 text-[11px] font-semibold transition-colors"
              >Agregar dinero</button>
              <button
                type="button"
                @click="openPocketMovement(group.account, pocket, 'withdraw')"
                :aria-label="`Retirar dinero de ${pocket.name}`"
                class="min-h-11 px-3 py-2 rounded-lg border border-white/10 text-text-secondary hover:text-text-primary hover:bg-white/5 text-[11px] font-semibold transition-colors"
              >Retirar</button>
              <div class="ml-auto -mr-1.5 flex items-center">
              <button
                type="button"
                @click="openEditModal(pocket)"
                :aria-label="`Editar bolsillo ${pocket.name}`"
                class="tap flex items-center justify-center rounded-lg text-text-muted hover:text-accent-emerald hover:bg-white/5 active:bg-white/10 transition-colors"
                title="Editar nombre del bolsillo"
              ><PencilIcon class="w-4 h-4" /></button>
              <button
                type="button"
                @click="handleDelete(pocket.id, pocket.name)"
                :aria-label="`Eliminar bolsillo ${pocket.name}`"
                class="tap flex items-center justify-center rounded-lg text-text-muted hover:text-accent-rose hover:bg-white/5 active:bg-white/10 transition-colors"
                title="Eliminar solo si está vacío y sin movimientos"
              ><TrashIcon class="w-4 h-4" /></button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Add Account Modal -->
    <BaseSheet :open="showAddModal" :close-on-backdrop="false" @close="closeAddModal">
        <template #header>
          <h3 class="font-display font-bold text-xl sm:text-2xl text-text-primary truncate">
            {{ pocketParent ? 'Crear bolsillo' : 'Agregar Cuenta' }}
          </h3>
        </template>
        <p v-if="pocketParent" class="text-text-secondary text-xs mb-4 leading-relaxed">
          El monto inicial se separa del saldo disponible de {{ pocketParent.name }}. No aumenta el total del banco ni el patrimonio neto.
        </p>
        <p v-else class="text-text-secondary text-xs mb-5">Configura los detalles de tu nueva cuenta bancaria o de efectivo.</p>

        <form id="add-account-form" @submit.prevent="saveAccount" class="space-y-4">
          <div class="space-y-1">
            <label for="new-account-name" class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">{{ pocketParent ? 'Nombre del bolsillo' : 'Nombre de la Cuenta' }}</label>
            <input 
              id="new-account-name"
              ref="pocketNameInput"
              v-model="newAcc.name" 
              type="text" 
              required
              placeholder="Ej. Tarjeta Visa Oro, Ahorros Bancolombia"
              class="field"
            />
          </div>

          <div class="grid grid-cols-1 min-[400px]:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label for="new-account-type" class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Tipo de Cuenta</label>
              <select 
                id="new-account-type"
                v-model="newAcc.type"
                :disabled="!!pocketParent"
                class="field"
              >
                <option value="checking">Corriente</option>
                <option value="savings">Ahorros</option>
                <option value="credit">Tarjeta Crédito</option>
                <option value="cash">Efectivo</option>
              </select>
            </div>

            <div class="space-y-1">
              <label for="new-account-currency" class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Moneda Base</label>
              <input 
                id="new-account-currency"
                v-model="newAcc.currency"
                autocapitalize="characters"
                autocomplete="off"
                maxlength="3"
                type="text"
                required
                :readonly="!!pocketParent"
                placeholder="COP, USD, EUR"
                class="field uppercase"
              />
            </div>
          </div>

          <div class="grid grid-cols-1 min-[400px]:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label for="new-account-balance" class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">{{ pocketParent ? 'Fondos iniciales' : 'Saldo Inicial' }}</label>
              <input 
                id="new-account-balance"
                v-model.number="newAcc.balance"
                type="number"
                inputmode="decimal"
                step="any"
                required
                :min="pocketParent ? 0 : undefined"
                :aria-describedby="pocketParent ? 'pocket-opening-note' : undefined"
                class="field"
              />
            </div>

            <div v-if="newAcc.type === 'credit'" class="space-y-1 animate-fade-in">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Cupo/Límite de Crédito</label>
              <input 
                v-model.number="newAcc.limit"
                type="number"
                inputmode="decimal"
                step="any"
                class="field"
              />
            </div>
          </div>
          <p v-if="pocketParent" id="pocket-opening-note" class="text-[10px] text-text-muted leading-relaxed">
            Banco: {{ pocketParent.name }} · moneda heredada: {{ pocketParent.currency }}. Puedes empezar con cero; no se crea una transferencia por cero.
          </p>

          <div v-if="newAcc.type === 'credit'" class="space-y-2 animate-fade-in">
            <div class="grid grid-cols-1 min-[400px]:grid-cols-2 gap-4">
              <div class="space-y-1">
                <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Día de corte</label>
                <input
                  v-model.number="newAcc.statementClosingDay"
                  type="number"
                  inputmode="numeric"
                  min="1"
                  max="31"
                  step="1"
                  placeholder="Ej. 15"
                  class="field"
                />
              </div>
              <div class="space-y-1">
                <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Día límite de pago</label>
                <input
                  v-model.number="newAcc.paymentDueDay"
                  type="number"
                  inputmode="numeric"
                  min="1"
                  max="31"
                  step="1"
                  placeholder="Ej. 30"
                  class="field"
                />
              </div>
            </div>
            <p class="text-[10px] text-text-muted">Se repiten cada mes. Son opcionales.</p>
          </div>
        </form>

        <template #footer>
          <div class="flex gap-3">
            <button type="button" @click="closeAddModal" class="flex-1 min-h-11 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all">
              Cancelar
            </button>
            <button type="submit" form="add-account-form" :disabled="loading" class="flex-1 min-h-11 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50">
              <span>{{ pocketParent ? 'Crear bolsillo' : 'Guardar' }}</span>
            </button>
          </div>
        </template>
    </BaseSheet>

    <!-- Edit Account Modal -->
    <BaseSheet :open="showEditModal" :close-on-backdrop="false" @close="closeEditAccountModal">
        <template #header>
          <h3 class="font-display font-bold text-xl sm:text-2xl text-text-primary truncate">{{ editingAccount?.parentAccountId ? 'Editar bolsillo' : 'Editar Cuenta' }}</h3>
        </template>
        <p class="text-text-secondary text-xs mb-5">
          El saldo solo cambia con movimientos. El tipo, moneda y banco de un bolsillo son heredados y no se pueden cambiar.
        </p>

        <form id="edit-account-form" @submit.prevent="saveEditedAccount" class="space-y-4">
          <div class="space-y-1">
            <label for="edit-account-name" class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Nombre de la Cuenta</label>
            <input
              id="edit-account-name"
              ref="editAccountNameInput"
              v-model="editAcc.name"
              type="text"
              required
              class="field"
            />
          </div>

          <div class="grid grid-cols-1 min-[400px]:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label for="edit-account-type" class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Tipo de Cuenta</label>
              <select
                id="edit-account-type"
                v-model="editAcc.type"
                :disabled="!!editingAccount?.parentAccountId"
                class="field"
              >
                <option value="checking">Corriente</option>
                <option value="savings">Ahorros</option>
                <option value="credit">Tarjeta Crédito</option>
                <option value="cash">Efectivo</option>
              </select>
            </div>

            <div class="space-y-1">
              <label for="edit-account-currency" class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Moneda Base</label>
              <input
                id="edit-account-currency"
                v-model="editAcc.currency"
                autocapitalize="characters"
                autocomplete="off"
                maxlength="3"
                type="text"
                required
                :readonly="!!editingAccount?.parentAccountId"
                placeholder="COP, USD, EUR"
                class="field uppercase"
              />
            </div>
          </div>

          <div v-if="editAcc.type === 'credit'" class="space-y-1 animate-fade-in">
            <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Cupo/Límite de Crédito</label>
            <input
              v-model.number="editAcc.limit"
              type="number"
              inputmode="decimal"
              step="any"
              class="field"
            />
          </div>

          <div v-if="editAcc.type === 'credit'" class="space-y-2 animate-fade-in">
            <div class="grid grid-cols-1 min-[400px]:grid-cols-2 gap-4">
              <div class="space-y-1">
                <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Día de corte</label>
                <input
                  v-model.number="editAcc.statementClosingDay"
                  type="number"
                  inputmode="numeric"
                  min="1"
                  max="31"
                  step="1"
                  placeholder="Ej. 15"
                  class="field"
                />
              </div>
              <div class="space-y-1">
                <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Día límite de pago</label>
                <input
                  v-model.number="editAcc.paymentDueDay"
                  type="number"
                  inputmode="numeric"
                  min="1"
                  max="31"
                  step="1"
                  placeholder="Ej. 30"
                  class="field"
                />
              </div>
            </div>
            <p class="text-[10px] text-text-muted">Se repiten cada mes. Son opcionales.</p>
          </div>

          <!-- Espejo entre workspaces (cuenta puente) -->
          <div v-if="otherWorkspaces.length && !editingAccount?.parentAccountId" class="rounded-2xl border border-accent-violet/20 bg-accent-violet/[0.04] p-4 space-y-3.5">
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
                class="field focus:border-accent-violet"
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
                    class="field focus:border-accent-violet"
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
                    class="field focus:border-accent-violet"
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
        </form>

        <template #footer>
          <div class="flex gap-3">
            <button type="button" @click="closeEditAccountModal" class="flex-1 min-h-11 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all">
              Cancelar
            </button>
            <button type="submit" form="edit-account-form" :disabled="loading" class="flex-1 min-h-11 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50">
              <span>Guardar</span>
            </button>
          </div>
        </template>
    </BaseSheet>

    <!-- Settle Mirror Modal -->
    <BaseSheet
      :open="!!settleAccount"
      title="Liquidar puente"
      panel-class="mirror-ledger border-accent-violet/25"
      @close="settleAccount = null"
    >
      <template v-if="settleAccount">
        <p class="text-text-secondary text-xs mb-5">
          La plata pasa de verdad de este workspace a {{ mirrorWorkspaceName(settleAccount) }}. No toca presupuestos.
        </p>

        <!-- Deuda pendiente, protagonista -->
        <div class="mb-6 rounded-2xl border border-accent-violet/25 bg-accent-violet/[0.06] px-4 sm:px-5 py-4">
          <span class="text-[11px] font-semibold text-accent-violet/80 uppercase tracking-widest block">Pendiente de reembolso</span>
          <span class="min-w-0 font-display font-bold text-xl min-[400px]:text-2xl sm:text-3xl text-text-primary mt-1 block tracking-tight tabular-nums" :title="formatCurrency(settleDebt, settleAccount.currency)">
            <span class="whitespace-nowrap">{{ splitMoney(formatCurrency(settleDebt, settleAccount.currency))[0] }}</span> <span class="inline-block max-w-full truncate align-bottom whitespace-nowrap">{{ splitMoney(formatCurrency(settleDebt, settleAccount.currency))[1] }}</span>
          </span>
        </div>

        <form id="settle-mirror-form" @submit.prevent="saveSettlement" class="space-y-4">
          <div class="grid grid-cols-1 min-[400px]:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Monto a liquidar</label>
              <input
                v-model.number="settleForm.amount"
                type="number"
                inputmode="decimal"
                step="any"
                required
                class="field focus:border-accent-violet"
              />
            </div>
            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Fecha</label>
              <input
                v-model="settleForm.date"
                type="date"
                required
                class="field focus:border-accent-violet"
              />
            </div>
          </div>

          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Sale de (este workspace)</label>
            <select
              v-model="settleForm.fromAccountId"
              required
              class="field focus:border-accent-violet"
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
              class="field focus:border-accent-violet"
            >
              <option value="" disabled>{{ loadingMirrorAccounts ? 'Cargando cuentas…' : 'Selecciona cuenta' }}</option>
              <option v-for="acc in settleDestinationAccounts" :key="acc.id" :value="acc.id">
                {{ acc.name }} ({{ acc.currency }})
              </option>
            </select>
          </div>
        </form>
      </template>

        <template #footer>
          <div class="flex gap-3">
            <button
              type="button"
              @click="settleAccount = null"
              class="flex-1 min-h-11 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all"
            >
              Cancelar
            </button>
            <button
              type="submit"
              form="settle-mirror-form"
              :disabled="loading"
              class="flex-1 min-h-11 py-2.5 rounded-xl bg-accent-violet hover:bg-accent-violet/80 text-white font-display font-semibold text-sm cursor-pointer disabled:opacity-50 transition-all"
              style="box-shadow: var(--shadow-glow-violet)"
            >
              <span>Liquidar</span>
            </button>
          </div>
        </template>
    </BaseSheet>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAccountsStore } from '@/stores/accountsStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { useAuthStore } from '@/stores/authStore'
import { Account, AccountType } from '@/types'
import { AccountSchema } from '@/schemas'
import { getNextOccurrence, daysUntil, expenseAmountForCycle } from '@/lib/creditCycle'
import { toLocalDateKey } from '@/lib/dates'
import { splitMoney } from '@/lib/money'
import {
  canTransferBetweenAccounts,
  getAccountDisplayLabel,
  getAccountPocketTotals,
  groupAccountsByPocket,
  isPocketAccount
} from '@/lib/pockets'
import {
  Plus as PlusIcon,
  Trash2 as TrashIcon,
  Pencil as PencilIcon,
  PiggyBank as SavingsIcon,
  CreditCard as CreditIcon,
  Wallet as CashIcon,
  Building as BankIcon,
  ArrowLeftRight as MirrorIcon,
  Banknote as SettleIcon
} from 'lucide-vue-next'
import BaseSheet from '@/components/ui/BaseSheet.vue'

const accountsStore = useAccountsStore()
const workspacesStore = useWorkspacesStore()
const transactionsStore = useTransactionsStore()
const authStore = useAuthStore()
const router = useRouter()

const showAddModal = ref(false)
const showEditModal = ref(false)
const loading = ref(false)
const pocketParent = ref<Account | null>(null)
const pocketNameInput = ref<HTMLInputElement | null>(null)
const editAccountNameInput = ref<HTMLInputElement | null>(null)
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

const accountGroups = computed(() => groupAccountsByPocket(accountsStore.accounts, authStore.activeWorkspaceId || undefined))
const editingAccountId = ref('')
const editingAccount = computed(() => accountsStore.accounts.find(account => account.id === editingAccountId.value) ?? null)

const canCreatePocket = (account: Account) =>
  !isPocketAccount(account) && !account.mirror && ['checking', 'savings'].includes(account.type)

const accountPocketTotals = (parentId: string) => getAccountPocketTotals(parentId, accountsStore.accounts)

const openPocketMovement = async (parent: Account, pocket: Account, direction: 'fund' | 'withdraw') => {
  const source = direction === 'fund' ? parent : pocket
  const destination = direction === 'fund' ? pocket : parent
  if (!canTransferBetweenAccounts(source, destination, accountsStore.accounts)) {
    alert('No se puede mover dinero entre estas cuentas: revisa el workspace, la moneda y el estado del bolsillo.')
    return
  }
  await router.push({
    path: '/transactions',
    query: {
      pocketTransfer: '1',
      fromAccountId: source.id,
      toAccountId: destination.id
    }
  })
}

// --- Cuentas puente (espejo entre workspaces) ---

const otherWorkspaces = computed(() =>
  workspacesStore.workspaces.filter(ws => ws.id !== authStore.activeWorkspaceId)
)

const mirrorWorkspaceName = (account: Account) =>
  workspacesStore.workspaces.find(ws => ws.id === account.mirror?.workspaceId)?.name || 'otro workspace'

// El saldo de un puente no es plata: es deuda. Se muestra en absoluto con etiqueta explícita.
const balanceLabel = (account: Account) => {
  if (!account.mirror) return 'SALDO DISPONIBLE'
  if (account.balance < 0) return 'DEBES'
  if (account.balance > 0) return 'TE DEBEN'
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
  pocketParent.value = null
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

const openNewAccountModal = async () => {
  closeAddModal()
  showAddModal.value = true
  await nextTick()
  pocketNameInput.value?.focus()
}

const openPocketModal = async (parent: Account) => {
  if (!canCreatePocket(parent)) return
  pocketParent.value = parent
  newAcc.value = {
    name: '',
    type: 'savings',
    balance: 0,
    limit: 0,
    currency: parent.currency,
    statementClosingDay: null,
    paymentDueDay: null
  }
  showAddModal.value = true
  await nextTick()
  pocketNameInput.value?.focus()
}

const saveAccount = async () => {
  if (pocketParent.value && (!Number.isFinite(newAcc.value.balance) || newAcc.value.balance < 0)) {
    alert('Los fondos iniciales del bolsillo deben ser un monto válido y no negativo.')
    return
  }

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
    if (pocketParent.value) {
      await accountsStore.addPocket({
        name: newAcc.value.name,
        balance: newAcc.value.balance,
        currency: pocketParent.value.currency,
        parentAccountId: pocketParent.value.id
      })
    } else {
      await accountsStore.addAccount({
        name: newAcc.value.name,
        type: newAcc.value.type,
        balance: newAcc.value.balance,
        limit: newAcc.value.limit,
        currency: newAcc.value.currency.toUpperCase(),
        statementClosingDay: newAcc.value.statementClosingDay || null,
        paymentDueDay: newAcc.value.paymentDueDay || null
      })
    }
    closeAddModal()
  } catch (err) {
    console.error('Error al guardar cuenta:', err)
    alert(err instanceof Error ? err.message : 'No se pudo guardar la cuenta.')
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
const openEditModal = async (account: Account) => {
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
  await nextTick()
  editAccountNameInput.value?.focus()
}

const closeEditAccountModal = () => {
  showEditModal.value = false
  editingAccountId.value = ''
  editMirror.value = emptyMirror()
  mirrorAccounts.value = []
}

const saveEditedAccount = async () => {
  const accountBeingEdited = editingAccount.value
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
    if (!accountBeingEdited?.parentAccountId) {
      await accountsStore.setAccountMirror(
        editingAccountId.value,
        workspaceId ? { workspaceId, sourceAccountId, accountId } : null
      )
    }
    closeEditAccountModal()
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

watch(() => authStore.activeWorkspaceId, (workspaceId, previousWorkspaceId) => {
  if (workspaceId === previousWorkspaceId) return
  closeAddModal()
  closeEditAccountModal()
  settleAccount.value = null
})

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
    date: toLocalDateKey()
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

// Días hasta el próximo corte / próxima fecha de pago (ciclo de facturación, no mes calendario)
const closingDaysUntil = (account: Account) =>
  account.statementClosingDay ? daysUntil(getNextOccurrence(account.statementClosingDay)) : 0

const dueDaysUntil = (account: Account) =>
  account.paymentDueDay ? daysUntil(getNextOccurrence(account.paymentDueDay)) : 0

// Total a pagar en el próximo corte: suma las cuotas de este ciclo de facturación
// para todas las transacciones de la cuenta.
const cycleChargeAmount = (account: Account) => {
  if (!account.statementClosingDay) return 0
  return transactionsStore.transactions
    .filter(t => t.accountId === account.id)
    .reduce((sum, t) => sum + expenseAmountForCycle(t, account.statementClosingDay!), 0)
}

const handleDelete = async (id: string, name: string) => {
  const account = accountsStore.getAccountById(id)
  const warning = account && isPocketAccount(account)
    ? `Solo se puede eliminar el bolsillo "${name}" si tiene saldo cero y no conserva movimientos; el historial no se borra.`
    : account?.childAccountIds?.length
      ? `La cuenta "${name}" tiene bolsillos vinculados. Primero elimina únicamente los bolsillos vacíos y sin movimientos; el historial no se borra.`
      : `¿Estás seguro de que deseas eliminar la cuenta "${name}"? Todas las transacciones asociadas ya no estarán vinculadas.`
  if (confirm(warning)) {
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
