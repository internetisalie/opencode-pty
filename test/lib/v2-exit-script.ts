import { expect } from 'bun:test'
import type { ExitAdmissionOutcome, ExitDiagnosticReason } from '../../src/v2/exit-policy.ts'
import type { PtyExitAdmission, PtyExitInput, ToolContextV2 } from '../../src/v2/types.ts'
import type { ExitFixture, ExitFixtureOptions, ExitRequest } from './v2-exit-fixture.ts'
import { eventually, fixtureTool, makeExitFixture } from './v2-exit-fixture.ts'

export const baseInfo = {
  id: 'pty_persistent_1',
  sessionID: 'ses_A',
  title: 'case',
  command: '/bin/sh',
  args: [],
  cwd: '/work',
  status: 'running',
  pid: 42,
  size: { cols: 80, rows: 24 },
  foregroundProcess: null,
  output: { head: 0, tail: 8 },
}
export const listPath = '/api/experimental/session/ses_A/terminal'
export const snapshotPath = '/api/experimental/persistent-pty/pty_persistent_1/snapshot'

export function context(): ToolContextV2 {
  return { sessionID: 'ses_A', agent: 'build', signal: new AbortController().signal }
}

export function projected(status: 'running' | 'exited', code?: unknown): Record<string, unknown> {
  return code === undefined ? { ...baseInfo, status } : { ...baseInfo, status, exitCode: code }
}

export function acknowledgment(input: PtyExitInput): PtyExitAdmission {
  return {
    id: input.id,
    sessionID: input.sessionID,
    type: 'synthetic',
    time: { created: 1 },
    payload: { text: input.text, description: input.description, metadata: input.metadata },
    delivery: 'steer',
  }
}

export function snapshotResponse(info: unknown, text = 'FINAL7:case'): Response {
  return Response.json({ data: { info, text, checkpoint: 'AA==', cursor: { x: 0, y: 0 } } })
}

export function script(options: {
  readonly list: () => Promise<Response>
  readonly snapshot: () => Promise<Response>
  readonly create?: () => Promise<Response>
}): (request: ExitRequest) => Promise<Response> {
  return async (request) => {
    if (request.method === 'POST' && request.path === listPath)
      return options.create ? options.create() : Response.json({ data: baseInfo })
    if (request.method === 'GET' && request.path === listPath) return options.list()
    if (request.method === 'GET' && request.path === snapshotPath) return options.snapshot()
    throw new Error(`unexpected request ${request.method} ${request.path}`)
  }
}

export function exitFixture(options?: Partial<ExitFixtureOptions>): Promise<ExitFixture> {
  const info = projected('exited', 7)
  return makeExitFixture({
    request: script({
      list: async () => Response.json({ data: [info] }),
      snapshot: async () => snapshotResponse(info),
    }),
    synthetic: async (input) => acknowledgment(input),
    ...options,
  })
}

export async function spawn(
  fixture: ExitFixture,
  notify: boolean | undefined = true
): Promise<string> {
  const args = {
    command: '/bin/sh',
    args: [],
    description: 'case',
    ...(notify === undefined ? {} : { notifyOnExit: notify }),
  }
  return (await fixtureTool(fixture, 'pty_spawn').execute(args, context())).content
}

export async function tick(fixture: ExitFixture, delay = 1000): Promise<void> {
  const before = fixture.requests.length
  fixture.clock.advance(delay)
  await eventually(() => fixture.requests.length > before && fixture.clock.pending() <= 1)
  await Bun.sleep(0)
}

export function assertDiagnostic(
  fixture: ExitFixture,
  reason: ExitDiagnosticReason,
  admission: ExitAdmissionOutcome = 'not-attempted'
): void {
  const reports = fixture.diagnostics.filter((diagnostic) => diagnostic.reason === reason)
  expect(reports).toHaveLength(1)
  expect(reports[0]).toEqual({
    ptyID: 'pty_persistent_1',
    sessionID: 'ses_A',
    notificationID: expect.stringMatching(/^msg_pty_exit_[0-9a-f-]{36}$/),
    reason,
    admission,
  })
}

export function assertAdmission(input: PtyExitInput | undefined, code: number): void {
  expect(input).toBeDefined()
  if (!input) throw new Error('missing admission')
  expect(input.id).toMatch(/^msg_pty_exit_[0-9a-f-]{36}$/)
  expect(input).toEqual({
    id: input.id,
    sessionID: 'ses_A',
    delivery: 'steer',
    resume: true,
    description: 'Background PTY exited',
    text: `<pty_exited>\n${JSON.stringify({ ptyID: 'pty_persistent_1', sessionID: 'ses_A', exitCode: code, result: code === 0 ? 'success' : 'error' })}\nUse pty_read to inspect retained output.\n</pty_exited>`,
    metadata: {
      source: 'opencode-pty',
      kind: 'exit',
      notificationID: input.id,
      ptyID: 'pty_persistent_1',
      sessionID: 'ses_A',
      exitCode: code,
    },
  })
  expect(Object.isFrozen(input)).toBe(true)
  expect(Object.isFrozen(input.metadata)).toBe(true)
}
