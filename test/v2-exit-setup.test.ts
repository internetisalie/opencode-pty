import { expect, test } from 'bun:test'
import { memoryRegistrationStore } from '../src/v2/registration-store.ts'
import { setupPtyPlugin } from '../src/v2/setup.ts'
import type { PtyExitInput, ToolInfoV2 } from '../src/v2/types.ts'
import { deferred, eventually, TestExitClock } from './lib/v2-exit-fixture.ts'
import {
  acknowledgment,
  baseInfo,
  context,
  listPath,
  projected,
  snapshotResponse,
} from './lib/v2-exit-script.ts'

test('cleanup drains tool registration and preserves its failure', async () => {
  const held = deferred<void>()
  const original = new Error('tool disposal failed')
  let disposed = 0
  const cleanup = await setupPtyPlugin({
    options: {},
    session: {
      synthetic: async () => {
        throw new Error('unexpected synthetic')
      },
    },
    tool: {
      transform: async () => ({
        dispose: () => {
          disposed++
          return held.promise
        },
      }),
    },
  })
  let finished = false
  const pending = cleanup()
  const observed = pending.then(
    () => {
      finished = true
    },
    (error: unknown) => error
  )
  try {
    expect(cleanup()).toBe(pending)
    await Bun.sleep(0)
    expect(finished).toBe(false)
    expect(disposed).toBe(1)
    held.reject(original)
    const error = await observed
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) throw new Error('missing cleanup aggregate')
    expect(error.errors).toEqual([original])
  } finally {
    held.resolve()
    await observed
  }
})

test('session synthetic receiver and independent jobs are preserved', async () => {
  const tools: ToolInfoV2[] = []
  const clock = new TestExitClock()
  const held = deferred<Response>()
  const calls: PtyExitInput[] = []
  const session = {
    token: 'receiver',
    synthetic(input: PtyExitInput) {
      expect(this.token).toBe('receiver')
      calls.push(input)
      return Promise.resolve(acknowledgment(input))
    },
  }
  let creates = 0
  const cleanup = await setupPtyPlugin(
    {
      options: { serverUrl: 'http://127.0.0.1:9876/', serverPassword: '' },
      session,
      tool: {
        transform: async (callback) => {
          callback({ add: (tool) => tools.push(tool) })
          return { dispose: async () => {} }
        },
      },
    },
    {
      clock,
      report: () => {},
      private: true,
      store: memoryRegistrationStore(),
      fetch: async (url, init) => {
        if (init?.method === 'POST')
          return Response.json({ data: { ...baseInfo, id: `pty_persistent_${++creates}` } })
        if (url.pathname === listPath)
          return Response.json({
            data: [projected('exited', 7), { ...projected('exited', 0), id: 'pty_persistent_2' }],
          })
        if (url.pathname.endsWith('/pty_persistent_1/snapshot')) return held.promise
        if (url.pathname.endsWith('/pty_persistent_2/snapshot'))
          return snapshotResponse({ ...projected('exited', 0), id: 'pty_persistent_2' })
        throw new Error('unexpected request')
      },
    }
  )
  try {
    const spawn = tools.find((tool) => tool.name === 'pty_spawn')
    if (!spawn) throw new Error('missing spawn')
    for (let index = 0; index < 2; index++)
      await spawn.execute(
        { command: '/bin/sh', args: [], description: 'case', notifyOnExit: true },
        context()
      )
    clock.advance(0)
    await eventually(() => calls.length === 1)
    expect(calls[0]?.metadata.ptyID).toBe('pty_persistent_2')
    held.resolve(snapshotResponse(projected('exited', 7)))
    await eventually(() => calls.length === 2)
    expect(calls[0]?.id).not.toBe(calls[1]?.id)
  } finally {
    held.resolve(snapshotResponse(projected('exited', 7)))
    await cleanup()
  }
})
