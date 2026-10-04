import type { PtyExitInput } from './types.ts'

export interface ExitRegistration {
  readonly ptyID: string
  readonly sessionID: string
  readonly notificationID: string
}

export type ExitObservationReason =
  | 'missing-pty'
  | 'duplicate-pty'
  | 'identity-mismatch'
  | 'inconsistent-pair'
  | 'unavailable-code'
  | 'inconsistent-code'
  | 'invalid-info'
  | 'invalid-list'
  | 'invalid-snapshot'
  | 'invalid-code'
  | 'read-failed'
  | 'read-deadline'

export type PtyExitState =
  | {
      readonly status: 'running'
      readonly ptyID: string
      readonly sessionID: string
      readonly exitCode: number | undefined
    }
  | {
      readonly status: 'exited'
      readonly ptyID: string
      readonly sessionID: string
      readonly exitCode: number | undefined
    }

export type ExitSample =
  | { readonly status: 'running' }
  | { readonly status: 'incomplete'; readonly reason: ExitObservationReason }
  | { readonly status: 'exited'; readonly exitCode: number; readonly text: string }

type DecodeReason = Extract<
  ExitObservationReason,
  'invalid-info' | 'invalid-list' | 'invalid-snapshot' | 'invalid-code'
>

export class ExitDecodeError extends Error {
  readonly reason: DecodeReason

  constructor(reason: DecodeReason) {
    super(reason)
    this.reason = reason
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ExitDecodeError('invalid-info')
  }
  return value as Record<string, unknown>
}

function exitCode(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new ExitDecodeError('invalid-code')
  }
  return value
}

export function decodeExitInfo(value: unknown): PtyExitState {
  const info = record(value)
  if (
    typeof info.id !== 'string' ||
    !info.id ||
    typeof info.sessionID !== 'string' ||
    !info.sessionID ||
    (info.status !== 'running' && info.status !== 'exited')
  ) {
    throw new ExitDecodeError('invalid-info')
  }
  return Object.freeze({
    status: info.status,
    ptyID: info.id,
    sessionID: info.sessionID,
    exitCode: info.exitCode === undefined ? undefined : exitCode(info.exitCode),
  })
}

export function decodeExitList(value: unknown): readonly PtyExitState[] {
  if (!Array.isArray(value)) throw new ExitDecodeError('invalid-list')
  return Object.freeze(value.map(decodeExitInfo))
}

export function decodeExitSnapshot(value: unknown): {
  readonly info: PtyExitState
  readonly text: string
} {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('text' in value) ||
    typeof value.text !== 'string'
  ) {
    throw new ExitDecodeError('invalid-snapshot')
  }
  return Object.freeze({
    info: decodeExitInfo('info' in value ? value.info : undefined),
    text: value.text,
  })
}

export function classifyExit(options: {
  readonly registration: ExitRegistration
  readonly listed: readonly PtyExitState[]
  readonly snapshot: { readonly info: PtyExitState; readonly text: string }
}): ExitSample {
  const { registration, listed, snapshot } = options
  const targets = listed.filter((info) => info.ptyID === registration.ptyID)
  const target = targets[0]
  if (!target) return { status: 'incomplete', reason: 'missing-pty' }
  if (targets.length !== 1) return { status: 'incomplete', reason: 'duplicate-pty' }
  if (
    target.sessionID !== registration.sessionID ||
    snapshot.info.sessionID !== registration.sessionID ||
    snapshot.info.ptyID !== registration.ptyID
  ) {
    return { status: 'incomplete', reason: 'identity-mismatch' }
  }
  if (target.status !== snapshot.info.status)
    return { status: 'incomplete', reason: 'inconsistent-pair' }
  if (target.status === 'running') return { status: 'running' }
  if (target.exitCode === undefined || snapshot.info.exitCode === undefined) {
    return { status: 'incomplete', reason: 'unavailable-code' }
  }
  if (target.exitCode !== snapshot.info.exitCode)
    return { status: 'incomplete', reason: 'inconsistent-code' }
  return { status: 'exited', exitCode: target.exitCode, text: snapshot.text }
}

export function exitNotification(options: {
  readonly registration: ExitRegistration
  readonly exitCode: number
}): PtyExitInput {
  const { registration, exitCode: code } = options
  const { ptyID, sessionID, notificationID } = registration
  const result = code === 0 ? 'success' : 'error'
  return Object.freeze({
    sessionID,
    id: notificationID,
    text: `<pty_exited>\n${JSON.stringify({ ptyID, sessionID, exitCode: code, result })}\nUse pty_read to inspect retained output.\n</pty_exited>`,
    description: 'Background PTY exited',
    metadata: Object.freeze({
      source: 'opencode-pty',
      kind: 'exit',
      notificationID,
      ptyID,
      sessionID,
      exitCode: code,
    }),
    delivery: 'steer',
    resume: true,
  })
}
