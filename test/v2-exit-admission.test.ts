import { expect, test } from 'bun:test'
import type { PtyExitAdmission, PtyExitInput } from '../src/v2/types.ts'
import { eventually } from './lib/v2-exit-fixture.ts'
import { acknowledgment, assertDiagnostic, exitFixture, spawn } from './lib/v2-exit-script.ts'

const knownFailures = [
  {
    name: 'session missing',
    error: (input: PtyExitInput): unknown => ({
      _tag: 'Session.NotFoundError',
      sessionID: input.sessionID,
    }),
    reason: 'admission-session-missing' as const,
    admission: 'unconfirmed' as const,
  },
  {
    name: 'conflict',
    error: (input: PtyExitInput): unknown => ({
      _tag: 'Session.SyntheticConflictError',
      sessionID: input.sessionID,
      inputID: input.id,
    }),
    reason: 'admission-conflict' as const,
    admission: 'rejected' as const,
  },
]
for (const entry of knownFailures) {
  // loom:tc LDV-182-REQ#TC-18
  test(`TC-18 ${entry.name} retires`, async () => {
    const fixture = await exitFixture({
      synthetic: async (input) => {
        throw entry.error(input)
      },
    })
    try {
      await spawn(fixture)
      fixture.clock.advance(0)
      await eventually(() => fixture.admissions.length === 1)
      await Bun.sleep(0)
      expect(fixture.clock.pending()).toBe(0)
      assertDiagnostic(fixture, entry.reason, entry.admission)
      fixture.clock.advance(60000)
      expect(fixture.admissions).toHaveLength(1)
      await fixture.cleanup()
      expect(fixture.diagnostics).toHaveLength(1)
    } finally {
      await fixture.cleanup()
    }
  })
}

const unknownFailures = [
  {
    name: 'wrong missing session',
    error: (): unknown => ({ _tag: 'Session.NotFoundError', sessionID: 'ses_B' }),
  },
  {
    name: 'wrong conflict session',
    error: (input: PtyExitInput): unknown => ({
      _tag: 'Session.SyntheticConflictError',
      sessionID: 'ses_B',
      inputID: input.id,
    }),
  },
  {
    name: 'wrong conflict input',
    error: (): unknown => ({
      _tag: 'Session.SyntheticConflictError',
      sessionID: 'ses_A',
      inputID: 'wrong',
    }),
  },
  { name: 'HTTP message', error: (): unknown => new Error('HTTP 404/409') },
]
for (const entry of unknownFailures) {
  // loom:tc LDV-182-REQ#TC-18
  test(`TC-18 unknown ${entry.name}`, async () => {
    const fixture = await exitFixture({
      synthetic: async (input) => {
        throw entry.error(input)
      },
    })
    try {
      await spawn(fixture)
      fixture.clock.advance(0)
      await eventually(() => fixture.admissions.length === 1 && fixture.clock.pending() === 1)
      assertDiagnostic(fixture, 'admission-unconfirmed', 'unconfirmed')
      fixture.clock.advance(1000)
      await eventually(() => fixture.admissions.length === 2)
      expect(fixture.admissions[1]).toBe(fixture.admissions[0])
    } finally {
      await fixture.cleanup()
    }
  })
}

// loom:tc LDV-182-REQ#TC-18
test('TC-18 prior unknown then conflict', async () => {
  const fixture = await exitFixture({
    synthetic: async (input) => {
      if (fixture.admissions.length === 1) throw new Error('unknown')
      throw {
        _tag: 'Session.SyntheticConflictError',
        sessionID: input.sessionID,
        inputID: input.id,
      }
    },
  })
  try {
    await spawn(fixture)
    fixture.clock.advance(0)
    await eventually(() => fixture.admissions.length === 1 && fixture.clock.pending() === 1)
    fixture.clock.advance(1000)
    await eventually(() => fixture.admissions.length === 2 && fixture.clock.pending() === 0)
    assertDiagnostic(fixture, 'admission-conflict', 'unconfirmed')
  } finally {
    await fixture.cleanup()
  }
})

for (const field of ['id', 'sessionID', 'type'] as const) {
  // loom:tc LDV-182-REQ#TC-18
  test(`TC-18 invalid acknowledgment retires ${field}`, async () => {
    const fixture = await exitFixture({
      synthetic: async (input) =>
        ({ ...acknowledgment(input), [field]: 'wrong' }) as PtyExitAdmission,
    })
    try {
      await spawn(fixture)
      fixture.clock.advance(0)
      await eventually(() => fixture.admissions.length === 1)
      await Bun.sleep(0)
      expect(fixture.clock.pending()).toBe(0)
      assertDiagnostic(fixture, 'invalid-admission', 'unconfirmed')
      fixture.clock.advance(1000)
      expect(fixture.admissions).toHaveLength(1)
    } finally {
      await fixture.cleanup()
    }
  })
}
