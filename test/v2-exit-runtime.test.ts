import { expect, spyOn, test } from 'bun:test'
import { reportExitDiagnostic, systemExitClock } from '../src/v2/exit-runtime.ts'

test('system clock owns scheduled and canceled callbacks', async () => {
  let canceled = false
  const cancel = systemExitClock.after(0, () => {
    canceled = true
  })
  cancel()
  await new Promise<void>((resolve) => {
    systemExitClock.after(1, resolve)
  })
  expect(canceled).toBe(false)
})

test('diagnostic boundary emits only fixed IDs reason and outcome', () => {
  const error = spyOn(console, 'error').mockImplementation(() => {})
  const diagnostic = {
    ptyID: 'pty_persistent_1',
    sessionID: 'ses_A',
    notificationID: 'msg_fixed',
    reason: 'worker-failed' as const,
    admission: 'not-attempted' as const,
  }
  try {
    reportExitDiagnostic(diagnostic)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      '[opencode-pty exit]',
      '{"ptyID":"pty_persistent_1","sessionID":"ses_A","notificationID":"msg_fixed","reason":"worker-failed","admission":"not-attempted"}'
    )
  } finally {
    error.mockRestore()
  }
})
