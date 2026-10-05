import { expect, test } from 'bun:test'
import type { PtyExitAdmission, PtyExitInput } from '../src/v2/types.ts'
import { deferred, eventually, fixtureTool } from './lib/v2-exit-fixture.ts'
import {
  acknowledgment,
  assertAdmission,
  context,
  exitFixture,
  listPath,
  projected,
  script,
  snapshotResponse,
  spawn,
} from './lib/v2-exit-script.ts'

// loom:tc LDV-182-REQ#TC-01
test('TC-01 explicit true', async () => {
  const info = projected('exited', 0)
  const fixture = await exitFixture({
    request: script({
      list: async () => Response.json({ data: [info] }),
      snapshot: async () => snapshotResponse(info, 'FINAL0:case'),
    }),
  })
  try {
    const content = await spawn(fixture)
    expect(fixture.clock.pending()).toBe(1)
    expect(content).toContain(
      'Exit monitoring is activation-local; plugin/server restart loses opt-in and uncertain retry state.'
    )
    expect(content).toContain(
      'Exit monitoring retires after bounded missing/incomplete observations or settled admission failures; diagnostics report non-delivery, unconfirmed or slow admission, and each confirmed admission.'
    )
    fixture.clock.advance(0)
    await eventually(() => fixture.admissions.length === 1 && fixture.clock.pending() === 0)
    assertAdmission(fixture.admissions[0], 0)
    expect(content).toContain(fixture.admissions[0]?.id ?? 'missing')
    expect(fixture.requests.map((request) => request.method)).toEqual(['POST', 'GET', 'GET'])
    expect(fixtureTool(fixture, 'pty_spawn').input.properties).toHaveProperty('notifyOnExit', {
      type: 'boolean',
    })
  } finally {
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-02
test('TC-02 explicit false', async () => {
  const info = projected('exited', 0)
  const fixture = await exitFixture({
    request: script({
      list: async () => Response.json({ data: [info] }),
      snapshot: async () => snapshotResponse(info, 'FINAL0:case'),
    }),
  })
  try {
    const content = await spawn(fixture, false)
    expect(fixture.clock.pending()).toBe(0)
    fixture.clock.advance(3000)
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.admissions).toHaveLength(0)
    expect(fixture.requests[0]?.body).not.toHaveProperty('notifyOnExit')
    expect(content).not.toContain('Exit monitoring')
  } finally {
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-03
test('TC-03 absent', async () => {
  const fixture = await exitFixture()
  try {
    await fixtureTool(fixture, 'pty_spawn').execute(
      { command: '/bin/sh', args: [], description: 'case' },
      context()
    )
    expect(fixture.clock.pending()).toBe(0)
    fixture.clock.advance(3000)
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.admissions).toHaveLength(0)
  } finally {
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-04
test('TC-04 frozen spawning session', async () => {
  const creation = deferred<Response>()
  const info = projected('exited', 7)
  const fixture = await exitFixture({
    request: script({
      create: () => creation.promise,
      list: async () =>
        Response.json({ data: [info, { ...projected('running'), id: 'pty_persistent_2' }] }),
      snapshot: async () => snapshotResponse(info),
    }),
  })
  const ctx = { ...context() }
  try {
    const pending = fixtureTool(fixture, 'pty_spawn').execute(
      { command: '/bin/sh', args: [], description: 'case', notifyOnExit: true },
      ctx
    )
    expect(fixture.clock.pending()).toBe(0)
    ctx.sessionID = 'ses_B'
    creation.resolve(Response.json({ data: projected('running') }))
    await pending
    fixture.clock.advance(0)
    await eventually(() => fixture.requests.length >= 2)
    expect(fixture.requests[1]?.path).toBe(listPath)
    await eventually(() => fixture.admissions.length === 1)
    assertAdmission(fixture.admissions[0], 7)
    expect(fixture.requests[2]?.path).toBe(
      '/api/experimental/persistent-pty/pty_persistent_1/snapshot'
    )
  } finally {
    creation.resolve(Response.json({ data: projected('running') }))
    await fixture.cleanup()
  }
})

for (const code of [0, 7]) {
  // loom:tc LDV-182-REQ#TC-05
  test(`TC-05 exits ${code}`, async () => {
    const info = projected('exited', code)
    const fixture = await exitFixture({
      request: script({
        list: async () => Response.json({ data: [info] }),
        snapshot: async () => snapshotResponse(info, `FINAL${code}:case`),
      }),
    })
    try {
      await spawn(fixture)
      fixture.clock.advance(0)
      await eventually(() => fixture.admissions.length === 1 && fixture.clock.pending() === 0)
      assertAdmission(fixture.admissions[0], code)
      fixture.clock.advance(60000)
      expect(fixture.admissions).toHaveLength(1)
    } finally {
      await fixture.cleanup()
    }
  })
}

// loom:tc LDV-182-REQ#TC-07
test('TC-07 inconsistent then agreeing', async () => {
  let samples = 0
  const fixture = await exitFixture({
    request: script({
      list: async () => Response.json({ data: [projected('exited', 7)] }),
      snapshot: async () => snapshotResponse(projected(samples++ === 0 ? 'running' : 'exited', 7)),
    }),
  })
  try {
    await spawn(fixture)
    fixture.clock.advance(0)
    await eventually(() => fixture.diagnostics.length === 1 && fixture.clock.pending() === 1)
    expect(fixture.admissions).toHaveLength(0)
    fixture.clock.advance(1000)
    await eventually(() => fixture.admissions.length === 1)
    assertAdmission(fixture.admissions[0], 7)
  } finally {
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-08
test('TC-08 delayed failed admission', async () => {
  const held = deferred<PtyExitAdmission>()
  const fixture = await exitFixture({
    synthetic: (input) =>
      fixture.admissions.length === 1 ? held.promise : Promise.resolve(acknowledgment(input)),
  })
  try {
    await spawn(fixture)
    fixture.clock.advance(0)
    await eventually(() => fixture.admissions.length === 1)
    fixture.clock.advance(60000)
    expect(fixture.admissions).toHaveLength(1)
    expect(fixture.clock.pending()).toBe(0)
    held.reject(new Error('scripted loss'))
    await eventually(() =>
      fixture.diagnostics.some((item) => item.reason === 'admission-unconfirmed')
    )
    await Bun.sleep(0)
    fixture.clock.advance(1000)
    await eventually(() => fixture.admissions.length === 2)
    expect(fixture.admissions[1]).toBe(fixture.admissions[0])
  } finally {
    held.resolve(acknowledgment(fixture.admissions[0] as PtyExitInput))
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-09
test('TC-09 uncertain admission retry', async () => {
  const store = new Map<string, PtyExitAdmission>()
  const fixture = await exitFixture({
    synthetic: async (input) => {
      const saved = store.get(input.id)
      if (saved) return saved
      store.set(input.id, acknowledgment(input))
      throw new Error('stored then response lost')
    },
  })
  try {
    const first = await spawn(fixture)
    expect(await spawn(fixture)).toBe(first)
    fixture.clock.advance(0)
    await eventually(() => fixture.diagnostics.length === 1 && fixture.clock.pending() === 1)
    assertAdmission(fixture.admissions[0], 7)
    fixture.clock.advance(1000)
    await eventually(() => fixture.admissions.length === 2 && fixture.clock.pending() <= 1)
    expect(store.size).toBe(1)
    expect(fixture.admissions[1]).toEqual(fixture.admissions[0])
    await Bun.sleep(0)
    fixture.clock.advance(60000)
    expect(fixture.admissions).toHaveLength(2)
    expect(fixture.clock.pending()).toBe(0)
    expect(await spawn(fixture)).toBe(first)
    expect(fixture.clock.pending()).toBe(0)
  } finally {
    await fixture.cleanup()
  }
})
