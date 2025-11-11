import { createPromiseWithResolvers } from '../../shared/lib/promise-with-resolvers'
import {
  install,
  runPendingImmediatesAfterCurrentTask,
} from './fast-set-immediate.external'

install()

it('runs immediates after each task', async () => {
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

  const done = createPromiseWithResolvers<void>()

  setTimeout(() => {
    runPendingImmediatesAfterCurrentTask()

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
    runPendingImmediatesAfterCurrentTask()

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
