import { expect, test } from 'bun:test'
import {
  admissionRetryDelay,
  classifyAdmissionFailure,
  observationRetirement,
} from '../src/v2/exit-policy.ts'
import {
  classifyExit,
  decodeExitInfo,
  decodeExitList,
  decodeExitSnapshot,
  ExitDecodeError,
  exitNotification,
} from '../src/v2/exit-state.ts'

const registration = { ptyID: 'pty_persistent_1', sessionID: 'ses_A', notificationID: 'msg_fixed' }
const info = { id: registration.ptyID, sessionID: 'ses_A', status: 'exited', exitCode: 7 }
const input = exitNotification({ registration, exitCode: 7 })

test('decodes projected lifecycle', () => {
  expect(decodeExitInfo(info)).toEqual({
    status: 'exited',
    ptyID: info.id,
    sessionID: 'ses_A',
    exitCode: 7,
  })
  expect(decodeExitInfo({ ...info, status: 'running' }).exitCode).toBe(7)
  expect(decodeExitInfo({ ...info, exitCode: undefined }).exitCode).toBeUndefined()
  expect(decodeExitList([info])).toEqual([decodeExitInfo(info)])
  expect(decodeExitSnapshot({ info, text: 'FINAL7:case' })).toEqual({
    info: decodeExitInfo(info),
    text: 'FINAL7:case',
  })
  expect(() => decodeExitList({})).toThrow('invalid-list')
  for (const value of [null, [], {}, { info, text: 123 }]) {
    expect(() => decodeExitSnapshot(value)).toThrow('invalid-snapshot')
  }
  expect(() => decodeExitSnapshot({ text: '' })).toThrow('invalid-info')
  expect(() => decodeExitList([info, null])).toThrow('invalid-info')
})

// loom:tc LDV-182-REQ#TC-06
test('rejects malformed code', () => {
  for (const code of [null, '0', -1, 0.5, NaN, Infinity]) {
    try {
      decodeExitInfo({ ...info, exitCode: code })
      throw new Error('malformed code accepted')
    } catch (error) {
      expect(error).toBeInstanceOf(ExitDecodeError)
      expect((error as ExitDecodeError).reason).toBe('invalid-code')
    }
  }
})

for (const [name, code] of [
  ['nan-code', NaN],
  ['infinite-code', Infinity],
] as const) {
  // loom:tc LDV-182-REQ#TC-06
  test(`TC-06 ${name}`, () => {
    expect(() => decodeExitInfo({ ...info, exitCode: code })).toThrow('invalid-code')
  })
}

test('rejects non-object and empty-id info', () => {
  for (const value of [
    null,
    [],
    0,
    {},
    { ...info, id: '' },
    { ...info, sessionID: '' },
    { ...info, status: 'failed' },
  ]) {
    expect(() => decodeExitInfo(value)).toThrow('invalid-info')
  }
})

test('classifies agreeing numeric exits', () => {
  const sample = {
    registration,
    listed: decodeExitList([info]),
    snapshot: decodeExitSnapshot({ info, text: 'FINAL7:case' }),
  }
  expect(classifyExit(sample)).toEqual({ status: 'exited', exitCode: 7, text: 'FINAL7:case' })
  expect(classifyExit({ ...sample, listed: [] })).toEqual({
    status: 'incomplete',
    reason: 'missing-pty',
  })
  expect(classifyExit({ ...sample, listed: [...sample.listed, ...sample.listed] })).toEqual({
    status: 'incomplete',
    reason: 'duplicate-pty',
  })
})

test('rejects inconsistent identity/state', () => {
  const listed = decodeExitList([info])
  const snapshot = decodeExitSnapshot({ info, text: 'FINAL7:case' })
  expect(
    classifyExit({
      registration,
      listed,
      snapshot: { ...snapshot, info: { ...snapshot.info, sessionID: 'ses_B' } },
    })
  ).toEqual({ status: 'incomplete', reason: 'identity-mismatch' })
  expect(
    classifyExit({
      registration,
      listed,
      snapshot: { ...snapshot, info: { ...snapshot.info, status: 'running' } },
    })
  ).toEqual({ status: 'incomplete', reason: 'inconsistent-pair' })
})

test('formats explicit admission identity', () => {
  expect(input).toEqual({
    id: 'msg_fixed',
    sessionID: 'ses_A',
    description: 'Background PTY exited',
    delivery: 'steer',
    resume: true,
    text: '<pty_exited>\n{"ptyID":"pty_persistent_1","sessionID":"ses_A","exitCode":7,"result":"error"}\nUse pty_read to inspect retained output.\n</pty_exited>',
    metadata: {
      source: 'opencode-pty',
      kind: 'exit',
      notificationID: 'msg_fixed',
      ptyID: 'pty_persistent_1',
      sessionID: 'ses_A',
      exitCode: 7,
    },
  })
  expect(Object.isFrozen(input)).toBe(true)
  expect(Object.isFrozen(input.metadata)).toBe(true)
  expect(exitNotification({ registration, exitCode: 0 }).text).toContain('"result":"success"')
})

test('classifies raw host rejections', () => {
  expect(
    classifyAdmissionFailure({
      input,
      error: { _tag: 'Session.NotFoundError', sessionID: 'ses_A' },
    })
  ).toEqual({ status: 'session-missing' })
  expect(
    classifyAdmissionFailure({
      input,
      error: { _tag: 'Session.SyntheticConflictError', sessionID: 'ses_A', inputID: input.id },
    })
  ).toEqual({ status: 'conflict' })
  for (const error of [
    null,
    [],
    '404',
    new Error('404/409'),
    { status: 404 },
    { _tag: 'Session.NotFoundError', sessionID: 'ses_B' },
    { _tag: 'Session.SyntheticConflictError', sessionID: 'ses_B', inputID: input.id },
    { _tag: 'Session.SyntheticConflictError', sessionID: 'ses_A', inputID: 'wrong' },
    { cause: { _tag: 'Session.NotFoundError', sessionID: 'ses_A' } },
  ]) {
    expect(classifyAdmissionFailure({ input, error })).toEqual({ status: 'unconfirmed' })
  }
})

test('bounds retry delay', () => {
  expect([1, 2, 3, 4].map(admissionRetryDelay)).toEqual([1000, 2000, 4000, undefined])
  for (const attempts of [-1, 0, 0.5, NaN, Infinity])
    expect(admissionRetryDelay(attempts)).toBeUndefined()
})

test('bounds observation retirement', () => {
  expect(observationRetirement({ missingSamples: 2, incompleteSamples: 7 })).toBeUndefined()
  expect(observationRetirement({ missingSamples: 3, incompleteSamples: 8 })).toBe(
    'observation-missing-exhausted'
  )
  expect(observationRetirement({ missingSamples: 0, incompleteSamples: 8 })).toBe(
    'observation-incomplete-exhausted'
  )
})
