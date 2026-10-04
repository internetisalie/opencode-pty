import type { ExitClock, ExitJob } from './exit-runtime.ts'
import { EXIT_READ_MS } from './exit-runtime.ts'
import type { ExitSample } from './exit-state.ts'
import { classifyExit, decodeExitList, decodeExitSnapshot, ExitDecodeError } from './exit-state.ts'
import type { NativePtyClient } from './native.ts'

interface ExitObservationOptions {
  readonly client: Pick<NativePtyClient, 'list' | 'snapshot'>
  readonly job: ExitJob
  readonly clock: ExitClock
  readonly active: () => boolean
}

async function sampleExit(options: ExitObservationOptions): Promise<ExitSample> {
  const { client, job, active } = options
  const signal = job.controller?.signal
  const listed = decodeExitList(await client.list(job.registration.sessionID, signal))
  if (!active()) return { status: 'running' }
  const targets = listed.filter((info) => info.ptyID === job.registration.ptyID)
  if (targets.length === 0) return { status: 'incomplete', reason: 'missing-pty' }
  if (targets.length !== 1) return { status: 'incomplete', reason: 'duplicate-pty' }
  const nativeSnapshot = await client.snapshot(job.registration.ptyID, signal)
  const snapshot = decodeExitSnapshot(nativeSnapshot)
  if (!active()) return { status: 'running' }
  const result = classifyExit({ registration: job.registration, listed, snapshot })
  if (result.status !== 'running' || !job.notifyOnOutput) return result
  const tail: unknown = nativeSnapshot.info.output?.tail
  if (typeof tail !== 'number' || !Number.isInteger(tail) || tail < 0)
    return { status: 'running', reason: 'invalid-snapshot' }
  return { status: 'running', outputTail: tail }
}

export async function observeExit(options: ExitObservationOptions): Promise<ExitSample> {
  const { job, clock, active } = options
  job.controller = new AbortController()
  let deadline = false
  try {
    job.cancelDeadline = clock.after(EXIT_READ_MS, () => {
      deadline = true
      job.controller?.abort()
    })
    return await readExit(options, () => deadline)
  } finally {
    job.cancelDeadline?.()
    job.cancelDeadline = undefined
    job.controller = undefined
  }
  async function readExit(
    context: ExitObservationOptions,
    expired: () => boolean
  ): Promise<ExitSample> {
    try {
      return await sampleExit(context)
    } catch (error) {
      if (!active()) return { status: 'running' }
      const reason = expired()
        ? 'read-deadline'
        : error instanceof ExitDecodeError
          ? error.reason
          : 'read-failed'
      return { status: 'incomplete', reason }
    }
  }
}
