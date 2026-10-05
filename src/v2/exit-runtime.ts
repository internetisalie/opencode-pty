import type {
  ExitAdmissionOutcome,
  ExitDiagnosticReason,
  ExitTerminalReason,
} from './exit-policy.ts'
import type { ExitRegistration } from './exit-state.ts'
import type { PtyExitInput } from './types.ts'

export interface ExitClock {
  readonly after: (delayMS: number, callback: () => void) => () => void
}

export interface ExitDiagnostic {
  readonly ptyID: string
  readonly sessionID: string
  readonly notificationID: string
  readonly reason: ExitDiagnosticReason
  readonly admission: ExitAdmissionOutcome
}

export type ExitEnrollment =
  | { readonly status: 'registered'; readonly notificationID: string }
  | { readonly status: 'unavailable'; readonly reason: 'disposed' }

export type ExitProgress =
  | { readonly status: 'observing' }
  | { readonly status: 'admitting'; readonly input: PtyExitInput }
  | { readonly status: 'admitted' }
  | {
      readonly status: 'retired'
      readonly reason: ExitTerminalReason
      readonly admission: ExitAdmissionOutcome
    }

export interface ExitJob {
  readonly registration: ExitRegistration
  readonly notifyOnExit: boolean
  notifyOnOutput: boolean
  outputTail: number
  sawRunning: boolean
  outputDiagnostic?: {
    readonly notificationID: string
    readonly reported: Set<ExitDiagnosticReason>
  }
  progress: ExitProgress
  cancelPoll?: () => void
  cancelDeadline?: () => void
  controller?: AbortController
  work?: Promise<void>
  missingSamples: number
  incompleteSamples: number
  admissionAttempts: number
  readonly reported: Set<ExitDiagnosticReason>
}

export const EXIT_POLL_MS: number = 1000
export const EXIT_READ_MS: number = 5000
export const EXIT_ADMIT_WARN_MS: number = 10000

export const systemExitClock: ExitClock = {
  after(delayMS: number, callback: () => void): () => void {
    const timer = setTimeout(callback, delayMS)
    return () => clearTimeout(timer)
  },
}

export function reportExitDiagnostic(diagnostic: ExitDiagnostic): void {
  console.error('[opencode-pty exit]', JSON.stringify(diagnostic))
}
