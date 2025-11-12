import { promisify } from 'node:util'
import { InvariantError } from '../../shared/lib/invariant-error'
import { bindSnapshot } from './async-local-storage'

enum ExecutionState {
  None = 1,
  Waiting = 2,
  Working = 3,
}

let isInstalled = false
let wasEnabledAtLeastOnce = false

const queuedImmediates: QueueItem[] = []
let pendingNextTicks = 0
let executionState: ExecutionState = ExecutionState.None

const originalSetImmediate = globalThis.setImmediate
const originalClearImmediate = globalThis.clearImmediate
const originalNextTick = process.nextTick

export function install() {
  const nodeTimers = require('node:timers') as typeof import('node:timers')
  globalThis.setImmediate = nodeTimers.setImmediate =
    // Workaround for missing __promisify__ which is not a real property
    patchedSetImmediate as unknown as typeof setImmediate
  globalThis.clearImmediate = nodeTimers.clearImmediate = patchedClearImmediate

  const nodeTimersPromises =
    require('node:timers/promises') as typeof import('node:timers/promises')
  nodeTimersPromises.setImmediate =
    patchedSetImmediatePromise as typeof import('node:timers/promises').setImmediate

  process.nextTick = patchedNextTick

  isInstalled = true
}

/**
 * **WARNING: This function changes the usual behavior of the event loop!**
 * **Be VERY careful about where you call it.**
 *
 * Starts capturing calls to `setImmediate` to run them as "fast immediates".
 * All calls captured in this way will be executed after the current task
 * (after ticks from `process.nextTick()` and microtasks scheduled from ticks).
 * This function needs to be called again in each task that needs the
 * "fast immediates" behavior.
 *
 * ### Motivation
 *
 * We don't want `setImmediate` to be considered IO in Cache Components.
 * To achieve this in a staged (pre)render, we want to allow immediates scheduled
 * in stage N to run before stage N+1.
 * Since we schedule stages using sequential `setTimeout`, this isn't possible without
 * intercepting `setImmediate` and doing the scheduling on our own.
 * We refer to this as a "fast immediate".
 *
 * Notably, this affects React's `scheduleWork` in render, which uses `setImmediate`.
 * This is desirable -- if async work was scheduled during a stage, then it should
 * get to run before we finish that stage.
 *
 * ### Example
 *
 * ```ts
 * setTimeout(() => {
 *   runPendingImmediatesAfterCurrentTask()
 *   console.log("timeout 1")
 *   setImmediate(() => {
 *     console.log("immediate!!!")
 *   })
 * })
 * setTimeout(() => {
 *   console.log("timeout 1")
 * })
 * ```
 * will print
 *
 * ```
 * timeout 1
 * immediate!!!
 * timeout 2
 * ```
 *
 * instead of the normal order
 * ```
 * timeout 1
 * timeout 2
 * immediate!!!
 * ```
 *
 * Recursive `setImmediate` calls will also be executed as "fast immediates".
 * If multiple immediates were scheduled, `process.nextTick()` (and associated microtasks)
 * will be allowed to execute between them.
 * See the unit tests for more examples.
 * */
export function DANGEROUSLY_runPendingImmediatesAfterCurrentTask() {
  startCapturingImmediates()
  scheduleWorkAfterTicksAndMicrotasks()
}

export function expectNoPendingImmediates() {
  if (executionState !== ExecutionState.None) {
    const prevExecutionState = executionState

    // Reset the state as best we can to prevent further crashes.
    // Otherwise, any subsequent call to `DANGEROUSLY_runPendingImmediatesAfterCurrentTask`
    // would error, requiring a server restart to fix.
    executionState = ExecutionState.None
    queuedImmediates.length = 0
    // don't reset `pendingNextTicks` -- if we still have pending ticks,
    // they might decrement the counter below 0. This should reset organically
    // as the ticks execute.

    throw new InvariantError(
      `Expected all captured immediates to have been executed (state: ${ExecutionState[prevExecutionState]})`
    )
  }
}

function scheduleWorkAfterTicksAndMicrotasks() {
  if (executionState !== ExecutionState.Waiting) {
    throw new InvariantError(
      `scheduleWorkAfterTicksAndMicrotasks can only be called while waiting (state: ${ExecutionState[executionState]})`
    )
  }
  originalNextTick(() => {
    queueMicrotask(() => {
      originalNextTick(() => {
        if (pendingNextTicks > 0) {
          // We have raw nextTicks. Let those run first.
          debug?.(`scheduler :: yielding to ${pendingNextTicks} nextTicks`)
          return scheduleWorkAfterTicksAndMicrotasks()
        }

        return performWork()
      })
    })
  })
}

function performWork() {
  debug?.(`scheduler :: performing work`)

  if (executionState !== ExecutionState.Waiting) {
    throw new InvariantError(
      `performWork can only be called while waiting (state: ${ExecutionState[executionState]})`
    )
  }
  executionState = ExecutionState.Working

  // Find the first (if any) queued immediate that wasn't cleared
  let queueItem: ActiveQueueItem | null = null
  while (queuedImmediates.length) {
    const maybeQueItem = queuedImmediates.shift()!
    if (!maybeQueItem.isCleared) {
      queueItem = maybeQueItem
      break
    }
  }
  if (!queueItem) {
    debug?.(`scheduler :: no immediates queued, exiting`)
    stopCapturingImmediates()
    return
  }

  debug?.(`scheduler :: executing queued immediate`)

  const { immediateObject, callback, args } = queueItem

  immediateObject[INTERNALS].queueItem = null
  clearQueueItem(queueItem)

  // Execute the immediate.

  // HACK: if a sync error was thrown, we'll trigger a `uncaughtException`.
  // However, synchronous `uncaughtException` has some strange timing, and
  // seems to allow timeouts to run before nextTicks (even those that were already scheduled!).
  // This would potentially cause us to advance to the next task before we're done running all the immediates.
  // Delaying the error by a microtask seems to sidestep that, at the cost of slightly
  // changing when the handler is invoked.
  // To minimize this, we queue a microtask before running the immediate itself
  // so that we can rethrow the error as soon as possible.
  // Note that nextTicks scheduled before the error will run before `uncaughtException`,
  // which would not happen in vanilla node.
  let didThrow = false
  let thrownValue: unknown = undefined
  queueMicrotask(() => {
    if (didThrow) {
      debug?.('scheduler :: rethrowing sync error from immediate in microtask')
      throw thrownValue
    }
  })

  try {
    if (args !== null) {
      callback.apply(null, args)
    } else {
      callback()
    }
  } catch (err) {
    // We'll rethrow the error in the microtask above.
    didThrow = true
    thrownValue = err
  }

  executionState = ExecutionState.Waiting

  // schedule the loop again in case there's more immediates after this.
  // if this is the last immediate, this also ensures that [ticks and microtasks
  // spawned from the current immediate] are executed before we let the event loop
  // move on to the next task.
  scheduleWorkAfterTicksAndMicrotasks()
}

function startCapturingImmediates() {
  if (!isInstalled) {
    throw new InvariantError('install() was not called')
  }

  if (executionState !== ExecutionState.None) {
    throw new InvariantError(
      `Cannot start capturing immediates again without finishing the previous task (state: ${ExecutionState[executionState]})`
    )
  }
  executionState = ExecutionState.Waiting
  wasEnabledAtLeastOnce = true
}

function stopCapturingImmediates() {
  if (!isInstalled) {
    throw new InvariantError('install() was not called')
  }

  // This check enforces that we run performWork at least once before stopping
  // to make sure that we've waited for all the ticks and microtasks
  // that might've scheduled some immediates after sync code.
  if (executionState !== ExecutionState.Working) {
    throw new InvariantError(
      `Cannot stop capturing immediates before execution is finished (state: ${ExecutionState[executionState]})`
    )
  }
  executionState = ExecutionState.None
}

type QueueItem = ActiveQueueItem | ClearedQueueItem
type ActiveQueueItem = {
  isCleared: false
  callback: (...args: any[]) => any
  args: any[] | null
  immediateObject: NextImmediate
}
type ClearedQueueItem = {
  isCleared: true
  callback: null
  args: null
  immediateObject: null
}

function clearQueueItem(originalQueueItem: QueueItem) {
  const queueItem = originalQueueItem as ClearedQueueItem
  queueItem.isCleared = true
  queueItem.callback = null
  queueItem.args = null
  queueItem.immediateObject = null
}

//========================================================

function patchedNextTick<TArgs extends any[]>(
  callback: (...args: TArgs) => void,
  ...args: TArgs
): void
function patchedNextTick() {
  if (executionState === ExecutionState.None) {
    return originalNextTick.apply(
      null,
      // @ts-expect-error: this is valid, but typescript doesn't get it
      arguments
    )
  }

  if (arguments.length === 0 || typeof arguments[0] !== 'function') {
    // Replicate the error that nextTick throws
    const error = new TypeError(
      `The "callback" argument must be of type function. Received ${typeof arguments[0]}`
    )
    ;(error as any).code = 'ERR_INVALID_ARG_TYPE'
    throw error
  }

  debug?.(
    `scheduler :: process.nextTick called (previous pending: ${pendingNextTicks})`
  )

  const callback: (...args: any[]) => any = arguments[0]
  const args: any[] | null =
    arguments.length > 1 ? Array.prototype.slice.call(arguments, 1) : null

  pendingNextTicks += 1
  return originalNextTick(() => {
    pendingNextTicks -= 1
    debug?.(
      `scheduler :: process.nextTick executing (still pending: ${pendingNextTicks})`
    )

    if (args !== null) {
      callback.apply(null, args)
    } else {
      callback()
    }
  })
}

function patchedSetImmediate<TArgs extends any[]>(
  callback: (...args: TArgs) => void,
  ...args: TArgs
): NodeJS.Immediate
function patchedSetImmediate(callback: (args: void) => void): NodeJS.Immediate
function patchedSetImmediate(): NodeJS.Immediate {
  if (executionState === ExecutionState.None) {
    return originalSetImmediate.apply(
      null,
      // @ts-expect-error: this is valid, but typescript doesn't get it
      arguments
    )
  }

  if (arguments.length === 0 || typeof arguments[0] !== 'function') {
    // Replicate the error that setImmediate throws
    const error = new TypeError(
      `The "callback" argument must be of type function. Received ${typeof arguments[0]}`
    )
    ;(error as any).code = 'ERR_INVALID_ARG_TYPE'
    throw error
  }

  const callback: (...args: any[]) => any = arguments[0]
  const args: any[] | null =
    arguments.length > 1 ? Array.prototype.slice.call(arguments, 1) : null

  const callbackWithAsyncContext = bindSnapshot(
    // TODO: bindSnapshot says we shouldn't pass a named function to it, does that apply here?
    (...innerArgs: any[]) => callback(...innerArgs)
  )
  const immediateObject = new NextImmediate()

  const queueItem: ActiveQueueItem = {
    isCleared: false,
    callback: callbackWithAsyncContext,
    args,
    immediateObject,
  }
  queuedImmediates.push(queueItem)

  immediateObject[INTERNALS].queueItem = queueItem

  return immediateObject
}

function patchedSetImmediatePromise<T = void>(
  value: T,
  options?: import('node:timers').TimerOptions
): Promise<T> {
  if (executionState === ExecutionState.None) {
    const originalPromisify: (typeof setImmediate)['__promisify__'] =
      // @ts-expect-error: the types for `promisify.custom` are strange
      originalSetImmediate[promisify.custom]
    return originalPromisify(value, options)
  }

  return new Promise<T>((resolve, reject) => {
    // The abort signal makes the promise reject.
    // If it is already aborted, we reject immediately.
    const signal = options?.signal
    if (signal && signal.aborted) {
      return reject(signal.reason)
    }

    const immediate = patchedSetImmediate(resolve, value)

    // Note that we're ignoring `options.ref`, because `unref()` has no effect
    // on our patched immediates

    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          patchedClearImmediate(immediate)
          reject(signal.reason)
        },
        { once: true }
      )
    }
  })
}

patchedSetImmediate[promisify.custom] = patchedSetImmediatePromise

const patchedClearImmediate = (
  immediateObject: NodeJS.Immediate | undefined
) => {
  // NOTE: we defensively check for patched immediates even if we're not
  // currently capturing immediates, because the objects returned from
  // the patched setImmediate can be kept around for arbitrarily long.
  // As an optimization, we only do this if the patch was enabled at least once --
  // otherwise, no patched objects could've been created.
  if (
    wasEnabledAtLeastOnce &&
    immediateObject &&
    typeof immediateObject === 'object' &&
    INTERNALS in immediateObject
  ) {
    ;(immediateObject as NextImmediate)[Symbol.dispose]()
  } else {
    originalClearImmediate(immediateObject)
  }
}

//========================================================

const INTERNALS: unique symbol = Symbol.for('next.Immediate.internals')

type NextImmediateInternals = {
  /** Stored to reflect `ref()`/`unref()` calls, but has no effect otherwise */
  hasRef: boolean
  queueItem: ActiveQueueItem | null
}

/** Makes sure that we're implementing all the public `Immediate` methods */
interface NativeImmediate extends NodeJS.Immediate {}

/** Implements a shim for the native `Immediate` class returned by `setImmediate` */
class NextImmediate implements NativeImmediate {
  [INTERNALS]: NextImmediateInternals = {
    queueItem: null,
    hasRef: true,
  }
  hasRef() {
    const internals = this[INTERNALS]
    if (internals.queueItem) {
      return internals.hasRef
    } else {
      // if we're no longer queued (cleared or executed), hasRef is always false
      return false
    }
  }
  ref() {
    const internals = this[INTERNALS]
    if (internals.queueItem) {
      internals.hasRef = true
    }
    return this
  }
  unref() {
    const internals = this[INTERNALS]
    if (internals.queueItem) {
      internals.hasRef = false
    }
    return this
  }

  /**
   * Node invokes `_onImmediate` when an immediate is executed:
   * https://github.com/nodejs/node/blob/42d363205715ffa5a4a6d90f4be1311487053d65/lib/internal/timers.js#L504
   * It's visible on the public types, so we want to have it here for parity, but it's a noop.
   * */
  _onImmediate() {}

  [Symbol.dispose]() {
    // This is equivalent to `clearImmediate`.
    const internals = this[INTERNALS]
    if (internals.queueItem) {
      // this is still queued. drop it.
      const queueItem = internals.queueItem
      internals.queueItem = null
      clearQueueItem(queueItem)
    }
  }
}

// ==========================================

// TODO: this causes the scheduler to loop -- apparently the write schedules a nextTick somewhere inside?
const debug =
  process.env.NEXT_DEBUG_IMMEDIATES !== '1'
    ? undefined
    : (...args: any[]) => {
        const { inspect } = require('node:util') as typeof import('node:util')

        let logLine =
          args
            .map((arg) =>
              typeof arg === 'string' ? arg : inspect(arg, { colors: true })
            )
            .join(' ') + '\n'

        logLine = '\x1B[2m' + logLine + '\x1B[22m' // styleText('dim', logLine)
        process.stdout.write(logLine)
      }
