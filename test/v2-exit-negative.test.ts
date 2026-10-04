import { expect, test } from 'bun:test'
import { negativeCases } from './lib/v2-exit-cases.ts'
import { deferred, eventually } from './lib/v2-exit-fixture.ts'
import {
  assertAdmission,
  assertDiagnostic,
  exitFixture,
  projected,
  script,
  snapshotResponse,
  spawn,
} from './lib/v2-exit-script.ts'

for (const entry of negativeCases) {
  // loom:tc LDV-182-REQ#TC-06
  test(`TC-06 ${entry.name}`, async () => {
    let parentExit = false
    const fixture = await exitFixture({
      request: script({
        list: async () => {
          if (parentExit) return Response.json({ data: [projected('exited', 0)] })
          if (entry.readFailure === 'reject') throw new Error('scripted loss')
          if (entry.readFailure === 'eof') return new Response('{"data":[')
          return Response.json({ data: entry.listed })
        },
        snapshot: async () => {
          if (parentExit) return snapshotResponse(projected('exited', 0))
          if (entry.readFailure === 'snapshot404')
            return Response.json({ error: 'gone' }, { status: 404 })
          if (!entry.snapshot) throw new Error('unexpected snapshot')
          return Response.json({
            data: { ...entry.snapshot, checkpoint: 'AA==', cursor: { x: 0, y: 0 } },
          })
        },
      }),
    })
    try {
      await spawn(fixture)
      fixture.clock.advance(0)
      const count = entry.snapshot || entry.readFailure === 'snapshot404' ? 3 : 2
      await eventually(() => fixture.requests.length >= count && fixture.clock.pending() <= 1)
      await Bun.sleep(0)
      expect(fixture.admissions).toHaveLength(0)
      expect(fixture.requests).toHaveLength(count)
      expect(fixture.clock.pending()).toBe(1)
      if (entry.reason) assertDiagnostic(fixture, entry.reason)
      else expect(fixture.diagnostics).toHaveLength(0)
      if (entry.name === 'running-child7') {
        parentExit = true
        fixture.clock.advance(1000)
        await eventually(() => fixture.admissions.length === 1)
        assertAdmission(fixture.admissions[0], 0)
      }
    } finally {
      await fixture.cleanup()
    }
  })
}

// loom:tc LDV-182-REQ#TC-06
test('TC-06 request-deadline', async () => {
  const held = deferred<Response>()
  const fixture = await exitFixture({
    request: async (request) => {
      if (request.method === 'POST') return Response.json({ data: projected('running') })
      request.signal?.addEventListener('abort', () => held.reject(new Error('read aborted')), {
        once: true,
      })
      return held.promise
    },
  })
  try {
    await spawn(fixture)
    fixture.clock.advance(0)
    await eventually(() => fixture.requests.length === 2)
    fixture.clock.advance(4999)
    expect(fixture.requests[1]?.signal?.aborted).toBe(false)
    fixture.clock.advance(1)
    await eventually(() => fixture.diagnostics.length === 1)
    expect(fixture.requests[1]?.signal?.aborted).toBe(true)
    expect(fixture.admissions).toHaveLength(0)
    assertDiagnostic(fixture, 'read-deadline')
  } finally {
    held.resolve(Response.json({ data: [] }))
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-06
test('TC-06 removed-after-running', async () => {
  let removed = false
  const fixture = await exitFixture({
    request: script({
      list: async () => Response.json({ data: removed ? [] : [projected('running')] }),
      snapshot: async () => snapshotResponse(projected('running')),
    }),
  })
  try {
    await spawn(fixture)
    fixture.clock.advance(0)
    await eventually(() => fixture.requests.length === 3 && fixture.clock.pending() === 1)
    removed = true
    fixture.clock.advance(1000)
    await eventually(() => fixture.requests.length === 4 && fixture.clock.pending() === 1)
    await Bun.sleep(0)
    expect(fixture.admissions).toHaveLength(0)
    assertDiagnostic(fixture, 'missing-pty')
  } finally {
    await fixture.cleanup()
  }
})
