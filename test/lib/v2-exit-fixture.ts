import type { ExitClock, ExitDiagnostic } from '../../src/v2/exit-runtime.ts'
import { setupPtyPlugin } from '../../src/v2/setup.ts'
import type { PtyExitAdmission, PtyExitInput, ToolInfoV2 } from '../../src/v2/types.ts'

export interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
  readonly reject: (reason: unknown) => void
}

export function deferred<Value>(): Deferred<Value> {
  return Promise.withResolvers<Value>()
}

interface TestTimer {
  readonly deadline: number
  readonly sequence: number
  readonly callback: () => void
}

export class TestExitClock implements ExitClock {
  private now = 0
  private sequence = 0
  private readonly timers = new Set<TestTimer>()

  after(delayMS: number, callback: () => void): () => void {
    const timer = { deadline: this.now + delayMS, sequence: this.sequence++, callback }
    this.timers.add(timer)
    return () => {
      this.timers.delete(timer)
    }
  }

  advance(delayMS: number): void {
    this.now += delayMS
    while (true) {
      const next = [...this.timers]
        .filter((timer) => timer.deadline <= this.now)
        .sort((a, b) => a.deadline - b.deadline || a.sequence - b.sequence)[0]
      if (!next) return
      this.timers.delete(next)
      next.callback()
    }
  }

  pending(): number {
    return this.timers.size
  }
}

export interface ExitRequest {
  readonly method: string
  readonly path: string
  readonly body: unknown
  readonly signal: AbortSignal | undefined
}

export interface ExitFixtureOptions {
  readonly request: (request: ExitRequest) => Promise<Response>
  readonly synthetic: (input: PtyExitInput) => Promise<PtyExitAdmission>
  readonly deadlineFailure?: 'throw'
}

export interface ExitFixture {
  readonly clock: TestExitClock
  readonly requests: ExitRequest[]
  readonly admissions: PtyExitInput[]
  readonly diagnostics: ExitDiagnostic[]
  readonly tools: readonly ToolInfoV2[]
  readonly cleanup: () => Promise<void>
  readonly disposed: () => number
  readonly closeOwner: () => Promise<void>
  readonly ownerClosed: () => boolean
}

export async function makeExitFixture(options: ExitFixtureOptions): Promise<ExitFixture> {
  const clock = new TestExitClock()
  const requests: ExitRequest[] = []
  const admissions: PtyExitInput[] = []
  const diagnostics: ExitDiagnostic[] = []
  const tools: ToolInfoV2[] = []
  let disposed = 0
  const cleanup = await setupPtyPlugin(
    {
      options: { serverUrl: 'http://127.0.0.1:9876/', serverPassword: '' },
      session: {
        synthetic: (input) => {
          admissions.push(input)
          return options.synthetic(input)
        },
      },
      tool: {
        transform: async (callback) => {
          callback({ add: (tool) => tools.push(tool) })
          return {
            dispose: async () => {
              disposed++
            },
          }
        },
      },
    },
    {
      clock:
        options.deadlineFailure === 'throw'
          ? {
              after: (delay, callback) => {
                if (delay === 5000) throw new Error('injected clock defect')
                return clock.after(delay, callback)
              },
            }
          : clock,
      report: (diagnostic) => diagnostics.push(diagnostic),
      fetch: (url, init) => {
        const request: ExitRequest = {
          method: init?.method ?? 'GET',
          path: url.pathname,
          body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
          signal: init?.signal ?? undefined,
        }
        requests.push(request)
        return options.request(request)
      },
    }
  )
  const owner = ownerCleanup(cleanup)
  return {
    clock,
    requests,
    admissions,
    diagnostics,
    tools,
    cleanup,
    disposed: () => disposed,
    closeOwner: owner.close,
    ownerClosed: owner.closed,
  }
}

function ownerCleanup(cleanup: () => Promise<void>): {
  close: () => Promise<void>
  closed: () => boolean
} {
  let pending: Promise<void> | undefined
  let closed = false
  return {
    close: () => {
      pending ??= cleanup().then(() => {
        closed = true
      })
      return pending
    },
    closed: () => closed,
  }
}

export function fixtureTool(fixture: ExitFixture, name: string): ToolInfoV2 {
  const found = fixture.tools.find((tool) => tool.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

export async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await Bun.sleep(0)
  }
  throw new Error('test condition did not settle')
}
