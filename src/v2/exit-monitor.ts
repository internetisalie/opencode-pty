import { randomUUID } from 'node:crypto'
import { observeExit } from './exit-observer.ts'
import type {
  ExitAdmissionOutcome,
  ExitDiagnosticReason,
  ExitTerminalReason,
} from './exit-policy.ts'
import {
  admissionRetryDelay,
  classifyAdmissionFailure,
  observationRetirement,
} from './exit-policy.ts'
import type { ExitClock, ExitDiagnostic, ExitEnrollment, ExitJob } from './exit-runtime.ts'
import { EXIT_POLL_MS, reportExitDiagnostic, systemExitClock } from './exit-runtime.ts'
import type { ExitSample } from './exit-state.ts'
import { exitNotification } from './exit-state.ts'
import type { NativePtyClient } from './native.ts'
import type { PtyExitAdmission, PtyExitInput } from './types.ts'

export interface ExitMonitorOptions {
  readonly client: Pick<NativePtyClient, 'list' | 'snapshot'>
  readonly synthetic: (input: PtyExitInput) => Promise<PtyExitAdmission>
  readonly clock?: ExitClock
  readonly report?: (diagnostic: ExitDiagnostic) => void
}

export class ExitMonitor {
  private active = true
  private disposal?: Promise<void>
  private readonly jobs = new Map<string, ExitJob>()
  private readonly clock: ExitClock
  private readonly report: (diagnostic: ExitDiagnostic) => void

  constructor(private readonly options: ExitMonitorOptions) {
    this.clock = options.clock ?? systemExitClock
    this.report = options.report ?? reportExitDiagnostic
  }

  register(options: { readonly ptyID: string; readonly sessionID: string }): ExitEnrollment {
    if (!this.active) return { status: 'unavailable', reason: 'disposed' }
    const key = JSON.stringify([options.sessionID, options.ptyID])
    const existing = this.jobs.get(key)
    if (existing)
      return { status: 'registered', notificationID: existing.registration.notificationID }
    const registration = Object.freeze({
      ...options,
      notificationID: `msg_pty_exit_${randomUUID()}`,
    })
    const job: ExitJob = {
      registration,
      progress: { status: 'observing' },
      missingSamples: 0,
      incompleteSamples: 0,
      admissionAttempts: 0,
      reported: new Set(),
    }
    this.jobs.set(key, job)
    this.schedule(job, 0)
    return { status: 'registered', notificationID: registration.notificationID }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    const settlement = Promise.withResolvers<void>()
    this.disposal = settlement.promise
    this.active = false
    const work: Promise<void>[] = []
    for (const job of this.jobs.values()) {
      job.cancelPoll?.()
      job.cancelDeadline?.()
      job.controller?.abort()
      if (job.work) work.push(job.work)
      if (job.progress.status === 'observing')
        this.diagnostic(job, 'disposed-registration-lost', 'dispose')
      if (job.progress.status === 'admitting')
        this.diagnostic(job, 'disposed-admission-may-have-committed', 'dispose')
    }
    Promise.allSettled(work).then((results) => {
      this.jobs.clear()
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason)
      if (errors.length)
        settlement.reject(new AggregateError(errors, 'Exit monitor cleanup failed'))
      else settlement.resolve()
    })
    return this.disposal
  }

  private schedule(job: ExitJob, delayMS: number): void {
    if (
      !this.active ||
      job.work ||
      job.cancelPoll ||
      job.progress.status === 'admitted' ||
      job.progress.status === 'retired'
    )
      return
    job.cancelPoll = this.clock.after(delayMS, () => {
      job.cancelPoll = undefined
      if (!this.active) return
      job.work = this.run(job)
        .then(() => {
          job.work = undefined
          this.reschedule(job)
        })
        .catch(() => {
          job.work = undefined
          this.workerFailed(job)
        })
    })
  }

  private reschedule(job: ExitJob): void {
    if (!this.active) return
    if (job.progress.status === 'observing') this.schedule(job, EXIT_POLL_MS)
    if (job.progress.status !== 'admitting') return
    const delay = admissionRetryDelay(job.admissionAttempts)
    if (delay === undefined) this.retire(job, 'admission-unconfirmed-exhausted', 'unconfirmed')
    else this.schedule(job, delay)
  }

  private workerFailed(job: ExitJob): void {
    if (this.active)
      this.retire(job, 'worker-failed', job.admissionAttempts > 0 ? 'unconfirmed' : 'not-attempted')
  }

  private async run(job: ExitJob): Promise<void> {
    if (!this.active) return
    try {
      if (job.progress.status === 'observing') {
        const sample = await this.observe(job)
        if (!this.active) return
        this.applySample(job, sample)
      }
      if (job.progress.status === 'admitting') await this.admit(job)
    } catch {
      this.workerFailed(job)
    }
  }

  private applySample(job: ExitJob, sample: ExitSample): void {
    if (sample.status === 'exited') {
      job.progress = {
        status: 'admitting',
        input: exitNotification({ registration: job.registration, exitCode: sample.exitCode }),
      }
      return
    }
    if (sample.status === 'running') {
      job.missingSamples = 0
      job.incompleteSamples = 0
      return
    }
    this.diagnostic(job, sample.reason)
    job.incompleteSamples++
    job.missingSamples = sample.reason === 'missing-pty' ? job.missingSamples + 1 : 0
    const reason = observationRetirement(job)
    if (reason) this.retire(job, reason, 'not-attempted')
  }

  private observe(job: ExitJob): Promise<ExitSample> {
    return observeExit({
      client: this.options.client,
      job,
      clock: this.clock,
      active: () => this.active,
    })
  }

  private async admit(job: ExitJob): Promise<void> {
    if (!this.active || job.progress.status !== 'admitting') return
    const input = job.progress.input
    job.admissionAttempts++
    try {
      const acknowledgment: unknown = await this.options.synthetic(input)
      if (!this.active) return
      if (
        typeof acknowledgment !== 'object' ||
        acknowledgment === null ||
        !('id' in acknowledgment) ||
        acknowledgment.id !== input.id ||
        !('sessionID' in acknowledgment) ||
        acknowledgment.sessionID !== input.sessionID ||
        !('type' in acknowledgment) ||
        acknowledgment.type !== 'synthetic'
      ) {
        this.retire(job, 'invalid-admission', 'unconfirmed')
        return
      }
      job.progress = { status: 'admitted' }
    } catch (error) {
      if (!this.active) return
      this.admissionFailed(job, classifyAdmissionFailure({ error, input }).status)
    }
  }

  private admissionFailed(
    job: ExitJob,
    status: 'session-missing' | 'conflict' | 'unconfirmed'
  ): void {
    if (status === 'session-missing') this.retire(job, 'admission-session-missing', 'unconfirmed')
    else if (status === 'conflict')
      this.retire(
        job,
        'admission-conflict',
        job.admissionAttempts === 1 ? 'rejected' : 'unconfirmed'
      )
    else this.diagnostic(job, 'admission-unconfirmed')
  }

  private diagnostic(
    job: ExitJob,
    reason: ExitDiagnosticReason,
    context: 'active' | 'dispose' = 'active'
  ): void {
    if (!this.active && context === 'active') return
    if (job.reported.has(reason)) return
    job.reported.add(reason)
    const admission =
      job.progress.status === 'retired'
        ? job.progress.admission
        : job.admissionAttempts > 0
          ? 'unconfirmed'
          : 'not-attempted'
    this.report({ ...job.registration, reason, admission })
  }

  private retire(job: ExitJob, reason: ExitTerminalReason, admission: ExitAdmissionOutcome): void {
    job.cancelPoll?.()
    job.cancelDeadline?.()
    job.cancelPoll = undefined
    job.cancelDeadline = undefined
    job.progress = { status: 'retired', reason, admission }
    this.diagnostic(job, reason)
  }
}
