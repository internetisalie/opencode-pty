import { expect, test } from 'bun:test'
import { NativePtyClient } from '../src/v2/native.ts'
import { setupPtyPlugin } from '../src/v2/setup.ts'
import { nativeTools } from '../src/v2/tools.ts'
import type { ToolInfoV2 } from '../src/v2/types.ts'
import { eventually, TestExitClock } from './lib/v2-exit-fixture.ts'
import {
  assertAdmission,
  assertDiagnostic,
  baseInfo,
  context,
  exitFixture,
  listPath,
  projected,
  script,
  snapshotPath,
  snapshotResponse,
  spawn,
} from './lib/v2-exit-script.ts'

// loom:tc LDV-182-REQ#TC-10
test('TC-10 retained final output', async () => {
  let retained = true
  const info = projected('exited', 7)
  const request = async (call: { method: string; path: string }): Promise<Response> => {
    if (call.method === 'POST' && call.path === listPath) return Response.json({ data: baseInfo })
    if (call.method !== 'GET') {
      retained = false
      return new Response(null, { status: 204 })
    }
    if (call.path === listPath) return Response.json({ data: retained ? [info] : [] })
    if (call.path === snapshotPath)
      return retained ? snapshotResponse(info) : Response.json({ error: 'gone' }, { status: 404 })
    throw new Error('unexpected request')
  }
  const fixture = await exitFixture({ request })
  const reader = new NativePtyClient({
    serverUrl: 'http://127.0.0.1:9876/',
    password: '',
    fetch: (url, init) => request({ path: url.pathname, method: init?.method ?? 'GET' }),
  })
  try {
    await spawn(fixture)
    fixture.clock.advance(0)
    await eventually(() => fixture.admissions.length === 1 && fixture.clock.pending() === 0)
    assertAdmission(fixture.admissions[0], 7)
    for (const delay of [0, 100, 9900]) {
      fixture.clock.advance(delay)
      expect(
        (await reader.list('ses_A')).map((entry) => entry.id),
        `post-admission request ledger: ${JSON.stringify(fixture.requests.map((entry) => `${entry.method} ${entry.path}`))}`
      ).toEqual(['pty_persistent_1'])
      const snapshot = await reader.snapshot('pty_persistent_1')
      expect(snapshot.info.exitCode).toBe(7)
      expect(snapshot.text).toBe('FINAL7:case')
    }
    expect(fixture.requests.map((entry) => entry.method)).toEqual(['POST', 'GET', 'GET'])
  } finally {
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-13
test('TC-13 read recovery', async () => {
  let reads = 0
  const fixture = await exitFixture({
    request: script({
      list: async () => {
        if (reads++ === 0) throw new Error('scripted loss')
        return Response.json({ data: [projected('exited', 7)] })
      },
      snapshot: async () => snapshotResponse(projected('exited', 7)),
    }),
  })
  try {
    await spawn(fixture)
    fixture.clock.advance(0)
    await eventually(() => fixture.diagnostics.length === 1 && fixture.clock.pending() === 1)
    expect(fixture.admissions).toHaveLength(0)
    fixture.clock.advance(1000)
    await eventually(() => fixture.admissions.length === 1)
    assertAdmission(fixture.admissions[0], 7)
  } finally {
    await fixture.cleanup()
  }
})

// loom:tc LDV-182-REQ#TC-14
test('TC-14 fresh activation loses registration', async () => {
  const old = await exitFixture()
  const fresh = await exitFixture()
  try {
    const content = await spawn(old)
    expect(content).toContain('plugin/server restart loses opt-in and uncertain retry state.')
    await old.cleanup()
    assertDiagnostic(old, 'disposed-registration-lost')
    fresh.clock.advance(60000)
    expect(fresh.requests).toHaveLength(0)
    expect(fresh.admissions).toHaveLength(0)
  } finally {
    await old.cleanup()
    await fresh.cleanup()
  }
})

test('setup failure disposes monitor', async () => {
  const failure = new Error('transform failed')
  const clock = new TestExitClock()
  const tools: ToolInfoV2[] = []
  await expect(
    setupPtyPlugin(
      {
        options: { serverUrl: 'http://127.0.0.1:9876/', serverPassword: '' },
        session: {
          synthetic: async () => {
            throw new Error('unexpected admission')
          },
        },
        tool: {
          transform: async (callback) => {
            callback({ add: (tool) => tools.push(tool) })
            const spawnTool = tools.find((tool) => tool.name === 'pty_spawn')
            if (!spawnTool) throw new Error('missing spawn')
            await spawnTool.execute(
              { command: '/bin/sh', args: [], description: 'case', notifyOnExit: true },
              context()
            )
            throw failure
          },
        },
      },
      { clock, fetch: async () => Response.json({ data: baseInfo }), report: () => {} }
    )
  ).rejects.toBe(failure)
  expect(clock.pending()).toBe(0)
})

test('direct tools without monitor report unavailable', async () => {
  const client = new NativePtyClient({
    serverUrl: 'http://127.0.0.1:9876/',
    password: '',
    fetch: async () => Response.json({ data: baseInfo }),
  })
  const tool = nativeTools(client).find((entry) => entry.name === 'pty_spawn')
  if (!tool) throw new Error('missing spawn')
  expect(
    (
      await tool.execute(
        { command: '/bin/sh', args: [], description: 'case', notifyOnExit: true },
        context()
      )
    ).content
  ).toContain('Exit monitoring unavailable; PTY retained, no notification promised.')
})

for (const created of [
  { ...baseInfo, id: '' },
  { ...baseInfo, sessionID: 'ses_B' },
]) {
  test(`created identity rejects ${created.id}/${created.sessionID}`, async () => {
    const fixture = await exitFixture({
      request: script({
        create: async () => Response.json({ data: created }),
        list: async () => {
          throw new Error('unexpected list')
        },
        snapshot: async () => {
          throw new Error('unexpected snapshot')
        },
      }),
    })
    try {
      await expect(spawn(fixture)).rejects.toThrow('created PTY identity mismatch')
      expect(fixture.clock.pending()).toBe(0)
      expect(fixture.requests).toHaveLength(1)
    } finally {
      await fixture.cleanup()
    }
  })
}

test('failed create never registers', async () => {
  const fixture = await exitFixture({
    request: async () => Response.json({ error: 'create refused' }, { status: 500 }),
  })
  try {
    await expect(spawn(fixture)).rejects.toThrow('failed (500)')
    expect(fixture.clock.pending()).toBe(0)
    expect(fixture.admissions).toHaveLength(0)
  } finally {
    await fixture.cleanup()
  }
})
