import { expect, test } from 'bun:test'
import type { PtyExitAdmission } from '../src/v2/types.ts'
import { deferred, eventually } from './lib/v2-exit-fixture.ts'
import { acknowledgment, assertDiagnostic, exitFixture, spawn } from './lib/v2-exit-script.ts'

for (const outcome of ['resolve', 'reject'] as const) {
  // loom:tc LDV-182-REQ#TC-12
  test(`TC-12 cleanup drains unabortable admission ${outcome}`, async () => {
    const held = deferred<PtyExitAdmission>()
    const fixture = await exitFixture({ synthetic: () => held.promise })
    let completed = false
    try {
      await spawn(fixture)
      fixture.clock.advance(0)
      await eventually(() => fixture.admissions.length === 1)
      const pending = fixture.cleanup()
      pending.then(() => {
        completed = true
      })
      expect(fixture.cleanup()).toBe(pending)
      await Bun.sleep(0)
      expect(completed).toBe(false)
      expect(fixture.disposed()).toBe(1)
      expect(fixture.clock.pending()).toBe(0)
      if (outcome === 'resolve') held.resolve(acknowledgment(fixture.admissions[0]!))
      else held.reject(new Error('late rejection'))
      await pending
      expect(completed).toBe(true)
      fixture.clock.advance(60000)
      expect(fixture.admissions).toHaveLength(1)
      expect(fixture.diagnostics.map((entry) => entry.reason)).toEqual([
        'disposed-admission-may-have-committed',
      ])
    } finally {
      held.resolve(acknowledgment(fixture.admissions[0]!))
      await fixture.cleanup()
    }
  })
}

// loom:tc LDV-182-REQ#TC-12
test('TC-12 controlled owner closure awaits admission', async () => {
  const held = deferred<PtyExitAdmission>()
  const fixture = await exitFixture({ synthetic: () => held.promise })
  try {
    await spawn(fixture)
    fixture.clock.advance(0)
    await eventually(() => fixture.admissions.length === 1)
    const close = fixture.closeOwner()
    expect(fixture.closeOwner()).toBe(close)
    await Bun.sleep(0)
    expect(fixture.ownerClosed()).toBe(false)
    expect(fixture.disposed()).toBe(1)
    held.resolve(acknowledgment(fixture.admissions[0]!))
    await close
    expect(fixture.ownerClosed()).toBe(true)
  } finally {
    held.resolve(acknowledgment(fixture.admissions[0]!))
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-12
test('TC-12 disposal reports pending admission', async () => {
  const held = deferred<PtyExitAdmission>()
  const fixture = await exitFixture({ synthetic: () => held.promise })
  try {
    await spawn(fixture)
    fixture.clock.advance(0)
    await eventually(() => fixture.admissions.length === 1)
    const pending = fixture.cleanup()
    expect(fixture.cleanup()).toBe(pending)
    assertDiagnostic(fixture, 'disposed-admission-may-have-committed', 'unconfirmed')
    expect(fixture.clock.pending()).toBe(0)
    held.resolve(acknowledgment(fixture.admissions[0]!))
    await pending
    expect(fixture.diagnostics).toHaveLength(1)
    fixture.clock.advance(60000)
    expect(fixture.admissions).toHaveLength(1)
  } finally {
    held.resolve(acknowledgment(fixture.admissions[0]!))
    await fixture.cleanup()
  }
})
