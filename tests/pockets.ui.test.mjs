import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createServer as createViteServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { createPocketFixture } from './pockets.fixtures.mjs'

const repositoryRoot = resolve(import.meta.dirname, '..')
const projectId = 'demo-vault-pockets'
const testRequire = createRequire(import.meta.url)
const tailwindCssEntry = createRequire(testRequire.resolve('@tailwindcss/vite')).resolve('tailwindcss/index.css')

test('authenticated demo bank account exposes the pocket creation action', { timeout: 90_000 }, async () => {
  assert.equal(process.env.GCLOUD_PROJECT, projectId, 'browser proof must use the demo project only')
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080')
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9099')
  assert.ok(process.env.POCKETS_PLAYWRIGHT_PACKAGE, 'cached Playwright package must be resolved before isolated HOME')
  assert.ok(process.env.POCKETS_CHROMIUM_EXECUTABLE, 'cached Chromium executable must be resolved before isolated HOME')

  const browserRequire = createRequire(process.env.POCKETS_PLAYWRIGHT_PACKAGE)
  const playwright = browserRequire('playwright')
  assert.equal(browserRequire('playwright/package.json').version, '1.63.0')
  const temporaryCache = mkdtempSync(join(tmpdir(), 'pockets-ui-vite-cache-'))
  let fixture
  let vite
  let browser
  try {
    fixture = await createPocketFixture()
    const bankId = 'ui-bank-account'
    await fixture.adminDb.collection('accounts').doc(bankId).set({
      id: bankId,
      workspaceId: fixture.workspaceId,
      userId: fixture.identity.user.uid,
      name: 'Cuenta principal',
      type: 'checking',
      balance: 1_000,
      limit: 0,
      currency: 'COP',
      createdAt: new Date()
    })
    await fixture.adminDb.collection('goals').doc('ui-pocket-goal').set({
      id: 'ui-pocket-goal',
      workspaceId: fixture.workspaceId,
      userId: fixture.identity.user.uid,
      name: 'Meta UI',
      targetAmount: 2_000,
      currentAmount: 0,
      currency: 'COP',
      targetDate: new Date('2027-01-01T12:00:00.000Z'),
      createdAt: new Date()
    })
    const secondaryWorkspaceId = `${fixture.workspaceId}-secondary`
    await fixture.adminDb.collection('workspaces').doc(secondaryWorkspaceId).set({
      id: secondaryWorkspaceId,
      name: 'Secondary UI workspace',
      ownerId: fixture.identity.user.uid,
      members: [fixture.identity.user.uid],
      currency: 'COP'
    })
    await fixture.adminDb.collection('accounts').doc('ui-secondary-account').set({
      id: 'ui-secondary-account',
      workspaceId: secondaryWorkspaceId,
      userId: fixture.identity.user.uid,
      name: 'Cuenta secundaria',
      type: 'checking',
      balance: 500,
      limit: 0,
      currency: 'COP',
      createdAt: new Date()
    })
    await fixture.adminDb.collection('users').doc(fixture.identity.user.uid).update({
      workspaces: [fixture.workspaceId, secondaryWorkspaceId]
    })
    const [seededAccount, seededProfile, seededWorkspace] = await Promise.all([
      fixture.adminDb.collection('accounts').doc(bankId).get(),
      fixture.adminDb.collection('users').doc(fixture.identity.user.uid).get(),
      fixture.adminDb.collection('workspaces').doc(fixture.workspaceId).get()
    ])
    const adminReadback = {
      accountExists: seededAccount.exists,
      accountWorkspaceMatches: seededAccount.data()?.workspaceId === fixture.workspaceId,
      accountUserMatches: seededAccount.data()?.userId === fixture.identity.user.uid,
      profileExists: seededProfile.exists,
      profileWorkspaceMatches: seededProfile.data()?.activeWorkspaceId === fixture.workspaceId,
      workspaceExists: seededWorkspace.exists,
      workspaceMemberMatches: seededWorkspace.data()?.members?.includes(fixture.identity.user.uid) === true
    }

    vite = await createViteServer({
      configFile: false,
      envDir: false,
      root: repositoryRoot,
      cacheDir: temporaryCache,
      mode: 'test',
      logLevel: 'error',
      plugins: [
        vue(),
        tailwindcss(),
        {
          name: 'pockets-ui-remove-external-fonts',
          transformIndexHtml(html) {
            return html
              .replace(/<link\s+rel="preconnect"\s+href="https:\/\/fonts\.googleapis\.com"[^>]*>\s*/g, '')
              .replace(/<link\s+rel="preconnect"\s+href="https:\/\/fonts\.gstatic\.com"[^>]*>\s*/g, '')
              .replace(/<link\s+href="https:\/\/fonts\.googleapis\.com[^>]*>\s*/g, '')
          }
        }
      ],
      resolve: {
        alias: [
          { find: '@', replacement: resolve(repositoryRoot, 'src') },
          { find: /^tailwindcss$/, replacement: tailwindCssEntry }
        ]
      },
      define: {
        'import.meta.env.BASE_URL': JSON.stringify('/'),
        'import.meta.env.MODE': JSON.stringify('test'),
        'import.meta.env.DEV': JSON.stringify(true),
        'import.meta.env.PROD': JSON.stringify(false),
        'import.meta.env.SSR': JSON.stringify(false),
        'import.meta.env.VITE_FIREBASE_API_KEY': JSON.stringify('emulator-only-fixture-key'),
        'import.meta.env.VITE_FIREBASE_AUTH_DOMAIN': JSON.stringify(`${projectId}.firebaseapp.com`),
        'import.meta.env.VITE_FIREBASE_PROJECT_ID': JSON.stringify(projectId),
        'import.meta.env.VITE_FIREBASE_STORAGE_BUCKET': JSON.stringify(`${projectId}.appspot.com`),
        'import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID': JSON.stringify('123456789'),
        'import.meta.env.VITE_FIREBASE_APP_ID': JSON.stringify('1:123456789:web:pocket-ui-fixture')
      },
      server: { host: '127.0.0.1', port: 4173, strictPort: true }
    })
    await vite.listen()

    browser = await playwright.chromium.launch({
      executablePath: process.env.POCKETS_CHROMIUM_EXECUTABLE,
      headless: true
    })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const blockedRequests = []
    const callableRequests = []
    const callableResponses = []
    let parserStubCount = 0
    await context.route('**/*', async route => {
      const requestUrl = new URL(route.request().url())
      if (requestUrl.hostname === 'localhost' && requestUrl.pathname.endsWith('/importPocketStatement')) {
        callableRequests.push({ method: route.request().method(), path: requestUrl.pathname })
      }
      if (requestUrl.hostname === 'localhost' && requestUrl.pathname.endsWith('/parseStatement') && route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': 'http://127.0.0.1:4173',
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'content-type,authorization'
          }
        })
        return
      }
      if (requestUrl.hostname === 'localhost' && requestUrl.pathname.endsWith('/parseStatement')) {
        parserStubCount++
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': 'http://127.0.0.1:4173' },
          body: JSON.stringify({ transactions: [{
            date: '2026-10-10T12:00:00.000Z',
            description: 'Pocket UI statement income',
            amount: 20,
            categorySuggestion: 'Otros'
          }] })
        })
        return
      }
      if (['127.0.0.1', 'localhost', '[::1]'].includes(requestUrl.hostname) || ['data:', 'blob:'].includes(requestUrl.protocol)) {
        await route.continue()
      } else {
        blockedRequests.push(requestUrl.origin)
        await route.abort()
      }
    })
    const page = await context.newPage()
    let pageErrorCount = 0
    let consoleErrorCount = 0
    let expectedPocketRejectionConsoleCount = 0
    const consoleErrorCodes = []
    const consoleErrorSummaries = []
    page.on('pageerror', () => pageErrorCount++)
    page.on('console', message => {
      if (message.type() === 'error') {
        const text = message.text()
        if (text.includes('El saldo disponible de un bolsillo o cuenta principal no puede ser negativo.')) {
          expectedPocketRejectionConsoleCount++
        } else {
          consoleErrorCount++
        }
        const code = text.match(/(?:functions|firestore|auth)\/[a-z-]+/i)?.[0] ?? null
        if (code) consoleErrorCodes.push(code)
        const summary = text.split('\n')[0]
          .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
          .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
          .replace(/[A-Za-z0-9_-]{24,}/g, '[opaque-id]')
          .slice(0, 180)
        consoleErrorSummaries.push(summary)
      }
    })
    page.on('response', response => {
      const responseUrl = new URL(response.url())
      if (responseUrl.hostname === 'localhost' && responseUrl.pathname.endsWith('/importPocketStatement')) {
        callableResponses.push({ method: response.request().method(), path: responseUrl.pathname, status: response.status() })
      }
    })
    await page.goto('http://127.0.0.1:4173/login')
    const emailInput = page.getByLabel('Correo Electrónico')
    try {
      await emailInput.waitFor({ state: 'visible', timeout: 15_000 })
    } catch (error) {
      throw new Error(`Login form did not render: ${JSON.stringify({ pageErrorCount, consoleErrorCount })}`, { cause: error })
    }
    await emailInput.fill(fixture.identity.user.email)
    await page.getByLabel('Contraseña').fill('emulator-password-123')
    await page.getByRole('button', { name: 'Ingresar a la Bóveda' }).click()
    await page.waitForURL('http://127.0.0.1:4173/')
    await page.goto('http://127.0.0.1:4173/accounts')
    await page.getByRole('heading', { name: 'Cuentas Financieras' }).waitFor()

    const bankCard = page.getByRole('heading', { name: 'Cuenta principal', exact: true })
    await bankCard.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
    const browserState = await page.evaluate(async ({ expectedUid, expectedWorkspaceId }) => {
      try {
        const [{ app }, { useAuthStore }, { useAccountsStore }] = await Promise.all([
          import('/src/lib/firebase.ts'),
          import('/src/stores/authStore.ts'),
          import('/src/stores/accountsStore.ts')
        ])
        const auth = useAuthStore()
        const accounts = useAccountsStore()
        return {
          projectMatches: app.options.projectId === 'demo-vault-pockets',
          authLoading: auth.loading,
          uidMatches: auth.user?.uid === expectedUid,
          profileWorkspaceMatches: auth.profile?.activeWorkspaceId === expectedWorkspaceId,
          activeWorkspaceMatches: auth.activeWorkspaceId === expectedWorkspaceId,
          accountsLoading: accounts.loading,
          seededAccountInStore: accounts.accounts.some(account => account.id === 'ui-bank-account'),
          accountCount: accounts.accounts.length
        }
      } catch {
        return { stateReadFailed: true }
      }
    }, { expectedUid: fixture.identity.user.uid, expectedWorkspaceId: fixture.workspaceId })
    const dom = {
      accountHeadingVisible: await page.getByRole('heading', { name: 'Cuentas Financieras' }).isVisible(),
      seededAccountVisible: await bankCard.isVisible().catch(() => false),
      emptyStateVisible: await page.getByText('No hay cuentas registradas. Agrega una para comenzar.', { exact: true }).isVisible().catch(() => false),
      loadingMarkerVisible: /cargando|loading/i.test(await page.locator('body').innerText())
    }
    console.log('POCKET_UI_SETUP_READBACK ' + JSON.stringify({
      adminReadback,
      browserState,
      blockedExternalOrigins: blockedRequests,
      pageErrorCount,
      consoleErrorCount,
      dom
    }))
    assert.deepEqual(blockedRequests, [], 'browser requests must stay on loopback after external fonts are removed')
    assert.equal(adminReadback.accountExists, true, 'the emulator must contain the seeded bank account')
    assert.equal(adminReadback.profileExists, true, 'the emulator must contain the authenticated user profile')
    assert.equal(adminReadback.workspaceExists, true, 'the emulator must contain the active workspace')
    assert.equal(browserState.projectMatches, true, 'the actual browser Firebase app must use the demo project')
    assert.equal(browserState.uidMatches, true, 'the actual browser session must match the seeded user')
    assert.equal(browserState.profileWorkspaceMatches, true, 'the browser must hydrate the seeded user profile')
    assert.equal(browserState.activeWorkspaceMatches, true, 'the browser must activate the seeded workspace')
    assert.equal(browserState.seededAccountInStore, true, 'the actual accounts store must load the seeded account')
    assert.equal(dom.seededAccountVisible, true, 'the real Admin-seeded bank must render before pocket UI assertions')
    assert.equal(
      await page.getByRole('button', { name: 'Agregar bolsillo a Cuenta principal', exact: true }).count(),
      1,
      'bank cards need an explicit action to create a pocket'
    )

    await page.getByRole('button', { name: 'Agregar bolsillo a Cuenta principal', exact: true }).click()
    const pocketDialog = page.getByRole('dialog', { name: 'Crear bolsillo' })
    await pocketDialog.getByLabel('Nombre del bolsillo').fill('Viaje')
    await pocketDialog.getByLabel('Fondos iniciales').fill('300')
    const creationDialogs = []
    const acceptCreationDialog = async dialog => {
      creationDialogs.push({ type: dialog.type(), message: dialog.message() })
      await dialog.accept()
    }
    page.on('dialog', acceptCreationDialog)
    await pocketDialog.getByRole('button', { name: 'Crear bolsillo' }).click()
    await page.waitForTimeout(250)
    page.off('dialog', acceptCreationDialog)
    const createdChildren = await fixture.adminDb.collection('accounts').where('parentAccountId', '==', bankId).get()
    const parentAfterCreate = await fixture.adminDb.collection('accounts').doc(bankId).get()
    const createdChild = createdChildren.docs[0]
    const createdChildData = createdChild?.data()
    console.log('POCKET_UI_CREATE_READBACK ' + JSON.stringify({
      childCount: createdChildren.size,
      parentRegistryIds: parentAfterCreate.data()?.childAccountIds ?? [],
      child: createdChild ? {
        id: createdChild.id,
        name: createdChildData.name,
        workspaceId: createdChildData.workspaceId,
        currency: createdChildData.currency,
        type: createdChildData.type,
        parentAccountId: createdChildData.parentAccountId
      } : null,
      alerts: creationDialogs
    }))
    assert.equal(createdChildren.size, 1, 'pocket creation must persist one child through the real client store')
    const bankGroup = page.locator('.grid > div.space-y-3').filter({
      has: page.getByRole('heading', { name: 'Cuenta principal', exact: true })
    }).first()
    const qualifiedPocketName = bankGroup.getByText('Cuenta principal › Viaje', { exact: true })
    await qualifiedPocketName.waitFor({ state: 'visible' })
    assert.ok(await qualifiedPocketName.evaluate(element => element.getBoundingClientRect().width > 0), 'qualified pocket name must have visible width in its bank group')

    const readBalances = async () => {
      const parent = await fixture.adminDb.collection('accounts').doc(bankId).get()
      const childQuery = await fixture.adminDb.collection('accounts').where('parentAccountId', '==', bankId).get()
      const child = childQuery.docs.find(snapshot => snapshot.data().name === 'Viaje')
      assert.ok(child, 'funded creation should persist the named child account')
      const allocationId = child.data().openingAllocationId
      const allocation = allocationId
        ? await fixture.adminDb.collection('transactions').doc(allocationId).get()
        : null
      return {
        parentBalance: parent.data()?.balance ?? null,
        registryIds: parent.data()?.childAccountIds ?? [],
        pocketBalance: child.data().balance,
        pocketId: child.id,
        openingAllocationId: allocationId ?? null,
        allocationType: allocation?.data()?.type ?? null,
        allocationAmount: Math.abs(allocation?.data()?.amount ?? 0),
        allocationCategoryId: allocation?.data()?.categoryId ?? null
      }
    }
    const fundedState = await readBalances()
    assert.equal(fundedState.parentBalance, 700)
    assert.equal(fundedState.pocketBalance, 300)
    assert.ok(fundedState.registryIds.includes(fundedState.pocketId))
    assert.equal(fundedState.allocationType, 'transfer')
    assert.equal(fundedState.allocationAmount, 300)
    const summary = await bankGroup.getByText('Total del banco', { exact: true }).locator('..').locator('..').locator('p').allTextContents()
    const displayedTotals = summary.filter((_, index) => index % 2 === 1).map(value => Number(value.replace(/\D/g, '')))
    assert.deepEqual(displayedTotals, [700, 300, 1_000], 'available, pocket, and total figures must conserve the recorded bank balance')
    const netWorthLabel = page.getByText('Patrimonio Neto (COP)', { exact: true })
    assert.equal(Number((await netWorthLabel.locator('..').locator('h3').innerText()).replace(/\D/g, '')), 1_000)
    console.log('POCKET_UI_FUNDED_READBACK ' + JSON.stringify(fundedState))

    // Verify a real browser reload hydrates the authenticated app, workspace, and pocket group.
    await page.reload()
    await page.getByRole('heading', { name: 'Cuenta principal', exact: true }).waitFor({ state: 'visible' })
    await page.waitForFunction(async ({ expectedUid, expectedWorkspaceId, expectedPocketId }) => {
      const [{ app: firebaseApp, auth: firebaseAuth }, { useAuthStore }, { useAccountsStore }] = await Promise.all([
        import('/src/lib/firebase.ts'),
        import('/src/stores/authStore.ts'),
        import('/src/stores/accountsStore.ts')
      ])
      const auth = useAuthStore()
      const accounts = useAccountsStore()
      return firebaseApp.options.projectId === 'demo-vault-pockets'
        && auth.user?.uid === expectedUid
        && firebaseAuth.currentUser?.uid === expectedUid
        && auth.profile?.activeWorkspaceId === expectedWorkspaceId
        && auth.activeWorkspaceId === expectedWorkspaceId
        && accounts.accounts.some(account => account.id === 'ui-bank-account')
        && accounts.accounts.some(account => account.id === expectedPocketId)
        && !accounts.loading
    }, { expectedUid: fixture.identity.user.uid, expectedWorkspaceId: fixture.workspaceId, expectedPocketId: fundedState.pocketId })
    const reloadedPocket = page.getByText('Cuenta principal › Viaje', { exact: true })
    await reloadedPocket.waitFor({ state: 'visible' })
    const reloadReadback = await page.evaluate(async expectedPocketId => {
      const [{ app: firebaseApp, auth: firebaseAuth }, { useAuthStore }, { useAccountsStore }] = await Promise.all([
        import('/src/lib/firebase.ts'),
        import('/src/stores/authStore.ts'),
        import('/src/stores/accountsStore.ts')
      ])
      const auth = useAuthStore()
      const accounts = useAccountsStore()
      return {
        projectId: firebaseApp.options.projectId,
        firebaseAuthUid: firebaseAuth.currentUser?.uid ?? null,
        uid: auth.user?.uid ?? null,
        profileWorkspaceId: auth.profile?.activeWorkspaceId ?? null,
        activeWorkspaceId: auth.activeWorkspaceId,
        parentLoaded: accounts.accounts.some(account => account.id === 'ui-bank-account'),
        pocketLoaded: accounts.accounts.some(account => account.id === expectedPocketId),
        pocketVisible: [...document.querySelectorAll('*')].some(element => element.textContent?.trim() === 'Cuenta principal › Viaje' && element.getBoundingClientRect().width > 0)
      }
    }, fundedState.pocketId)
    assert.deepEqual(reloadReadback, {
      projectId: 'demo-vault-pockets',
      firebaseAuthUid: fixture.identity.user.uid,
      uid: fixture.identity.user.uid,
      profileWorkspaceId: fixture.workspaceId,
      activeWorkspaceId: fixture.workspaceId,
      parentLoaded: true,
      pocketLoaded: true,
      pocketVisible: true
    }, 'a full reload must hydrate real account and pocket data in the authenticated workspace')
    const durableReloadBalance = await readBalances()
    assert.equal(durableReloadBalance.parentBalance, 700)
    assert.equal(durableReloadBalance.pocketBalance, 300)
    console.log('POCKET_UI_RELOAD_READBACK ' + JSON.stringify({ ...reloadReadback, parentBalance: durableReloadBalance.parentBalance, pocketBalance: durableReloadBalance.pocketBalance, total: durableReloadBalance.parentBalance + durableReloadBalance.pocketBalance }))

    const beforeZeroPocketTransactions = (await fixture.adminDb.collection('transactions').where('workspaceId', '==', fixture.workspaceId).get()).size
    await page.getByRole('button', { name: 'Agregar bolsillo a Cuenta principal', exact: true }).click()
    const zeroPocketDialog = page.getByRole('dialog', { name: 'Crear bolsillo' })
    await zeroPocketDialog.getByLabel('Nombre del bolsillo').fill('Reserva')
    await zeroPocketDialog.getByLabel('Fondos iniciales').fill('0')
    await zeroPocketDialog.getByRole('button', { name: 'Crear bolsillo' }).click()
    await bankGroup.getByText('Cuenta principal › Reserva', { exact: true }).waitFor({ state: 'visible' })
    const zeroChild = (await fixture.adminDb.collection('accounts').where('parentAccountId', '==', bankId).get())
      .docs.find(snapshot => snapshot.data().name === 'Reserva')
    const afterZeroPocketTransactions = (await fixture.adminDb.collection('transactions').where('workspaceId', '==', fixture.workspaceId).get()).size
    assert.ok(zeroChild)
    assert.equal(zeroChild.data().balance, 0)
    assert.equal(zeroChild.data().openingAllocationId ?? null, null, 'a zero pocket must not create an allocation transfer')
    assert.equal(afterZeroPocketTransactions, beforeZeroPocketTransactions, 'zero-balance creation must not add transaction history')
    console.log('POCKET_UI_ZERO_READBACK ' + JSON.stringify({ childId: zeroChild.id, balance: 0, transactionsBefore: beforeZeroPocketTransactions, transactionsAfter: afterZeroPocketTransactions }))

    const createTransfer = async (actionName, direction, amount, description) => {
      await page.getByRole('button', { name: actionName }).click()
      await page.getByRole('heading', { name: 'Nueva Transacción' }).waitFor({ state: 'visible' })
      const form = page.locator('form').filter({ hasText: 'Desde Cuenta' })
      const selects = form.locator('select')
      assert.equal(await selects.nth(0).inputValue(), direction === 'withdraw' ? fundedState.pocketId : bankId)
      assert.equal(await selects.nth(1).inputValue(), direction === 'withdraw' ? bankId : fundedState.pocketId)
      await form.locator('input[type="number"]').first().fill(String(amount))
      await form.locator('input[placeholder^="Ej. Compra"]').fill(description)
      await form.locator('button[type="submit"]').click()
      await page.getByRole('heading', { name: 'Nueva Transacción' }).waitFor({ state: 'hidden' })
    }

    await createTransfer(/Agregar dinero a Viaje/, 'fund', 50, 'Pocket UI movement')
    const afterMovement = await readBalances()
    assert.equal(afterMovement.parentBalance, 650)
    assert.equal(afterMovement.pocketBalance, 350)
    const fundedMovement = (await fixture.adminDb.collection('transactions').where('workspaceId', '==', fixture.workspaceId).get())
      .docs.find(snapshot => snapshot.data().description === 'Pocket UI movement')
    assert.ok(fundedMovement, 'funding action must persist its movement through the transaction store')
    assert.equal(fundedMovement.data().type, 'transfer')
    assert.equal(fundedMovement.data().accountId, bankId)
    assert.equal(fundedMovement.data().toAccountId, fundedState.pocketId)

    const fundedRow = page.locator('tr').filter({ hasText: 'Pocket UI movement' })
    await fundedRow.locator('button[title="Editar Transacción"]').click()
    const editForm = page.locator('form').filter({ hasText: 'Desde Cuenta' })
    await editForm.locator('input[type="number"]').first().fill('40')
    await editForm.locator('input[placeholder^="Ej. Compra"]').fill('Pocket UI edited movement')
    await editForm.locator('button[type="submit"]').click()
    await page.getByRole('heading', { name: 'Editar Transacción' }).waitFor({ state: 'hidden' })
    const afterEdit = await readBalances()
    assert.equal(afterEdit.parentBalance, 660)
    assert.equal(afterEdit.pocketBalance, 340)

    const editedRow = page.locator('tr').filter({ hasText: 'Pocket UI edited movement' })
    page.once('dialog', dialog => dialog.accept())
    await editedRow.locator('button[title="Eliminar Transacción"]').click()
    await editedRow.waitFor({ state: 'detached' })
    const afterReversal = await readBalances()
    assert.equal(afterReversal.parentBalance, 700)
    assert.equal(afterReversal.pocketBalance, 300)

    await page.goto('http://127.0.0.1:4173/accounts')
    await page.getByRole('button', { name: /Retirar dinero de Viaje/ }).click()
    await page.getByRole('heading', { name: 'Nueva Transacción' }).waitFor({ state: 'visible' })
    const withdrawForm = page.locator('form').filter({ hasText: 'Desde Cuenta' })
    assert.equal(await withdrawForm.locator('select').nth(0).inputValue(), fundedState.pocketId)
    assert.equal(await withdrawForm.locator('select').nth(1).inputValue(), bankId)
    await withdrawForm.locator('input[type="number"]').first().fill('25')
    await withdrawForm.locator('input[placeholder^="Ej. Compra"]').fill('Pocket UI withdrawal')
    await withdrawForm.locator('button[type="submit"]').click()
    await page.getByRole('heading', { name: 'Nueva Transacción' }).waitFor({ state: 'hidden' })
    const afterWithdraw = await readBalances()
    assert.equal(afterWithdraw.parentBalance, 725)
    assert.equal(afterWithdraw.pocketBalance, 275)
    console.log('POCKET_UI_MOVEMENT_READBACK ' + JSON.stringify({
      afterMovement: { parentBalance: afterMovement.parentBalance, pocketBalance: afterMovement.pocketBalance },
      afterEdit: { parentBalance: afterEdit.parentBalance, pocketBalance: afterEdit.pocketBalance },
      afterReversal: { parentBalance: afterReversal.parentBalance, pocketBalance: afterReversal.pocketBalance },
      afterWithdraw: { parentBalance: afterWithdraw.parentBalance, pocketBalance: afterWithdraw.pocketBalance }
    }))

    await page.goto(`http://127.0.0.1:4173/transactions?pocketTransfer=1&fromAccountId=${bankId}&toAccountId=${fundedState.pocketId}`)
    await page.getByRole('heading', { name: 'Nueva Transacción' }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'Pocket test workspace', exact: true }).click()
    await page.getByRole('button', { name: 'Secondary UI workspace', exact: true }).click()
    await page.waitForURL('http://127.0.0.1:4173/')
    await page.getByRole('button', { name: 'Secondary UI workspace', exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('link', { name: 'Transacciones', exact: true }).click()
    await page.getByRole('heading', { name: 'Historial de Transacciones' }).waitFor({ state: 'visible' })
    const secondaryFilterPanel = page.locator('.glass-panel.rounded-2xl.p-5').filter({ has: page.getByText('Buscar', { exact: true }) })
    const secondaryAccountFilter = secondaryFilterPanel.getByText('Cuenta', { exact: true }).locator('..').locator('select')
    await page.waitForFunction(() => [...document.querySelectorAll('select option')].some(option => option.textContent?.includes('Cuenta secundaria')))
    const secondaryOptions = await secondaryAccountFilter.locator('option').allTextContents()
    assert.ok(secondaryOptions.some(option => option.includes('Cuenta secundaria')), 'workspace switching must refresh account selector labels from the selected workspace')
    assert.ok(!secondaryOptions.some(option => option.includes('Cuenta principal › Viaje')), 'workspace switching must remove pocket labels from the previous workspace')
    await page.getByRole('button', { name: 'Secondary UI workspace', exact: true }).click()
    await page.getByRole('button', { name: 'Pocket test workspace', exact: true }).click()
    await page.waitForURL('http://127.0.0.1:4173/')
    await page.getByRole('button', { name: 'Pocket test workspace', exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('link', { name: 'Transacciones', exact: true }).click()
    await page.getByRole('heading', { name: 'Historial de Transacciones' }).waitFor({ state: 'visible' })
    const primaryFilterPanel = page.locator('.glass-panel.rounded-2xl.p-5').filter({ has: page.getByText('Buscar', { exact: true }) })
    const primaryAccountFilter = primaryFilterPanel.getByText('Cuenta', { exact: true }).locator('..').locator('select')
    await page.waitForFunction(() => [...document.querySelectorAll('select option')].some(option => option.textContent?.includes('Cuenta principal › Viaje')))
    const primaryOptionsAfterSwitch = await primaryAccountFilter.locator('option').allTextContents()
    assert.ok(primaryOptionsAfterSwitch.some(option => option.includes('Cuenta principal › Viaje')), 'switching back must refresh the pocket label in account selectors')
    assert.ok(!primaryOptionsAfterSwitch.some(option => option.includes('Cuenta secundaria')), 'switching back must remove labels from the other workspace')
    assert.ok(!new URL(page.url()).searchParams.has('pocketTransfer'), 'workspace changes must clear stale pocket route state')
    console.log('POCKET_UI_WORKSPACE_RESET ' + JSON.stringify({
      preselectionOpened: true,
      dialogClosed: true,
      routeQueryCleared: !new URL(page.url()).searchParams.has('pocketTransfer'),
      secondaryLabels: secondaryOptions,
      primaryLabelsAfterReturn: primaryOptionsAfterSwitch
    }))

    await page.getByRole('link', { name: 'Cuentas', exact: true }).click()
    await page.getByRole('heading', { name: 'Cuentas Financieras' }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: /Agregar dinero a Viaje/ }).click()
    const insufficientForm = page.locator('form').filter({ hasText: 'Desde Cuenta' })
    await insufficientForm.locator('input[type="number"]').first().fill('800')
    await insufficientForm.locator('input[placeholder^="Ej. Compra"]').fill('Pocket UI insufficient funds')
    const beforeInsufficientTransactions = (await fixture.adminDb.collection('transactions').where('workspaceId', '==', fixture.workspaceId).get()).size
    const insufficientDialogPromise = page.waitForEvent('dialog')
    await insufficientForm.locator('button[type="submit"]').click()
    const insufficientDialog = await insufficientDialogPromise
    assert.equal(insufficientDialog.type(), 'alert', 'insufficient pocket movements must reject instead of asking for overdraft confirmation')
    await insufficientDialog.accept()
    const afterInsufficientTransactions = (await fixture.adminDb.collection('transactions').where('workspaceId', '==', fixture.workspaceId).get()).size
    const afterInsufficient = await readBalances()
    assert.equal(afterInsufficientTransactions, beforeInsufficientTransactions)
    assert.equal(afterInsufficient.parentBalance, 725)
    assert.equal(afterInsufficient.pocketBalance, 275)
    console.log('POCKET_UI_INSUFFICIENT_READBACK ' + JSON.stringify({
      dialogType: 'alert',
      transactionCountBefore: beforeInsufficientTransactions,
      transactionCountAfter: afterInsufficientTransactions,
      parentBalance: afterInsufficient.parentBalance,
      pocketBalance: afterInsufficient.pocketBalance
    }))

    await page.goto('http://127.0.0.1:4173/transactions')
    const allocationRow = page.locator('tr').filter({ hasText: 'Asignación inicial a bolsillo: Viaje' })
    await allocationRow.locator('button[title="Editar Transacción"]').click()
    await page.getByRole('heading', { name: 'Editar Transacción' }).waitFor({ state: 'visible' })
    const allocationEditForm = page.locator('form').filter({ hasText: 'Desde Cuenta' })
    for (const actionName of ['Gasto', 'Ingreso', 'Transferencia', 'Préstamo', 'Pago Préstamo']) {
      assert.equal(await allocationEditForm.getByRole('button', { name: actionName, exact: true }).isDisabled(), true, 'opening allocation type must stay locked')
    }
    assert.equal(await allocationEditForm.locator('select').nth(0).isDisabled(), true)
    assert.equal(await allocationEditForm.locator('select').nth(1).isDisabled(), true)
    await page.getByRole('heading', { name: 'Editar Transacción' }).locator('xpath=..').locator('button').first().click()
    console.log('POCKET_UI_OPENING_LOCK ' + JSON.stringify({ typeDisabled: true, endpointsDisabled: true }))

    const filterPanel = page.locator('.glass-panel.rounded-2xl.p-5').filter({ has: page.getByText('Buscar', { exact: true }) })
    const accountFilter = filterPanel.getByText('Cuenta', { exact: true }).locator('..').locator('select')
    const accountOptions = await accountFilter.locator('option').allTextContents()
    assert.ok(accountOptions.some(option => option.includes('Cuenta principal › Viaje')), 'filters must qualify pocket names with their bank')
    assert.ok((await page.locator('body').innerText()).includes('Cuenta principal › Viaje'), 'transaction history must identify the pocket route')

    await page.goto('http://127.0.0.1:4173/goals')
    await page.getByRole('button', { name: 'Aportar saldo' }).click()
    const goalDialog = page.getByRole('heading', { name: 'Aportar a: Meta UI' }).locator('..').locator('..')
    const goalAccount = goalDialog.locator('select')
    await goalAccount.selectOption(fundedState.pocketId)
    const goalOptions = await goalAccount.locator('option').allTextContents()
    assert.ok(goalOptions.some(option => option.includes('Cuenta principal › Viaje')), 'goal contribution selector must qualify pocket names')
    await goalDialog.locator('input[type="number"]').fill('400')
    const beforeGoalTransactions = (await fixture.adminDb.collection('transactions').where('workspaceId', '==', fixture.workspaceId).get()).size
    let goalDialogType = ''
    page.once('dialog', async dialog => {
      goalDialogType = dialog.type()
      await dialog.accept()
    })
    await goalDialog.getByRole('button', { name: 'Realizar Aporte' }).click()
    await page.waitForTimeout(250)
    assert.equal(goalDialogType, 'alert', 'insufficient pocket funds must show a non-overridable error, not a confirmation')
    const afterGoalTransactions = (await fixture.adminDb.collection('transactions').where('workspaceId', '==', fixture.workspaceId).get()).size
    const goalReadback = await fixture.adminDb.collection('goals').doc('ui-pocket-goal').get()
    const pocketAfterGoal = await fixture.adminDb.collection('accounts').doc(fundedState.pocketId).get()
    assert.equal(afterGoalTransactions, beforeGoalTransactions, 'insufficient goal contribution must not write a transaction')
    assert.equal(goalReadback.data()?.currentAmount, 0, 'insufficient goal contribution must not change goal progress')
    assert.equal(pocketAfterGoal.data()?.balance, 275, 'insufficient goal contribution must not debit the pocket')
    console.log('POCKET_UI_GOAL_DENIAL ' + JSON.stringify({
      dialogType: goalDialogType,
      transactionCountBefore: beforeGoalTransactions,
      transactionCountAfter: afterGoalTransactions,
      goalCurrentAmount: goalReadback.data()?.currentAmount,
      pocketBalance: pocketAfterGoal.data()?.balance
    }))
    await goalDialog.getByRole('button', { name: 'Cancelar', exact: true }).click()
    await page.getByRole('heading', { name: 'Aportar a: Meta UI' }).waitFor({ state: 'hidden' })

    const captureDashboardKpis = async () => {
      await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
      await page.getByRole('heading', { name: /Bóveda de/ }).waitFor({ state: 'visible' })
      await page.getByText('Patrimonio Neto', { exact: true }).waitFor({ state: 'visible' })
      return page.evaluate(() => {
      const labels = ['Patrimonio Neto', 'Ingresos del Mes', 'Gastos imputados del Mes']
      return Object.fromEntries(labels.map(label => {
        const element = [...document.querySelectorAll('span')].find(span => span.textContent?.trim() === label)
        return [label, element?.parentElement?.querySelector('h4')?.innerText.replace(/\s+/g, ' ').trim() ?? null]
      }))
      })
    }
    const kpisBeforeImport = await captureDashboardKpis()
    assert.ok(Object.values(kpisBeforeImport).every(Boolean), 'dashboard should render the wealth and cashflow KPI cards before importing')
    assert.equal(Number(kpisBeforeImport['Patrimonio Neto'].replace(/\D/g, '')), 1_000)
    assert.equal(Number(kpisBeforeImport['Ingresos del Mes'].replace(/\D/g, '')), 0)
    assert.equal(Number(kpisBeforeImport['Gastos imputados del Mes'].replace(/\D/g, '')), 0)

    await page.goto('http://127.0.0.1:4173/import')
    await page.waitForFunction(async ({ expectedUid, expectedWorkspaceId, expectedPocketId }) => {
      const [{ app: firebaseApp, auth: firebaseAuth }, { useAuthStore }, { useAccountsStore }] = await Promise.all([
        import('/src/lib/firebase.ts'),
        import('/src/stores/authStore.ts'),
        import('/src/stores/accountsStore.ts')
      ])
      const auth = useAuthStore()
      const accounts = useAccountsStore()
      return firebaseApp.options.projectId === 'demo-vault-pockets'
        && auth.user?.uid === expectedUid
        && firebaseAuth.currentUser?.uid === expectedUid
        && auth.profile?.activeWorkspaceId === expectedWorkspaceId
        && auth.activeWorkspaceId === expectedWorkspaceId
        && accounts.accounts.some(account => account.id === expectedPocketId)
        && !accounts.loading
    }, { expectedUid: fixture.identity.user.uid, expectedWorkspaceId: fixture.workspaceId, expectedPocketId: fundedState.pocketId })
    const importTarget = page.getByText('Cuenta Destino', { exact: true }).locator('..').locator('select')
    await importTarget.locator('option').filter({ hasText: 'Cuenta principal › Viaje' }).waitFor({ state: 'attached' })
    const importOptions = await importTarget.locator('option').allTextContents()
    assert.ok(importOptions.some(option => option.includes('Cuenta principal › Viaje')), 'statement import selector must qualify pocket names')
    await importTarget.selectOption(fundedState.pocketId)
    await page.locator('textarea').fill('Local UI-only statement fixture; parser output is stubbed for this test.')
    await page.getByRole('button', { name: 'Procesar con Inteligencia Artificial' }).click()
    await page.getByRole('heading', { name: 'Revisar Movimientos Extraídos' }).waitFor({ state: 'visible' })
    assert.equal(parserStubCount, 1, 'only the statement parser response may be stubbed in this UI flow')
    const importAlerts = []
    page.once('dialog', async dialog => {
      importAlerts.push({ type: dialog.type(), message: dialog.message() })
      await dialog.accept()
    })
    await page.getByRole('button', { name: 'Importar Transacciones (1)' }).click()
    const transactionsHeading = page.getByRole('heading', { name: 'Historial de Transacciones' })
    const transactionsVisible = await transactionsHeading.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
    const importedRows = await fixture.adminDb.collection('transactions').where('workspaceId', '==', fixture.workspaceId).get()
    const importedIncome = importedRows.docs.find(snapshot => snapshot.data().description === 'Pocket UI statement income')
    console.log('POCKET_UI_IMPORT_ATTEMPT ' + JSON.stringify({
      route: new URL(page.url()).pathname,
      transactionsVisible,
      alertCount: importAlerts.length,
      alertTypes: importAlerts.map(alert => alert.type),
      consoleErrorCodes,
      consoleErrorSummaries: consoleErrorSummaries.slice(-3),
      callableRequests,
      callableResponses,
      durableImportExists: !!importedIncome,
      transactionCount: importedRows.size
    }))
    assert.equal(transactionsVisible, true, 'successful statement confirmation should return to transaction history')
    assert.ok(importedIncome, 'statement confirmation must persist through the real callable path')
    assert.equal(importedIncome.data().type, 'income')
    assert.equal(importedIncome.data().accountId, fundedState.pocketId)
    assert.equal(importedIncome.data().amount, 20)
    const afterImport = await readBalances()
    assert.equal(afterImport.parentBalance, 725)
    assert.equal(afterImport.pocketBalance, 295)
    console.log('POCKET_UI_IMPORT_READBACK ' + JSON.stringify({
      parserStubCount,
      callableTransactionId: importedIncome.id,
      transactionType: importedIncome.data().type,
      amount: importedIncome.data().amount,
      parentBalance: afterImport.parentBalance,
      pocketBalance: afterImport.pocketBalance,
      total: afterImport.parentBalance + afterImport.pocketBalance
    }))

    assert.ok(callableRequests.some(request => request.method === 'POST' && request.path.endsWith('/importPocketStatement')),
      'statement confirmation must invoke the real callable endpoint')
    assert.ok(callableResponses.some(response => response.method === 'POST' && response.status === 200 && response.path.endsWith('/importPocketStatement')),
      'the real statement import callable must return success')

    await page.goto('http://127.0.0.1:4173/goals')
    await page.getByRole('button', { name: 'Aportar saldo' }).click()
    const successfulGoalDialog = page.getByRole('heading', { name: 'Aportar a: Meta UI' }).locator('..').locator('..')
    await successfulGoalDialog.locator('select').selectOption(fundedState.pocketId)
    await successfulGoalDialog.locator('input[type="number"]').fill('25')
    const transactionsBeforeSuccessfulGoal = (await fixture.adminDb.collection('transactions').where('workspaceId', '==', fixture.workspaceId).get()).size
    await successfulGoalDialog.getByRole('button', { name: 'Realizar Aporte' }).click()
    await page.getByRole('heading', { name: 'Aportar a: Meta UI' }).waitFor({ state: 'hidden' })
    const goalTransactions = await fixture.adminDb.collection('transactions').where('workspaceId', '==', fixture.workspaceId).get()
    const goalContributions = goalTransactions.docs.filter(snapshot => snapshot.data().description === 'Aporte a meta: Meta UI')
    const successfulGoal = goalContributions.at(-1)
    const goalProgress = await fixture.adminDb.collection('goals').doc('ui-pocket-goal').get()
    const afterSuccessfulGoal = await readBalances()
    assert.equal(goalTransactions.size, transactionsBeforeSuccessfulGoal + 1, 'successful goal contribution must create exactly one transaction')
    assert.equal(goalContributions.length, 1, 'successful goal contribution must not duplicate its transaction')
    assert.equal(successfulGoal?.data().type, 'expense')
    assert.equal(successfulGoal?.data().accountId, fundedState.pocketId)
    assert.equal(successfulGoal?.data().amount, -25)
    assert.equal(goalProgress.data()?.currentAmount, 25, 'goal progress must increase once')
    assert.equal(afterSuccessfulGoal.parentBalance, 725)
    assert.equal(afterSuccessfulGoal.pocketBalance, 270, 'goal contribution must debit the selected pocket once')
    console.log('POCKET_UI_GOAL_SUCCESS ' + JSON.stringify({
      transactionCount: goalTransactions.size,
      contributionAmount: successfulGoal?.data().amount,
      goalCurrentAmount: goalProgress.data()?.currentAmount,
      parentBalance: afterSuccessfulGoal.parentBalance,
      pocketBalance: afterSuccessfulGoal.pocketBalance,
      total: afterSuccessfulGoal.parentBalance + afterSuccessfulGoal.pocketBalance
    }))

    const dashboardKpis = await captureDashboardKpis()
    assert.ok(Object.values(dashboardKpis).every(Boolean), 'dashboard should render the wealth and cashflow KPI cards')
    assert.equal(Number(dashboardKpis['Patrimonio Neto'].replace(/\D/g, '')), 995)
    assert.equal(Number(dashboardKpis['Ingresos del Mes'].replace(/\D/g, '')), 20)
    assert.equal(Number(dashboardKpis['Gastos imputados del Mes'].replace(/\D/g, '')), 25)
    assert.ok((await page.locator('body').innerText()).includes('Cuenta principal › Viaje'), 'dashboard recent movement should name the pocket')
    console.log('POCKET_UI_DASHBOARD_READBACK ' + JSON.stringify(dashboardKpis))
    const screenshotPath = join(tmpdir(), `pockets-ui-dashboard-${process.pid}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true })
    console.log('POCKET_UI_SCREENSHOT ' + screenshotPath)

    await page.setViewportSize({ width: 390, height: 844 })
    const dashboardMobileMenuOverlay = page.locator('div.fixed.inset-0.z-40')
    if (await dashboardMobileMenuOverlay.count()) {
      await page.getByRole('button', { name: 'Toggle Menu', exact: true }).click()
      await dashboardMobileMenuOverlay.waitFor({ state: 'hidden' })
    }
    await page.waitForFunction(() => {
      const sidebar = document.querySelector('aside')
      const main = document.querySelector('main')
      if (!sidebar || !main) return false
      const sidebarBounds = sidebar.getBoundingClientRect()
      const hasRunningLayoutTransition = [sidebar, main].some(element =>
        element.getAnimations().some(animation => animation.playState === 'running')
      )
      return sidebarBounds.right <= 1 && !hasRunningLayoutTransition
    }, null, { timeout: 5_000 })
    assert.equal(await dashboardMobileMenuOverlay.count(), 0, 'dashboard mobile navigation should be closed before capture')
    const mobileViewportWidth = await page.evaluate(() => window.innerWidth)
    assert.equal(mobileViewportWidth, 390, 'dashboard screenshot should use the intended mobile viewport')
    const mobileMainBounds = await page.locator('main').evaluate(element => {
      const { left, right } = element.getBoundingClientRect()
      return { left, right }
    })
    assert.ok(
      mobileMainBounds.left >= 0 && mobileMainBounds.right <= mobileViewportWidth + 1,
      'dashboard content should fit within the mobile viewport'
    )
    const mobileIntro = page.getByText('Aquí tienes el resumen de tu salud financiera actual.', { exact: true })
    assert.ok(await mobileIntro.isVisible(), 'dashboard introduction should remain visible on mobile')
    const mobileToolbar = page.locator('header').filter({
      has: page.getByRole('button', { name: 'Toggle Menu', exact: true })
    })
    assert.equal(await mobileToolbar.count(), 1, 'mobile toolbar should be identified by its real Toggle Menu control')
    const readMobileDashboardGeometry = async () => ({
      scrollY: await page.evaluate(() => window.scrollY),
      toolbar: await mobileToolbar.boundingBox(),
      intro: await mobileIntro.boundingBox()
    })
    const beforeOriginGeometry = await readMobileDashboardGeometry()
    console.log('POCKET_UI_DASHBOARD_MOBILE_BEFORE_ORIGIN ' + JSON.stringify(beforeOriginGeometry))

    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }))
    await page.waitForFunction(() => window.scrollY === 0, null, { timeout: 5_000 })
    await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    }))
    await page.waitForFunction(() => {
      const toolbar = document.querySelector('header:has(button[aria-label="Toggle Menu"])')
      const sidebar = document.querySelector('aside')
      const main = document.querySelector('main')
      if (!toolbar || !sidebar || !main || window.scrollY !== 0) return false
      return ![toolbar, sidebar, main].some(element =>
        element.getAnimations().some(animation => animation.playState === 'running')
      )
    }, null, { timeout: 5_000 })
    const mobileOriginGeometry = await readMobileDashboardGeometry()
    console.log('POCKET_UI_DASHBOARD_MOBILE_AT_ORIGIN ' + JSON.stringify(mobileOriginGeometry))
    assert.equal(mobileOriginGeometry.scrollY, 0, 'dashboard mobile screenshot should start at the document origin')
    const { toolbar: mobileToolbarBounds, intro: mobileIntroBounds } = mobileOriginGeometry
    assert.ok(mobileToolbarBounds, 'mobile toolbar should expose measurable viewport bounds')
    assert.ok(mobileIntroBounds, 'dashboard introduction should expose measurable viewport bounds')
    assert.ok(
      mobileToolbarBounds.x >= 0 && mobileToolbarBounds.x + mobileToolbarBounds.width <= mobileViewportWidth + 1 &&
      mobileToolbarBounds.y >= -1 && mobileToolbarBounds.y <= 1,
      'mobile toolbar should be visible at the top edge of the intended viewport'
    )
    assert.ok(
      mobileIntroBounds && mobileIntroBounds.x >= 0 && mobileIntroBounds.x + mobileIntroBounds.width <= mobileViewportWidth + 1,
      'dashboard introduction should fit within the mobile viewport'
    )
    assert.ok(
      mobileIntroBounds.y >= mobileToolbarBounds.y + mobileToolbarBounds.height &&
      mobileIntroBounds.y + mobileIntroBounds.height <= 844,
      'dashboard introduction should be visible below the mobile toolbar without overlap'
    )
    for (const label of ['Patrimonio Neto', 'Ingresos del Mes', 'Gastos imputados del Mes']) {
      const kpiLabel = page.getByText(label, { exact: true })
      assert.ok(await kpiLabel.isVisible(), `${label} KPI should remain visible on mobile`)
      const cardBounds = await kpiLabel.evaluate(element => {
        const card = element.closest('.glass-panel')
        if (!card) return null
        const { left, right } = card.getBoundingClientRect()
        return { left, right }
      })
      assert.ok(
        cardBounds && cardBounds.left >= 0 && cardBounds.right <= mobileViewportWidth + 1,
        `${label} KPI card should fit within the mobile viewport`
      )
    }
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)
    assert.equal(mobileOverflow, false, 'dashboard should fit the mobile viewport without horizontal overflow')
    const mobileScreenshotPath = join(tmpdir(), `pockets-ui-mobile-${process.pid}.png`)
    await page.screenshot({ path: mobileScreenshotPath, fullPage: true })
    console.log('POCKET_UI_MOBILE_SCREENSHOT ' + mobileScreenshotPath)

    await page.goto('http://127.0.0.1:4173/accounts')
    await page.setViewportSize({ width: 1280, height: 900 })
    const desktopBankGroup = page.locator('.grid > div.space-y-3').filter({
      has: page.getByRole('heading', { name: 'Cuenta principal', exact: true })
    })
    const desktopPocketName = desktopBankGroup.getByText('Cuenta principal › Viaje', { exact: true })
    await desktopPocketName.waitFor({ state: 'visible' })
    await page.waitForTimeout(400)
    assert.ok(await desktopPocketName.evaluate(element => element.getBoundingClientRect().width > 0), 'qualified pocket name must remain visible on desktop')
    const accountsDesktopScreenshotPath = join(tmpdir(), `pockets-ui-accounts-desktop-${process.pid}.png`)
    await page.screenshot({ path: accountsDesktopScreenshotPath, fullPage: true })
    console.log('POCKET_UI_ACCOUNTS_DESKTOP_SCREENSHOT ' + accountsDesktopScreenshotPath)
    await page.setViewportSize({ width: 390, height: 844 })
    const mobileBankGroup = page.locator('.grid > div.space-y-3').filter({
      has: page.getByRole('heading', { name: 'Cuenta principal', exact: true })
    })
    const mobilePocketName = mobileBankGroup.getByText('Cuenta principal › Viaje', { exact: true })
    await mobilePocketName.waitFor({ state: 'visible' })
    assert.ok(await mobilePocketName.evaluate(element => element.getBoundingClientRect().width > 0), 'qualified pocket name must remain visible on mobile')
    const keyboardCreateButton = mobileBankGroup.getByRole('button', { name: 'Agregar bolsillo a Cuenta principal', exact: true })
    await keyboardCreateButton.focus()
    await page.keyboard.press('Enter')
    const keyboardDialog = page.getByRole('dialog', { name: 'Crear bolsillo' })
    await keyboardDialog.waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'new-account-name', 'pocket dialog should focus its first field')
    await page.keyboard.press('Escape')
    await keyboardDialog.waitFor({ state: 'hidden' })
    console.log('POCKET_UI_KEYBOARD ' + JSON.stringify({ focusedInput: 'new-account-name', escapeDismissed: true }))
    const mobileMenuOverlay = page.locator('div.fixed.inset-0.z-40')
    if (await mobileMenuOverlay.count()) {
      await page.getByRole('button', { name: 'Toggle Menu', exact: true }).click()
      await mobileMenuOverlay.waitFor({ state: 'hidden' })
    }
    await page.waitForTimeout(350)
    assert.ok(await mobilePocketName.isVisible(), 'the mobile account view must be visible after dismissing navigation')
    console.log('POCKET_UI_MOBILE_NAV ' + JSON.stringify({ overlayVisible: await mobileMenuOverlay.count() > 0 }))
    const accountsMobileScreenshotPath = join(tmpdir(), `pockets-ui-accounts-mobile-${process.pid}.png`)
    await page.screenshot({ path: accountsMobileScreenshotPath, fullPage: true })
    console.log('POCKET_UI_ACCOUNTS_MOBILE_SCREENSHOT ' + accountsMobileScreenshotPath)

    const finalParent = await fixture.adminDb.collection('accounts').doc(bankId).get()
    const finalPocket = await fixture.adminDb.collection('accounts').doc(fundedState.pocketId).get()
    assert.equal(finalParent.data()?.balance + finalPocket.data()?.balance, 995, 'cashflow changes wealth only once, while pocket movements remain neutral')
    assert.equal(pageErrorCount, 0, 'real UI interactions must not throw browser errors')
    assert.equal(consoleErrorCount, 0, 'real UI interactions must not log unexpected browser console errors')
    assert.equal(expectedPocketRejectionConsoleCount, 2, 'the two rejected insufficient-funds attempts should log only their expected validation errors')
  } finally {
    await browser?.close()
    await vite?.close()
    await fixture?.close()
    rmSync(temporaryCache, { recursive: true, force: true })
  }
})
