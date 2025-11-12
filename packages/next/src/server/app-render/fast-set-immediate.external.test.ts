import { AsyncLocalStorage } from 'node:async_hooks'
import { createPromiseWithResolvers } from '../../shared/lib/promise-with-resolvers'
import {
  install,
  DANGEROUSLY_runPendingImmediatesAfterCurrentTask,
} from './fast-set-immediate.external'

install()

function createLogger() {
  const logs: string[] = []

  const log = (...args: any[]) => {
    const { inspect } = require('node:util') as typeof import('node:util')

    let logLine = args
      .map((arg) =>
        typeof arg === 'string' ? arg : inspect(arg, { colors: true })
      )
      .join(' ')

    logs.push(logLine)
    process.stdout.write(logLine + '\n')
  }
  return { logs, log }
}

it('runs immediates after each task', async () => {
  const { log, logs } = createLogger()
  const done = createPromiseWithResolvers<void>()

  setTimeout(() => {
    DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

    log('timeout 1')
    setImmediate(() => {
      log('timeout 1 -> immediate 1')
      process.nextTick(() => {
        log('timeout 1 -> immediate 1 -> nextTick 1')
        queueMicrotask(() => {
          log('timeout 1 -> immediate 1 -> nextTick 1 -> microtask 1')
        })
        queueMicrotask(() => {
          process.nextTick(() => {
            log(
              'timeout 1 -> immediate 1 -> nextTick 1 -> microtask 2 -> nextTick'
            )
          })
        })
      })
    })
    setImmediate(() => {
      log('timeout 1 -> immediate 2')
    })
    process.nextTick(() => {
      log('timeout 1 -> nextTick 1')
      queueMicrotask(() => {
        log('timeout 1 -> nextTick 1 -> microtask 1')
      })
      queueMicrotask(() => {
        process.nextTick(() => {
          log('timeout 1 -> nextTick 1 -> microtask 2 -> nextTick')
        })
      })
      process.nextTick(() => {
        log('timeout 1 -> nextTick 1 -> nextTick 1')
      })
    })
  })
  setTimeout(() => {
    DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

    log('timeout 2')
    setImmediate(() => {
      log('timeout 2 -> immediate 1')
      setImmediate(() => {
        log('timeout 2 -> immediate 1 -> immediate 1')
      })
    })
  })
  setTimeout(() => {
    log('timeout 3')
    done.resolve()
  })

  await done.promise

  expect(logs).toEqual([
    // ===================================
    'timeout 1',
    'timeout 1 -> nextTick 1',
    'timeout 1 -> nextTick 1 -> nextTick 1',
    'timeout 1 -> nextTick 1 -> microtask 1',
    'timeout 1 -> nextTick 1 -> microtask 2 -> nextTick',
    // ======================
    'timeout 1 -> immediate 1',
    'timeout 1 -> immediate 1 -> nextTick 1',
    'timeout 1 -> immediate 1 -> nextTick 1 -> microtask 1',
    'timeout 1 -> immediate 1 -> nextTick 1 -> microtask 2 -> nextTick',
    // ======================
    'timeout 1 -> immediate 2',
    // ===================================
    'timeout 2',
    // ======================
    'timeout 2 -> immediate 1',
    // ======================
    'timeout 2 -> immediate 1 -> immediate 1',
    // ===================================
    'timeout 3',
  ])
})

it('only affects the task it is called in', async () => {
  const { log, logs } = createLogger()
  const done = createPromiseWithResolvers<void>()

  setTimeout(() => {
    DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

    log('timeout 1')
    setImmediate(() => {
      log('timeout 1 -> immediate 1 (fast)')
      setImmediate(() => {
        log('timeout 1 -> immediate 1 (fast) -> immediate 1 (fast)')
      })
    })
  })
  setTimeout(() => {
    log('timeout 2')
    setImmediate(() => {
      log('timeout 2 -> immediate 1 (slow)')
      done.resolve()
    })
  })
  setTimeout(() => {
    log('timeout 3')
  })

  await done.promise

  expect(logs).toEqual([
    // ===================================
    'timeout 1',
    // ======================
    'timeout 1 -> immediate 1 (fast)',
    // ======================
    'timeout 1 -> immediate 1 (fast) -> immediate 1 (fast)',
    // ===================================
    'timeout 2',
    // ===================================
    'timeout 3',
    // ======================
    'timeout 2 -> immediate 1 (slow)',
  ])
})

it('does not run immediates scheduled before it was called', async () => {
  const { log, logs } = createLogger()
  const done = createPromiseWithResolvers<void>()

  setTimeout(() => {
    log('timeout 1')

    setImmediate(() => {
      log('timeout 1 -> immediate 1 (slow)')
      done.resolve()
    })

    DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

    setImmediate(() => {
      log('timeout 1 -> immediate 2 (fast)')
    })
  })
  setTimeout(() => {
    log('timeout 2')
  })

  await done.promise

  expect(logs).toEqual([
    // ===================================
    'timeout 1',
    // ======================
    'timeout 1 -> immediate 2 (fast)',
    // ===================================
    'timeout 2',
    // ======================
    'timeout 1 -> immediate 1 (slow)',
  ])
})

it('runs immediates scheduled in nextTick', async () => {
  const { log, logs } = createLogger()
  const done = createPromiseWithResolvers<void>()

  setTimeout(() => {
    DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

    log('timeout 1')
    process.nextTick(() => {
      setImmediate(() => {
        log('timeout 1 -> nextTick -> immediate 1')
        process.nextTick(() => {
          setImmediate(() => {
            log(
              'timeout 1 -> nextTick -> immediate 1 -> nextTick -> immediate 1'
            )
          })
        })
      })
    })
  })
  setTimeout(() => {
    log('timeout 2')
    done.resolve()
  })

  await done.promise

  expect(logs).toEqual([
    // ===================================
    'timeout 1',
    // ======================
    'timeout 1 -> nextTick -> immediate 1',
    // ======================
    'timeout 1 -> nextTick -> immediate 1 -> nextTick -> immediate 1',
    // ===================================
    'timeout 2',
  ])
})

it('runs ticks and microtasks from immediates before moving onto the next task', async () => {
  const { log, logs } = createLogger()
  const done = createPromiseWithResolvers<void>()

  setTimeout(() => {
    DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

    log('timeout 1')
    setImmediate(() => {
      log('timeout 1 -> immediate 1')
      queueMicrotask(() => {
        log('timeout 1 -> immediate 1 -> microtask 1')
        queueMicrotask(() => {
          log('timeout 1 -> immediate 1 -> microtask 1 -> microtask 1')
        })
        process.nextTick(() => {
          log('timeout 1 -> immediate 1 -> microtask 1 -> nextTick')
        })
      })
      process.nextTick(() => {
        log('timeout 1 -> immediate 1 -> nextTick')
      })
    })
  })
  setTimeout(() => {
    log('timeout 2')
    done.resolve()
  })

  await done.promise

  expect(logs).toEqual([
    // ===================================
    'timeout 1',
    // ======================
    'timeout 1 -> immediate 1',
    'timeout 1 -> immediate 1 -> nextTick',
    'timeout 1 -> immediate 1 -> microtask 1',
    'timeout 1 -> immediate 1 -> microtask 1 -> microtask 1',
    'timeout 1 -> immediate 1 -> microtask 1 -> nextTick',
    // ===================================
    'timeout 2',
  ])
})

describe('alternate sources of immediates', () => {
  it('promisify(setImmediate)', async () => {
    // `setImmediate` defines a `util.promisify.custom`, and so does our patch.
    const { log, logs } = createLogger()
    const done = createPromiseWithResolvers<void>()

    const { promisify } = require('node:util') as typeof import('node:util')
    const promisifiedSetImmediate = promisify(setImmediate)

    setTimeout(() => {
      DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

      log('timeout 1')
      promisifiedSetImmediate().then(() => {
        log('timeout 1 -> immediate 1')
      })
    })
    setTimeout(() => {
      log('timeout 2')
      done.resolve()
    })

    await done.promise

    expect(logs).toEqual([
      // ===================================
      'timeout 1',
      // ======================
      'timeout 1 -> immediate 1',
      // ======================
      'timeout 2',
    ])
  })

  it('require("node:timers").setImmediate', async () => {
    const { log, logs } = createLogger()
    const done = createPromiseWithResolvers<void>()

    const timers = require('node:timers') as typeof import('node:timers')

    setTimeout(() => {
      DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

      log('timeout 1')
      timers.setImmediate(() => {
        log('timeout 1 -> immediate 1')
      })
    })
    setTimeout(() => {
      log('timeout 2')
      done.resolve()
    })

    await done.promise

    expect(logs).toEqual([
      // ===================================
      'timeout 1',
      // ======================
      'timeout 1 -> immediate 1',
      // ======================
      'timeout 2',
    ])
  })

  it('require("node:timers/promises").setImmediate', async () => {
    const { log, logs } = createLogger()
    const done = createPromiseWithResolvers<void>()

    const timersPromises =
      require('node:timers/promises') as typeof import('node:timers/promises')

    setTimeout(() => {
      DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

      log('timeout 1')
      timersPromises.setImmediate().then(() => {
        log('timeout 1 -> immediate 1')
      })
    })
    setTimeout(() => {
      log('timeout 2')
      done.resolve()
    })

    await done.promise

    expect(logs).toEqual([
      // ===================================
      'timeout 1',
      // ======================
      'timeout 1 -> immediate 1',
      // ======================
      'timeout 2',
    ])
  })
})

describe('async context propagation', () => {
  it('propagates AsyncLocalStorage to setImmediate', async () => {
    const { log, logs } = createLogger()
    const done = createPromiseWithResolvers<void>()
    const Ctx = new AsyncLocalStorage<string>()

    Ctx.run('outer', () => {
      setTimeout(() => {
        DANGEROUSLY_runPendingImmediatesAfterCurrentTask()
        log(`timeout 1 :: ${Ctx.getStore()}`)
        setImmediate(() => {
          // The outer context should be readable here
          log(`timeout 1 -> immediate 1 :: ${Ctx.getStore()}`)
          // Shadow the outer context
          Ctx.run('inner', () => {
            setImmediate(() => {
              // The inner context should be readable here
              log(
                `timeout 1 -> immediate 1 -> immediate 1 :: ${Ctx.getStore()}`
              )
            })
          })
        })
      })
    })
    setTimeout(() => {
      // The context should not be readable here
      log(`timeout 2 :: ${Ctx.getStore()}`)
      done.resolve()
    })

    await done.promise

    expect(logs).toEqual([
      // ===================================
      'timeout 1 :: outer',
      // ======================
      'timeout 1 -> immediate 1 :: outer',
      // ======================
      'timeout 1 -> immediate 1 -> immediate 1 :: inner',
      // ===================================
      'timeout 2 :: undefined',
    ])
  })

  it('does not break AsyncLocalStorage propagation in process.nextTick', async () => {
    // We don't alter the implementation of `process.nextTick` much,
    // but we do patch it, so as a sanity check it's worth verifying that
    // we're not breaking async context propagation.

    const { log, logs } = createLogger()
    const done = createPromiseWithResolvers<void>()
    const Ctx = new AsyncLocalStorage<string>()

    Ctx.run('hello', () => {
      setTimeout(() => {
        DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

        log(`timeout 1 :: ${Ctx.getStore()}`)
        process.nextTick(() => {
          // the context should be readable here
          log(`timeout 1 -> nextTick :: ${Ctx.getStore()}`)
        })
      })
    })
    setTimeout(() => {
      // The context should not be readable here
      log(`timeout 2 :: ${Ctx.getStore()}`)
      done.resolve()
    })

    await done.promise

    expect(logs).toEqual([
      // ===================================
      'timeout 1 :: hello',
      // ======================
      'timeout 1 -> nextTick :: hello',
      // ===================================
      'timeout 2 :: undefined',
    ])
  })
})

describe('allows cancelling immediates', () => {
  it('synchronously', async () => {
    const { log, logs } = createLogger()

    const done = createPromiseWithResolvers<void>()

    setTimeout(() => {
      DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

      log('timeout 1')
      setImmediate(() => {
        log('timeout 1 -> immediate 1')
      })
      const immediate2 = setImmediate(() => {
        log('timeout 1 -> immediate 2')
      })
      clearImmediate(immediate2)
    })
    setTimeout(() => {
      log('timeout 2')
      done.resolve()
    })

    await done.promise

    expect(logs).toEqual([
      // ===================================
      'timeout 1',
      // ======================
      'timeout 1 -> immediate 1',
      // ===================================
      'timeout 2',
    ])
  })

  it('from a nextTick', async () => {
    const { log, logs } = createLogger()

    const done = createPromiseWithResolvers<void>()

    setTimeout(() => {
      DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

      log('timeout 1')
      setImmediate(() => {
        log('timeout 1 -> immediate 1')
      })
      const immediate2 = setImmediate(() => {
        log('timeout 1 -> immediate 2')
      })
      process.nextTick(() => {
        clearImmediate(immediate2)
      })
    })
    setTimeout(() => {
      log('timeout 2')
      done.resolve()
    })

    await done.promise

    expect(logs).toEqual([
      // ===================================
      'timeout 1',
      // ======================
      'timeout 1 -> immediate 1',
      // ===================================
      'timeout 2',
    ])
  })

  it('from another immediate', async () => {
    const { log, logs } = createLogger()

    const done = createPromiseWithResolvers<void>()

    setTimeout(() => {
      DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

      log('timeout 1')
      setImmediate(() => {
        log('timeout 1 -> immediate 1')
        clearImmediate(immediate2)
      })
      const immediate2 = setImmediate(() => {
        log('timeout 1 -> immediate 2')
      })
    })
    setTimeout(() => {
      log('timeout 2')
      done.resolve()
    })

    await done.promise

    expect(logs).toEqual([
      // ===================================
      'timeout 1',
      // ======================
      'timeout 1 -> immediate 1',
      // ===================================
      'timeout 2',
    ])
  })

  it('promisified - with an AbortSignal after creating', async () => {
    const { log, logs } = createLogger()

    const done = createPromiseWithResolvers<void>()

    const { promisify } = require('node:util') as typeof import('node:util')
    const promisifiedSetImmediate = promisify(setImmediate)

    const abortError = new Error('Stop right there')
    let thrownOnAbort: unknown

    setTimeout(() => {
      DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

      log('timeout 1')
      setImmediate(() => {
        log('timeout 1 -> immediate 1')
      })

      const abortController = new AbortController()

      promisifiedSetImmediate(undefined, {
        signal: abortController.signal,
      }).then(
        () => {
          log('timeout 1 -> immediate 2')
        },
        (err) => {
          thrownOnAbort = err
        }
      )

      abortController.abort(abortError)
    })
    setTimeout(() => {
      log('timeout 2')
      done.resolve()
    })

    await done.promise

    expect(logs).toEqual([
      // ===================================
      'timeout 1',
      // ======================
      'timeout 1 -> immediate 1',
      // ===================================
      'timeout 2',
    ])
    expect(thrownOnAbort).toBe(abortError)
  })

  it('promisified - with an AbortSignal that was already aborted', async () => {
    const { log, logs } = createLogger()

    const done = createPromiseWithResolvers<void>()

    const { promisify } = require('node:util') as typeof import('node:util')
    const promisifiedSetImmediate = promisify(setImmediate)

    const abortError = new Error('Stop right there')
    let thrownOnAbort: unknown

    setTimeout(() => {
      DANGEROUSLY_runPendingImmediatesAfterCurrentTask()

      log('timeout 1')
      setImmediate(() => {
        log('timeout 1 -> immediate 1')
      })

      const abortController = new AbortController()
      abortController.abort(abortError)

      promisifiedSetImmediate(undefined, {
        signal: abortController.signal,
      }).then(
        () => {
          log('timeout 1 -> immediate 2')
        },
        (err) => {
          thrownOnAbort = err
        }
      )
    })
    setTimeout(() => {
      log('timeout 2')
      done.resolve()
    })

    await done.promise

    expect(logs).toEqual([
      // ===================================
      'timeout 1',
      // ======================
      'timeout 1 -> immediate 1',
      // ===================================
      'timeout 2',
    ])
    expect(thrownOnAbort).toBe(abortError)
  })
})
