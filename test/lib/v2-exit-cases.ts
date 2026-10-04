import type { ExitObservationReason } from '../../src/v2/exit-state.ts'
import { projected } from './v2-exit-script.ts'

interface NegativeCase {
  readonly name: string
  readonly listed: unknown
  readonly snapshot?: { readonly info: unknown; readonly text: unknown }
  readonly reason?: ExitObservationReason
  readonly readFailure?: 'reject' | 'eof' | 'snapshot404'
}

const P = 'pty_persistent_1'
const Q = 'pty_persistent_2'
const A = 'ses_A'
const B = 'ses_B'
function info(
  id: string,
  session: string,
  lifecycle: { status: 'running' | 'exited'; code?: unknown }
): Record<string, unknown> {
  return { ...projected(lifecycle.status, lifecycle.code), id, sessionID: session }
}
const exited7 = (): Record<string, unknown> => info(P, A, { status: 'exited', code: 7 })
const snap = (value: unknown, text: unknown = 'FINAL7:case'): { info: unknown; text: unknown } => ({
  info: value,
  text,
})

export const negativeCases: readonly NegativeCase[] = [
  {
    name: 'running-output',
    listed: [info(P, A, { status: 'running' })],
    snapshot: snap(info(P, A, { status: 'running' }), 'exit 0'),
  },
  {
    name: 'running-child7',
    listed: [{ ...info(P, A, { status: 'running' }), foregroundProcess: 'child' }],
    snapshot: snap(info(P, A, { status: 'running' }), 'CHILD:7'),
  },
  {
    name: 'running-numeric',
    listed: [info(P, A, { status: 'running', code: 7 })],
    snapshot: snap(info(P, A, { status: 'running', code: 7 })),
  },
  {
    name: 'omitted-code',
    listed: [info(P, A, { status: 'exited' })],
    snapshot: snap(info(P, A, { status: 'exited' })),
    reason: 'unavailable-code',
  },
  {
    name: 'null-code',
    listed: [info(P, A, { status: 'exited', code: null })],
    reason: 'invalid-code',
  },
  {
    name: 'snapshot-null-code',
    listed: [info(P, A, { status: 'exited', code: 0 })],
    snapshot: snap(info(P, A, { status: 'exited', code: null })),
    reason: 'invalid-code',
  },
  {
    name: 'string-code',
    listed: [info(P, A, { status: 'exited', code: '0' })],
    reason: 'invalid-code',
  },
  {
    name: 'fractional-code',
    listed: [info(P, A, { status: 'exited', code: 0.5 })],
    reason: 'invalid-code',
  },
  {
    name: 'negative-code',
    listed: [info(P, A, { status: 'exited', code: -1 })],
    reason: 'invalid-code',
  },
  { name: 'missing-pty', listed: [], reason: 'missing-pty' },
  { name: 'duplicate-pty', listed: [exited7(), exited7()], reason: 'duplicate-pty' },
  { name: 'snapshot404', listed: [exited7()], readFailure: 'snapshot404', reason: 'read-failed' },
  {
    name: 'wrong-session',
    listed: [info(P, B, { status: 'exited', code: 7 })],
    snapshot: snap(exited7()),
    reason: 'identity-mismatch',
  },
  {
    name: 'wrong-snapshot-session',
    listed: [exited7()],
    snapshot: snap(info(P, B, { status: 'exited', code: 7 })),
    reason: 'identity-mismatch',
  },
  {
    name: 'wrong-snapshot-id',
    listed: [exited7()],
    snapshot: snap(info(Q, A, { status: 'exited', code: 7 })),
    reason: 'identity-mismatch',
  },
  {
    name: 'code-disagreement',
    listed: [info(P, A, { status: 'exited', code: 0 })],
    snapshot: snap(exited7()),
    reason: 'inconsistent-code',
  },
  {
    name: 'state-disagreement',
    listed: [exited7()],
    snapshot: snap(info(P, A, { status: 'running', code: 7 })),
    reason: 'inconsistent-pair',
  },
  { name: 'failed-read', listed: undefined, readFailure: 'reject', reason: 'read-failed' },
  { name: 'eof-body', listed: undefined, readFailure: 'eof', reason: 'read-failed' },
  { name: 'malformed-list', listed: {}, reason: 'invalid-list' },
  {
    name: 'malformed-snapshot',
    listed: [exited7()],
    snapshot: snap(exited7(), 123),
    reason: 'invalid-snapshot',
  },
  { name: 'invalid-info-null', listed: [null], reason: 'invalid-info' },
  { name: 'invalid-info-id', listed: [{ ...exited7(), id: '' }], reason: 'invalid-info' },
]
