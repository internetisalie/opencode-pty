import { expect, test } from 'bun:test'
import type { ExitFixture } from './lib/v2-exit-fixture.ts'
import { fixtureTool, makeExitFixture } from './lib/v2-exit-fixture.ts'
import {
  acknowledgment,
  assertAdmission,
  baseInfo,
  context,
  listPath,
  projected,
  script,
  snapshotResponse,
} from './lib/v2-exit-script.ts'

interface OutputCase {
  readonly notifyOnOutput?: unknown
  readonly notifyOnExit?: boolean
  readonly failure?: 'retry' | 'conflict'
}

// Native snapshot cursors follow opencode/packages/schema/src/persistent-pty.ts#Info.
async function outputFixture(options: OutputCase): Promise<{
  fixture: ExitFixture
  state: { tail: number; status: 'running' | 'exited'; sessionID: string; text: string }
}> {
  const state = {
    tail: 8,
    status: 'running' as 'running' | 'exited',
    sessionID: 'ses_A',
    text: 'same screen',
  }
  let failed = false
  const info = () => ({
    ...baseInfo,
    status: state.status,
    output: { head: 0, tail: state.tail },
    ...(state.status === 'exited' ? { exitCode: 7 } : {}),
  })
  const fixture = await makeExitFixture({
    request: async (request) => {
      if (request.method === 'POST') return Response.json({ data: baseInfo })
      if (request.path === listPath) return Response.json({ data: [info()] })
      if (!request.path.endsWith('/snapshot')) return Response.json({ data: info() })
      return snapshotResponse({ ...info(), sessionID: state.sessionID }, state.text)
    },
    synthetic: async (input) => {
      if (input.metadata.kind === 'output' && options.failure && !failed) {
        failed = true
        if (options.failure === 'conflict')
          throw {
            _tag: 'Session.SyntheticConflictError',
            sessionID: input.sessionID,
            inputID: input.id,
          }
        throw new Error('uncertain output admission')
      }
      return acknowledgment(input)
    },
  })
  return { fixture, state }
}

async function sample(fixture: ExitFixture, delay = 1000): Promise<void> {
  fixture.clock.advance(delay)
  await Bun.sleep(0)
  await Bun.sleep(0)
}

function assertOutput(fixture: ExitFixture, expectedTails: number[]): void {
  expect(fixture.admissions.map((input) => input.metadata.outputTail)).toEqual(expectedTails)
  for (const [index, input] of fixture.admissions.entries()) {
    const tail = expectedTails[index]
    if (tail === undefined) throw new Error('unexpected output admission')
    expect(input.sessionID).toBe('ses_A')
    expect(input.id).toMatch(/^msg_pty_output_[0-9a-f-]{36}$/)
    expect(input.metadata).toEqual({
      source: 'opencode-pty',
      kind: 'output',
      notificationID: input.id,
      ptyID: 'pty_persistent_1',
      sessionID: 'ses_A',
      outputTail: tail,
    })
    expect(input.text).toContain('pty_persistent_1')
    expect(input.text).toContain('ses_A')
    expect(input.text).toContain('pty_read')
    expect(input.text).not.toContain('same screen')
    expect(input.delivery).toBe('steer')
    expect(input.resume).toBe(true)
    expect(Object.isFrozen(input)).toBe(true)
    expect(Object.isFrozen(input.metadata)).toBe(true)
  }
}

async function assertAdvances(
  fixture: ExitFixture,
  state: Awaited<ReturnType<typeof outputFixture>>['state'],
  options: OutputCase
): Promise<void> {
  const optedIn = options.notifyOnOutput === true
  const initial = optedIn ? [8] : []
  assertOutput(fixture, initial)
  if (options.failure === 'retry') {
    await sample(fixture)
    expect(fixture.admissions[1]).toBe(fixture.admissions[0])
    initial.push(8)
  }
  await sample(fixture)
  assertOutput(fixture, initial)
  state.tail = 16
  state.sessionID = 'ses_other'
  await sample(fixture)
  assertOutput(fixture, initial)
  state.sessionID = 'ses_A'
  await sample(fixture)
  const later = optedIn ? [...initial, 16] : []
  assertOutput(fixture, later)
  if (optedIn) expect(fixture.admissions.at(-1)?.id).not.toBe(fixture.admissions[0]?.id)
  state.text = 'changed screen without new output'
  await sample(fixture)
  assertOutput(fixture, later)
  state.tail = -1
  for (let index = 0; index < 8; index++) await sample(fixture)
  assertOutput(fixture, later)
  state.tail = 16
}

test('output opt-in observes native snapshot tail and preserves independent exit delivery', async () => {
  const cases: OutputCase[] = [
    {},
    { notifyOnOutput: false },
    { notifyOnOutput: 'true' },
    { notifyOnOutput: true },
    { notifyOnOutput: true, notifyOnExit: false, failure: 'retry' },
    { notifyOnOutput: true, notifyOnExit: true },
    { notifyOnOutput: false, notifyOnExit: true },
    { notifyOnOutput: true, notifyOnExit: true, failure: 'conflict' },
  ]
  for (const options of cases) {
    const { fixture, state } = await outputFixture(options)
    try {
      const ctx = { ...context() }
      const spawn = fixtureTool(fixture, 'pty_spawn')
      expect(spawn.input.properties).toHaveProperty('notifyOnOutput', { type: 'boolean' })
      await spawn.execute(
        { command: '/bin/sh', args: [], description: 'output case', ...options },
        ctx
      )
      ctx.sessionID = 'ses_selected_later'
      await sample(fixture, 0)
      if (options.failure !== 'conflict') await assertAdvances(fixture, state, options)
      else
        expect(fixture.diagnostics.some((entry) => entry.reason === 'admission-conflict')).toBe(
          true
        )
      const beforeExit = fixture.admissions.length
      state.status = 'exited'
      await sample(fixture)
      expect(fixture.admissions.slice(beforeExit).map((input) => input.metadata.kind)).toEqual(
        options.notifyOnExit === true ? ['exit'] : []
      )
      if (options.notifyOnExit) {
        expect(fixture.admissions.at(-1)?.metadata.exitCode).toBe(7)
        expect(fixture.admissions.at(-1)?.sessionID).toBe('ses_A')
      }
      expect(
        fixture.requests
          .filter((request) => request.method !== 'GET')
          .map((request) => `${request.method} ${request.path}`)
      ).toEqual([`POST ${listPath}`])
      expect(
        (await fixtureTool(fixture, 'pty_read').execute({ id: baseInfo.id }, context())).content
      ).toContain(state.text)
    } finally {
      await fixture.cleanup()
      expect(fixture.clock.pending()).toBe(0)
    }
  }
})

test('exit admission failure reports independently after the same output admission failure', async () => {
  let exited = false
  const info = (): Record<string, unknown> =>
    projected(exited ? 'exited' : 'running', exited ? 7 : undefined)
  const fixture = await makeExitFixture({
    request: script({
      list: async () => Response.json({ data: [info()] }),
      snapshot: async () => snapshotResponse(info()),
    }),
    synthetic: async (input) => ({ ...acknowledgment(input), id: 'msg_mismatched_acknowledgment' }),
  })
  try {
    const spawned = await fixtureTool(fixture, 'pty_spawn').execute(
      {
        command: '/bin/sh',
        args: [],
        description: 'diagnostics',
        notifyOnOutput: true,
        notifyOnExit: true,
      },
      context()
    )
    await sample(fixture, 0)
    expect(fixture.admissions).toHaveLength(1)
    expect(fixture.diagnostics).toHaveLength(1)
    exited = true
    await sample(fixture)
    expect(fixture.admissions).toHaveLength(2)
    const [output, exit] = fixture.admissions
    if (!output || !exit) throw new Error('missing output or exit admission')
    expect(output.metadata.kind).toBe('output')
    expect(output.id).toMatch(/^msg_pty_output_[0-9a-f-]{36}$/)
    assertAdmission(exit, 7)
    expect(spawned.content).toContain(exit.id)
    expect(output.id).not.toBe(exit.id)
    expect(fixture.diagnostics).toEqual([
      {
        ptyID: baseInfo.id,
        sessionID: 'ses_A',
        notificationID: output.id,
        reason: 'invalid-admission',
        admission: 'unconfirmed',
      },
      {
        ptyID: baseInfo.id,
        sessionID: 'ses_A',
        notificationID: exit.id,
        reason: 'invalid-admission',
        admission: 'unconfirmed',
      },
    ])
    await sample(fixture)
    expect(fixture.diagnostics).toHaveLength(2)
  } finally {
    await fixture.cleanup()
    expect(fixture.clock.pending()).toBe(0)
  }
})
