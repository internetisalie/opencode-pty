import type { ExitObservationReason } from './exit-state.ts'
import type { PtyExitInput } from './types.ts'

export type ExitAdmissionOutcome = 'not-attempted' | 'rejected' | 'unconfirmed' | 'confirmed'
export type ExitTerminalReason =
  | 'observation-missing-exhausted'
  | 'observation-incomplete-exhausted'
  | 'admission-session-missing'
  | 'admission-conflict'
  | 'admission-unconfirmed-exhausted'
  | 'invalid-admission'
  | 'worker-failed'
  | 'unregistered'
export type ExitDiagnosticReason =
  | ExitObservationReason
  | ExitTerminalReason
  | 'admission-unconfirmed'
  | 'admission-slow'
  | 'exit-inferred'
  | 'admitted'
  | 'disposed-registration-lost'
  | 'disposed-admission-may-have-committed'
export type ExitAdmissionFailure =
  | { readonly status: 'session-missing' }
  | { readonly status: 'conflict' }
  | { readonly status: 'unconfirmed' }

export const EXIT_MISSING_LIMIT: number = 3
export const EXIT_INCOMPLETE_LIMIT: number = 8
export const EXIT_ADMISSION_LIMIT: number = 4
export const EXIT_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1000, 2000, 4000])

export function classifyAdmissionFailure(options: {
  readonly error: unknown
  readonly input: PtyExitInput
}): ExitAdmissionFailure {
  const { error, input } = options
  if (typeof error !== 'object' || error === null || Array.isArray(error))
    return { status: 'unconfirmed' }
  if (!('sessionID' in error) || error.sessionID !== input.sessionID || !('_tag' in error)) {
    return { status: 'unconfirmed' }
  }
  if (error._tag === 'Session.NotFoundError') return { status: 'session-missing' }
  if (
    error._tag === 'Session.SyntheticConflictError' &&
    'inputID' in error &&
    error.inputID === input.id
  ) {
    return { status: 'conflict' }
  }
  return { status: 'unconfirmed' }
}

export function admissionRetryDelay(attempts: number): number | undefined {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts >= EXIT_ADMISSION_LIMIT)
    return undefined
  return EXIT_RETRY_DELAYS_MS[attempts - 1]
}

export function observationRetirement(options: {
  readonly missingSamples: number
  readonly incompleteSamples: number
}): 'observation-missing-exhausted' | 'observation-incomplete-exhausted' | undefined {
  if (options.missingSamples >= EXIT_MISSING_LIMIT) return 'observation-missing-exhausted'
  if (options.incompleteSamples >= EXIT_INCOMPLETE_LIMIT) return 'observation-incomplete-exhausted'
  return undefined
}
