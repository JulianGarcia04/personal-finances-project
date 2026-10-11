import * as firestoreSdk from 'firebase/firestore'

export * from 'firebase/firestore'

const stateKey = Symbol.for('vault.pockets.transaction-barrier')
const getState = () => {
  if (!globalThis[stateKey]) {
    globalThis[stateKey] = { holds: [], events: [], nextInvocationId: 1 }
  }
  return globalThis[stateKey]
}

function classify(writes) {
  if (writes.some(write => write.path.startsWith('accounts/') && write.parentAccountId)) {
    return 'pocket-opening'
  }
  if (writes.some(write => write.path.startsWith('transactions/')) &&
      writes.some(write => write.path.startsWith('accounts/'))) {
    return 'ordinary-import'
  }
  return null
}

function writeDescription(method, args) {
  const reference = args[0]
  const data = method === 'delete' ? null : args[1]
  return {
    method,
    path: reference?.path ?? 'unknown',
    fields: data && typeof data === 'object' ? Object.keys(data).sort() : [],
    parentAccountId: data?.parentAccountId ?? null,
    balance: typeof data?.balance === 'number' ? data.balance : null,
    amount: typeof data?.amount === 'number' ? data.amount : null,
    transactionType: data?.type ?? null,
    pocketAllocation: data?.pocketAllocation === true
  }
}

function eventFor(invocationId, attempt, kind, reads, writes, outcome, error, result = null) {
  return {
    invocationId,
    attempt,
    kind,
    reads: [...reads],
    writes: writes.map(write => ({ ...write })),
    outcome,
    callbackResult: result && typeof result === 'object' && typeof result.parentBalanceAfter === 'number'
      ? { parentBalanceAfter: result.parentBalanceAfter }
      : typeof result === 'number' ? { number: result } : null,
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null
  }
}

async function pauseAtBarrier(event) {
  const state = getState()
  state.events.push(event)
  const hold = state.holds.find(candidate => !candidate.claimed && candidate.kind === event.kind)
  if (!hold || event.outcome !== 'staged') return

  hold.claimed = true
  hold.reachedResolve(event)
  await hold.releasePromise
}

export const runTransaction = (db, updateFunction, options) => {
  const invocationId = getState().nextInvocationId++
  let attempt = 0
  let invocationKind = null

  return firestoreSdk.runTransaction(db, async transaction => {
    attempt += 1
    const reads = []
    const writes = []
    const observedTransaction = new Proxy(transaction, {
      get(target, property) {
        const member = Reflect.get(target, property, target)
        if (property === 'get') {
          return async reference => {
            const snapshot = await member.call(target, reference)
            const data = snapshot.exists() ? snapshot.data() : null
            reads.push({
              path: reference?.path ?? 'unknown',
              exists: snapshot.exists(),
              workspaceId: data?.workspaceId ?? null,
              balance: typeof data?.balance === 'number' ? data.balance : null,
              currency: data?.currency ?? null,
              type: data?.type ?? null,
              childAccountIds: Array.isArray(data?.childAccountIds) ? [...data.childAccountIds] : null,
              members: Array.isArray(data?.members) ? [...data.members] : null
            })
            return snapshot
          }
        }
        if (property === 'set' || property === 'update' || property === 'delete') {
          return (...args) => {
            writes.push(writeDescription(property, args))
            return member.apply(target, args)
          }
        }
        return typeof member === 'function' ? member.bind(target) : member
      }
    })

    try {
      const result = await updateFunction(observedTransaction)
      invocationKind = invocationKind ?? classify(writes)
      await pauseAtBarrier(eventFor(invocationId, attempt, invocationKind, reads, writes, 'staged', null, result))
      return result
    } catch (error) {
      invocationKind = invocationKind ?? classify(writes)
      await pauseAtBarrier(eventFor(invocationId, attempt, invocationKind, reads, writes, 'rejected', error))
      throw error
    }
  }, options)
}

export function createTransactionBarrier() {
  return {
    holdNext(kind) {
      let reachedResolve
      let releaseResolve
      const reached = new Promise(resolve => { reachedResolve = resolve })
      const releasePromise = new Promise(resolve => { releaseResolve = resolve })
      const hold = {
        kind,
        claimed: false,
        released: false,
        reachedResolve,
        reached,
        releasePromise,
        release() {
          if (!hold.released) {
            hold.released = true
            releaseResolve()
          }
        }
      }
      getState().holds.push(hold)
      return hold
    },
    events() {
      return getState().events.map(event => ({
        ...event,
        reads: event.reads.map(read => ({ ...read, childAccountIds: read.childAccountIds ? [...read.childAccountIds] : null, members: read.members ? [...read.members] : null })),
        writes: event.writes.map(write => ({ ...write }))
      }))
    },
    releaseAll() {
      for (const hold of getState().holds) hold.release()
    },
    reset() {
      const state = getState()
      for (const hold of state.holds) hold.release()
      state.holds = []
      state.events = []
    }
  }
}
