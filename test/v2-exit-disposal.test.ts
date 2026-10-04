import { expect, test } from 'bun:test'
import { deferred, eventually, fixtureTool } from './lib/v2-exit-fixture.ts'
import {
  assertDiagnostic,
  baseInfo,
  context,
  exitFixture,
  projected,
  script,
  snapshotResponse,
  spawn,
} from './lib/v2-exit-script.ts'

// loom:tc LDV-182-REQ#TC-11
test('TC-11 actual cleanup aborts reads', async () => {
  const held = deferred<Response>()
  const fixture = await exitFixture({
    request: async (request) => {
      if (request.method === 'POST') return Response.json({ data: baseInfo })
      request.signal?.addEventListener('abort', () => held.reject(new Error('aborted')), {
        once: true,
      })
      return held.promise
    },
  })
  try {
    await spawn(fixture)
    fixture.clock.advance(0)
    await eventually(() => fixture.requests.length === 2)
    const pending = fixture.cleanup()
    expect(pending).toBe(fixture.cleanup())
    expect(fixture.requests[1]?.signal?.aborted).toBe(true)
    await pending
    expect(fixture.disposed()).toBe(1)
    expect(fixture.clock.pending()).toBe(0)
    fixture.clock.advance(60000)
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.admissions).toHaveLength(0)
    expect(fixture.diagnostics.map((entry) => entry.reason)).toEqual(['disposed-registration-lost'])
  } finally {
    held.resolve(Response.json({ data: [] }))
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-11
test('TC-11 cleanup cancels poll', async () => {
  const fixture = await exitFixture()
  try {
    await spawn(fixture)
    expect(fixture.clock.pending()).toBe(1)
    await fixture.cleanup()
    expect(fixture.clock.pending()).toBe(0)
    fixture.clock.advance(60000)
    expect(fixture.requests).toHaveLength(1)
  } finally {
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-11
test('TC-11 late create', async () => {
  const held = deferred<Response>()
  const fixture = await exitFixture({
    request: script({
      create: () => held.promise,
      list: async () => {
        throw new Error('unexpected list')
      },
      snapshot: async () => {
        throw new Error('unexpected snapshot')
      },
    }),
  })
  try {
    const pending = spawn(fixture)
    await fixture.cleanup()
    held.resolve(Response.json({ data: baseInfo }))
    expect(await pending).toContain(
      'Exit monitoring unavailable; PTY retained, no notification promised.'
    )
    expect(fixture.clock.pending()).toBe(0)
    expect(fixture.admissions).toHaveLength(0)
  } finally {
    held.resolve(Response.json({ data: baseInfo }))
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-11
test('TC-11 late snapshot resolution', async () => {
  const held = deferred<Response>()
  const fixture = await exitFixture({
    request: script({
      list: async () => Response.json({ data: [projected('exited', 0)] }),
      snapshot: () => held.promise,
    }),
  })
  try {
    await spawn(fixture)
    fixture.clock.advance(0)
    await eventually(() => fixture.requests.length === 3)
    const pending = fixture.cleanup()
    expect(fixture.requests[2]?.signal?.aborted).toBe(true)
    held.resolve(snapshotResponse(projected('exited', 0)))
    await pending
    expect(fixture.admissions).toHaveLength(0)
    expect(fixture.diagnostics.map((entry) => entry.reason)).toEqual(['disposed-registration-lost'])
    expect(fixture.clock.pending()).toBe(0)
  } finally {
    held.resolve(snapshotResponse(projected('exited', 0)))
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-11
test('TC-11 unexpected clock failure', async () => {
  const fixture = await exitFixture({ deadlineFailure: 'throw' })
  try {
    await spawn(fixture)
    fixture.clock.advance(0)
    await Bun.sleep(0)
    assertDiagnostic(fixture, 'worker-failed')
    expect(fixture.clock.pending()).toBe(0)
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.admissions).toHaveLength(0)
    fixture.clock.advance(60000)
    expect(fixture.requests).toHaveLength(1)
  } finally {
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-11
test('TC-11 disposal reports observing registration', async () => {
  const fixture = await exitFixture()
  try {
    const result = await spawn(fixture)
    const pending = fixture.cleanup()
    expect(fixture.cleanup()).toBe(pending)
    assertDiagnostic(fixture, 'disposed-registration-lost')
    expect(result).toContain(fixture.diagnostics[0]?.notificationID ?? 'missing')
    expect(fixture.clock.pending()).toBe(0)
    expect(fixture.requests).toHaveLength(1)
    await pending
    fixture.clock.advance(60000)
    expect(fixture.diagnostics).toHaveLength(1)
    expect(fixture.admissions).toHaveLength(0)
    expect(fixtureTool(fixture, 'pty_spawn').name).toBe('pty_spawn')
    expect(context().sessionID).toBe('ses_A')
  } finally {
    await fixture.cleanup()
  }
})
