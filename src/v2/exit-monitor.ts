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
import {
  EXIT_ADMIT_WARN_MS,
  EXIT_POLL_MS,
  reportExitDiagnostic,
  systemExitClock,
} from './exit-runtime.ts'
import type { ExitSample } from './exit-state.ts'
import { exitNotification, outputNotification, watchEndedNotification } from './exit-state.ts'
import type { NativePtyClient } from './native.ts'
import type { RegistrationStore, StoredRegistration } from './registration-store.ts'
import { registrationKey } from './registration-store.ts'
import type { PtyExitAdmission, PtyExitInput } from './types.ts'

export interface ExitMonitorOptions {
  readonly client: Pick<NativePtyClient, 'list' | 'snapshot'>
  readonly synthetic: (input: PtyExitInput) => Promise<PtyExitAdmission>
  readonly clock?: ExitClock
  readonly report?: (diagnostic: ExitDiagnostic) => void
  /** Keeps watches across a server restart; the monitor adopts the stored ones once, when it starts. */
  readonly store?: RegistrationStore
  /** Drops a watch from memory once its notice is delivered; for a monitor that lives as long as the process. */
  readonly pruneSettled?: boolean
}

export class ExitMonitor {
  private active = true
  private disposal?: Promise<void>
  private readonly jobs = new Map<string, ExitJob>()
  private readonly clock: ExitClock
  private readonly report: (diagnostic: ExitDiagnostic) => void
  private readonly saved = new Map<string, string>()
  private storeReported = false

  constructor(private readonly options: ExitMonitorOptions) {
    this.clock = options.clock ?? systemExitClock
    this.report = options.report ?? reportExitDiagnostic
  }

  register(options: {
    readonly ptyID: string
    readonly sessionID: string
    readonly notifyOnExit?: boolean
    readonly notifyOnOutput?: boolean
    /** Replaces a watch that retired, which is how pty_watch restarts one; spawn keeps retirement final. */
    readonly restart?: boolean
  }): ExitEnrollment {
    if (!this.active) return { status: 'unavailable', reason: 'disposed' }
    const key = JSON.stringify([options.sessionID, options.ptyID])
    const existing = this.jobs.get(key)
    if (existing && isLive(existing)) {
      // Asking for output notices on a terminal already watched for exit adds them without a second watch.
      if (options.notifyOnOutput === true) existing.notifyOnOutput = true
      if (options.notifyOnExit === true) existing.notifyOnExit = true
      this.persist()
      return enrolled(existing)
    }
    if (existing && options.restart === true && existing.progress.status === 'retired') {
      this.jobs.delete(key)
    } else if (existing) {
      return enrolled(existing)
    }
    const registration = Object.freeze({
      ptyID: options.ptyID,
      sessionID: options.sessionID,
      notificationID: `msg_pty_exit_${randomUUID()}`,
    })
    const job: ExitJob = {
      registration,
      notifyOnExit: options.notifyOnExit !== false,
      notifyOnOutput: options.notifyOnOutput === true,
      outputTail: 0,
      sawRunning: false,
      progress: { status: 'observing' },
      missingSamples: 0,
      incompleteSamples: 0,
      admissionAttempts: 0,
      reported: new Set(),
    }
    this.jobs.set(key, job)
    this.schedule(job, 0)
    this.persist()
    return enrolled(job)
  }

  /**
   * Takes over the watches stored by a previous process. Called once, when the monitor starts: a terminal
   * outlives the server that spawned it, so its watch must too.
   */
  adopt(): number {
    const store = this.options.store
    if (!this.active || !store) return 0
    let records: StoredRegistration[]
    try {
      records = store.load()
    } catch {
      this.storeFailed()
      return 0
    }
    let adopted = 0
    for (const record of records) {
      const key = registrationKey(record.sessionID, record.ptyID)
      if (this.jobs.has(key)) continue
      const job: ExitJob = {
        registration: Object.freeze({
          ptyID: record.ptyID,
          sessionID: record.sessionID,
          notificationID: record.notificationID,
        }),
        notifyOnExit: record.notifyOnExit,
        notifyOnOutput: record.notifyOnOutput,
        outputTail: record.outputTail,
        // A stored watch was running when it was saved, so a terminal that has since left the list exited.
        sawRunning: true,
        progress: { status: 'observing' },
        missingSamples: 0,
        incompleteSamples: 0,
        admissionAttempts: 0,
        reported: new Set(),
      }
      this.jobs.set(key, job)
      this.saved.set(key, JSON.stringify(record))
      this.schedule(job, 0)
      this.diagnostic(job, 'adopted')
      adopted++
    }
    return adopted
  }

  /** Stops watching a terminal the caller removed itself, so its own removal is not reported as an exit. */
  unregister(options: { readonly ptyID: string; readonly sessionID: string }): void {
    const key = JSON.stringify([options.sessionID, options.ptyID])
    const job = this.jobs.get(key)
    if (!job) return
    this.jobs.delete(key)
    job.cancelPoll?.()
    job.cancelDeadline?.()
    job.controller?.abort()
    job.progress = { status: 'retired', reason: 'unregistered', admission: 'not-attempted' }
    this.persist()
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
    this.persist()
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
        if (!this.active || job.progress.status !== 'observing') return
        this.applySample(job, sample)
      }
      if (job.progress.status === 'admitting') await this.admit(job)
    } catch {
      this.workerFailed(job)
    }
  }

  private applySample(job: ExitJob, sample: ExitSample): void {
    if (sample.status === 'exited') {
      job.progress = !job.notifyOnExit
        ? { status: 'admitted' }
        : {
            status: 'admitting',
            input: exitNotification({ registration: job.registration, exitCode: sample.exitCode }),
          }
      return
    }
    if (sample.status === 'running') {
      job.sawRunning = true
      job.missingSamples = 0
      job.incompleteSamples = 0
      if (sample.reason) this.diagnostic(job, sample.reason, 'output')
      this.applyOutput(job, sample.outputTail)
      return
    }
    this.diagnostic(job, sample.reason)
    job.incompleteSamples++
    job.missingSamples = sample.reason === 'missing-pty' ? job.missingSamples + 1 : 0
    const reason = observationRetirement(job)
    if (reason === 'observation-missing-exhausted' && job.sawRunning && job.notifyOnExit) {
      // The host removes an exited terminal from the list once a viewer is attached, so a terminal seen
      // running and then absent has exited; its code is no longer readable.
      this.diagnostic(job, 'exit-inferred')
      job.progress = {
        status: 'admitting',
        input: exitNotification({ registration: job.registration, exitCode: undefined }),
      }
    } else if (reason) this.retire(job, reason, 'not-attempted')
  }

  private applyOutput(job: ExitJob, tail: number | undefined): void {
    if (!job.notifyOnOutput || tail === undefined || tail <= job.outputTail) return
    const notificationID = `msg_pty_output_${randomUUID()}`
    job.outputDiagnostic = { notificationID, reported: new Set() }
    job.progress = {
      status: 'admitting',
      input: outputNotification({
        registration: job.registration,
        outputTail: tail,
        notificationID,
      }),
    }
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
    // The host call is awaited without a bound by design (one admission at a time per job). A call that
    // never settles leaves the job in `admitting` and would otherwise be silent, so name it once.
    job.cancelDeadline = this.clock.after(EXIT_ADMIT_WARN_MS, () => {
      job.cancelDeadline = undefined
      this.diagnostic(job, 'admission-slow')
    })
    try {
      const acknowledgment: unknown = await this.options.synthetic(input)
      job.cancelDeadline?.()
      job.cancelDeadline = undefined
      // The watch may have been unregistered or retired while the host was answering.
      if (!this.active || job.progress.status !== 'admitting') return
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
      this.report({
        ...job.registration,
        notificationID: input.id,
        reason: 'admitted',
        admission: 'confirmed',
      })
      if (input.metadata.kind === 'output') {
        job.outputTail = Number(input.metadata.outputTail)
        job.outputDiagnostic = undefined
        job.admissionAttempts = 0
        job.progress = { status: 'observing' }
      } else job.progress = { status: 'admitted' }
    } catch (error) {
      job.cancelDeadline?.()
      job.cancelDeadline = undefined
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
    context: 'active' | 'dispose' | 'output' = 'active'
  ): void {
    if (!this.active && context !== 'dispose') return
    const output =
      context === 'output' ||
      (job.progress.status === 'admitting' && job.progress.input.metadata.kind === 'output')
    if (output && !job.outputDiagnostic)
      job.outputDiagnostic = {
        notificationID: `msg_pty_output_${randomUUID()}`,
        reported: new Set(),
      }
    const target =
      output && job.outputDiagnostic
        ? job.outputDiagnostic
        : { notificationID: job.registration.notificationID, reported: job.reported }
    if (target.reported.has(reason)) return
    target.reported.add(reason)
    const admission =
      job.progress.status === 'retired'
        ? job.progress.admission
        : job.admissionAttempts > 0
          ? 'unconfirmed'
          : 'not-attempted'
    this.report({ ...job.registration, notificationID: target.notificationID, reason, admission })
  }

  private retire(job: ExitJob, reason: ExitTerminalReason, admission: ExitAdmissionOutcome): void {
    const output =
      job.progress.status === 'admitting' && job.progress.input.metadata.kind === 'output'
    const continueExit = output && job.notifyOnExit
    job.cancelPoll?.()
    job.cancelDeadline?.()
    job.cancelPoll = undefined
    job.cancelDeadline = undefined
    job.progress = { status: 'retired', reason, admission }
    this.diagnostic(job, reason, output ? 'output' : 'active')
    this.announceEnd(job, reason)
    if (continueExit) {
      job.notifyOnOutput = false
      job.admissionAttempts = 0
      job.progress = { status: 'observing' }
      this.schedule(job, EXIT_POLL_MS)
    }
    this.persist()
  }

  /** Best effort: the session learns its watch ended when the cause was observation, not admission. */
  private announceEnd(job: ExitJob, reason: ExitTerminalReason): void {
    // A retirement caused by the admission path failing cannot be announced through that path.
    if (
      reason !== 'observation-missing-exhausted' &&
      reason !== 'observation-incomplete-exhausted' &&
      reason !== 'worker-failed'
    )
      return
    const input = watchEndedNotification({
      registration: job.registration,
      reason,
      notificationID: `msg_pty_watch_ended_${randomUUID()}`,
    })
    this.options.synthetic(input).catch(() => {
      if (this.active) this.diagnostic(job, 'watch-end-unconfirmed')
    })
  }

  /** Writes the live watches to the store, touching it only when something changed. */
  private persist(): void {
    const store = this.options.store
    if (!this.active || !store) return
    const live = new Map<string, StoredRegistration>()
    for (const [key, job] of this.jobs) {
      if (this.options.pruneSettled && job.progress.status === 'admitted') {
        this.jobs.delete(key)
        continue
      }
      if (!isLive(job)) continue
      live.set(key, {
        ptyID: job.registration.ptyID,
        sessionID: job.registration.sessionID,
        notificationID: job.registration.notificationID,
        notifyOnExit: job.notifyOnExit,
        notifyOnOutput: job.notifyOnOutput,
        outputTail: job.outputTail,
      })
    }
    const changed = [...live].some(
      ([key, record]) => this.saved.get(key) !== JSON.stringify(record)
    )
    const removals = [...this.saved.keys()].filter((key) => !live.has(key))
    if (!changed && removals.length === 0) return
    // Rewrite every live record, not only the changed ones, so a file another writer damaged is repaired.
    const upserts = [...live]
    try {
      store.apply(
        upserts.map(([, record]) => record),
        removals
      )
    } catch {
      this.storeFailed()
      return
    }
    for (const key of removals) {
      this.saved.delete(key)
    }
    for (const [key, record] of upserts) this.saved.set(key, JSON.stringify(record))
  }

  private storeFailed(): void {
    if (this.storeReported) return
    this.storeReported = true
    const job = this.jobs.values().next().value
    if (job) this.diagnostic(job, 'registration-store-failed')
  }
}

function isLive(job: ExitJob): boolean {
  return job.progress.status === 'observing' || job.progress.status === 'admitting'
}

function enrolled(job: ExitJob): ExitEnrollment {
  return {
    status: 'registered',
    notificationID: job.registration.notificationID,
    watching: { exit: job.notifyOnExit, output: job.notifyOnOutput },
  }
}
