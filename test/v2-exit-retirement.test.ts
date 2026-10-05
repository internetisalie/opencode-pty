import { expect, test } from 'bun:test'
import type { PtyExitInput } from '../src/v2/types.ts'
import { eventually, fixtureTool } from './lib/v2-exit-fixture.ts'
import {
  assertDiagnostic,
  context,
  exitFixture,
  projected,
  script,
  snapshotResponse,
  spawn,
  tick,
} from './lib/v2-exit-script.ts'

for (const kind of ['missing', 'incomplete', 'alternating'] as const) {
  // A terminal never observed running cannot be inferred to have exited, so it retires without a notice.
  // loom:tc LDV-182-REQ#TC-17
  test(`TC-17 ${kind} retirement`, async () => {
    let samples = 0
    const fixture = await exitFixture({
      request: script({
        list: async () => {
          const index = samples++
          const absent = kind === 'missing' || (kind === 'alternating' && index % 2 === 0)
          return Response.json({ data: absent ? [] : [projected('exited', 7)] })
        },
        snapshot: async () => Response.json({ error: 'gone' }, { status: 404 }),
      }),
    })
    try {
      const first = await spawn(fixture)
      await tick(fixture, 0)
      for (let index = 1; index < (kind === 'missing' ? 3 : 8); index++) await tick(fixture)
      assertDiagnostic(
        fixture,
        kind === 'missing' ? 'observation-missing-exhausted' : 'observation-incomplete-exhausted'
      )
      assertDiagnostic(fixture, kind === 'missing' ? 'missing-pty' : 'read-failed')
      expect(fixture.admissions).toHaveLength(0)
      expect(fixture.clock.pending()).toBe(0)
      const count = fixture.requests.length
      fixture.clock.advance(60000)
      expect(fixture.requests).toHaveLength(count)
      expect(await spawn(fixture)).toBe(first)
      expect(fixture.clock.pending()).toBe(0)
      const reasons = fixture.diagnostics.map((entry) => entry.reason)
      await fixture.cleanup()
      expect(fixture.diagnostics.map((entry) => entry.reason)).toEqual(reasons)
    } finally {
      await fixture.cleanup()
    }
  })
}

// loom:tc LDV-182-REQ#TC-17
test('TC-17 running resets counters without diagnostic reset', async () => {
  let sample = 0
  const fixture = await exitFixture({
    request: script({
      list: async () => {
        const index = sample++
        return Response.json({ data: index === 2 ? [projected('running')] : [] })
      },
      snapshot: async () => snapshotResponse(projected('running')),
    }),
  })
  try {
    await spawn(fixture)
    for (let index = 0; index < 5; index++) await tick(fixture, index === 0 ? 0 : 1000)
    expect(fixture.clock.pending()).toBe(1)
    expect(fixture.diagnostics).toHaveLength(1)
    await tick(fixture)
    assertDiagnostic(fixture, 'missing-pty')
    assertDiagnostic(fixture, 'exit-inferred')
    await eventually(() => fixture.admissions.length === 1)
    expect(fixture.clock.pending()).toBe(0)
  } finally {
    await fixture.cleanup()
  }
})

// loom:tc LDV-233
test('a terminal seen running and then absent is reported as exited with an unknown code', async () => {
  let samples = 0
  const fixture = await exitFixture({
    request: script({
      list: async () => Response.json({ data: samples++ === 0 ? [projected('running')] : [] }),
      snapshot: async () => snapshotResponse(projected('running')),
    }),
  })
  try {
    await spawn(fixture)
    await tick(fixture, 0)
    for (let index = 1; index < 4; index++) await tick(fixture)
    await eventually(() => fixture.admissions.length === 1)
    const input = fixture.admissions[0] as PtyExitInput
    expect(input.text).toContain('"exitCode":null,"result":"unknown"')
    expect(input.metadata.kind).toBe('exit')
    expect('exitCode' in input.metadata).toBe(false)
    expect(Object.isFrozen(input)).toBe(true)
    expect(fixture.diagnostics.map((entry) => entry.reason)).toEqual([
      'missing-pty',
      'exit-inferred',
      'admitted',
    ])
    expect(fixture.clock.pending()).toBe(0)
  } finally {
    await fixture.cleanup()
  }
})

// loom:tc LDV-233
test('a terminal seen running and then absent is not reported when exit notice is off', async () => {
  let samples = 0
  const fixture = await exitFixture({
    request: script({
      list: async () => Response.json({ data: samples++ === 0 ? [projected('running')] : [] }),
      snapshot: async () => snapshotResponse(projected('running')),
    }),
  })
  try {
    await fixtureTool(fixture, 'pty_spawn').execute(
      { command: '/bin/sh', args: [], description: 'case', notifyOnOutput: true },
      context()
    )
    await tick(fixture, 0)
    for (let index = 1; index < 4; index++) await tick(fixture)
    expect(fixture.admissions.filter((input) => input.metadata.kind === 'exit')).toHaveLength(0)
    assertDiagnostic(fixture, 'observation-missing-exhausted')
  } finally {
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-18
test('TC-18 persistent unconfirmed retires', async () => {
  const fixture = await exitFixture({
    synthetic: async () => {
      throw new Error(`unknown ${fixture.admissions.length}`)
    },
  })
  try {
    await spawn(fixture)
    fixture.clock.advance(0)
    await eventually(() => fixture.admissions.length === 1 && fixture.clock.pending() === 1)
    for (const [index, delay] of [1000, 2000, 4000].entries()) {
      fixture.clock.advance(delay - 1)
      expect(fixture.admissions).toHaveLength(index + 1)
      fixture.clock.advance(1)
      await eventually(
        () => fixture.admissions.length === index + 2 && fixture.clock.pending() <= 1
      )
      await Bun.sleep(0)
    }
    expect(fixture.admissions).toHaveLength(4)
    const first = fixture.admissions[0]
    if (!first) throw new Error('missing initial admission')
    for (const input of fixture.admissions) expect(input).toBe(first)
    expect(fixture.clock.pending()).toBe(0)
    assertDiagnostic(fixture, 'admission-unconfirmed', 'unconfirmed')
    assertDiagnostic(fixture, 'admission-unconfirmed-exhausted', 'unconfirmed')
    fixture.clock.advance(60000)
    expect(fixture.admissions).toHaveLength(4)
    await fixture.cleanup()
    expect(fixture.diagnostics).toHaveLength(2)
  } finally {
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-17
test('TC-17 running resets incomplete counter', async () => {
  let sample = 0
  let running = false
  const fixture = await exitFixture({
    request: script({
      list: async () => {
        running = sample++ === 7
        return Response.json({ data: [projected(running ? 'running' : 'exited', 7)] })
      },
      snapshot: async () =>
        running
          ? snapshotResponse(projected('running', 7))
          : Response.json({ error: 'gone' }, { status: 404 }),
    }),
  })
  try {
    await spawn(fixture)
    for (let index = 0; index < 15; index++) await tick(fixture, index === 0 ? 0 : 1000)
    expect(fixture.clock.pending()).toBe(1)
    assertDiagnostic(fixture, 'read-failed')
    expect(fixture.diagnostics).toHaveLength(1)
    await tick(fixture)
    assertDiagnostic(fixture, 'observation-incomplete-exhausted')
    expect(fixture.clock.pending()).toBe(0)
  } finally {
    await fixture.cleanup()
  }
})

// loom:tc LDV-233
test('a terminal removed by pty_kill is not reported as exited', async () => {
  let samples = 0
  const base = script({
    list: async () => Response.json({ data: samples++ === 0 ? [projected('running')] : [] }),
    snapshot: async () => snapshotResponse(projected('running')),
  })
  const fixture = await exitFixture({
    request: async (request) => {
      if (request.path.endsWith('/persistent-pty/pty_persistent_1')) {
        if (request.method === 'DELETE') return new Response(null, { status: 204 })
        return Response.json({ data: projected('running') })
      }
      return base(request)
    },
  })
  try {
    await spawn(fixture)
    await tick(fixture, 0)
    await fixtureTool(fixture, 'pty_kill').execute({ id: 'pty_persistent_1' }, context())
    for (let index = 0; index < 5; index++) {
      fixture.clock.advance(1000)
      await Bun.sleep(0)
    }
    expect(fixture.admissions).toHaveLength(0)
    expect(fixture.clock.pending()).toBe(0)
    expect(fixture.diagnostics).toHaveLength(0)
  } finally {
    await fixture.cleanup()
  }
})
