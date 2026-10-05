import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExitDiagnostic } from '../src/v2/exit-runtime.ts'
import {
  fileRegistrationStore,
  memoryRegistrationStore,
  type RegistrationStore,
} from '../src/v2/registration-store.ts'
import { setupPtyPlugin } from '../src/v2/setup.ts'
import { resetSharedMonitors, serverKey } from '../src/v2/shared-monitor.ts'
import type { ToolInfoV2 } from '../src/v2/types.ts'
import { deferred, TestExitClock } from './lib/v2-exit-fixture.ts'
import { baseInfo, context, listPath, snapshotResponse } from './lib/v2-exit-script.ts'

afterEach(resetSharedMonitors)

interface Terminal {
  status: 'running' | 'exited'
  listed: boolean
  tail: number
}

interface Posted {
  readonly id: string
  readonly sessionID: string
  readonly kind: string
  readonly text: string
  readonly outputTail?: number
  readonly reason?: string
}

type Delivery = (posted: Posted) => Promise<Response | undefined> | Response | undefined

let ports = 9100

// One OpenCode server: a terminal the native service keeps alive, one clock, one store, and any number of
// plugin instances in front of them. Notices arrive as POSTs to the server's synthetic route.
function world(
  terminal: Terminal = { status: 'running', listed: true, tail: 8 },
  store?: RegistrationStore
) {
  const url = `http://127.0.0.1:${ports++}`
  const clock = new TestExitClock()
  const theStore = store ?? memoryRegistrationStore(serverKey(url))
  const diagnostics: ExitDiagnostic[] = []
  const posted: Posted[] = []
  let delivery: Delivery = () => undefined
  const infoOf = () => ({
    ...baseInfo,
    status: terminal.status,
    output: { head: 0, tail: terminal.tail },
    ...(terminal.status === 'exited' ? { exitCode: 7 } : {}),
  })
  const authorizations: Array<string | null> = []
  const fetch = async (target: URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    authorizations.push(new Headers(init?.headers).get('authorization'))
    const synthetic = /^\/api\/session\/([^/]+)\/synthetic$/.exec(target.pathname)
    if (synthetic) {
      const body = JSON.parse(String(init?.body)) as {
        id: string
        text: string
        metadata: { kind: string; outputTail?: number; reason?: string }
      }
      const entry: Posted = {
        id: body.id,
        sessionID: synthetic[1] ?? '',
        kind: body.metadata.kind,
        text: body.text,
        outputTail: body.metadata.outputTail,
        reason: body.metadata.reason,
      }
      posted.push(entry)
      const override = await delivery(entry)
      if (override) return override
      return Response.json({
        data: {
          id: body.id,
          sessionID: entry.sessionID,
          type: 'synthetic',
          time: { created: 1 },
          payload: { text: body.text },
          delivery: 'steer',
        },
      })
    }
    if (method === 'POST') return Response.json({ data: baseInfo })
    if (target.pathname === listPath)
      return Response.json({ data: terminal.listed ? [infoOf()] : [] })
    if (!target.pathname.endsWith('/snapshot')) return Response.json({ data: infoOf() })
    return snapshotResponse(infoOf(), 'screen')
  }
  const sample = async (delay = 1000): Promise<void> => {
    clock.advance(delay)
    for (let turn = 0; turn < 8; turn++) await Bun.sleep(0)
  }
  async function instance() {
    const tools: ToolInfoV2[] = []
    const cleanup = await setupPtyPlugin(
      {
        options: { serverUrl: url, serverPassword: '' },
        session: {
          synthetic: async () => {
            throw new Error('an instance must not be the delivery path')
          },
        },
        tool: {
          transform: async (callback) => {
            callback({ add: (tool) => tools.push(tool) })
            return { dispose: async () => {} }
          },
        },
      },
      { clock, fetch, report: (entry) => diagnostics.push(entry), store: theStore }
    )
    const tool = (name: string): ToolInfoV2 => {
      const found = tools.find((entry) => entry.name === name)
      if (!found) throw new Error(`missing tool ${name}`)
      return found
    }
    return {
      cleanup,
      spawn: (args: Record<string, unknown>) =>
        tool('pty_spawn').execute(
          { command: '/bin/sh', args: [], description: 'case', ...args },
          context()
        ),
      watch: (args: Record<string, unknown>) =>
        tool('pty_watch').execute({ id: baseInfo.id, ...args }, context()),
      kill: () => tool('pty_kill').execute({ id: baseInfo.id }, context()),
    }
  }
  return {
    terminal,
    clock,
    store: theStore,
    diagnostics,
    posted,
    authorizations,
    fetchFor: fetch,
    sample,
    instance,
    deliverWith: (next: Delivery) => {
      delivery = next
    },
  }
}

type World = ReturnType<typeof world>
const reasons = (w: World) => w.diagnostics.map((entry) => entry.reason)
const kinds = (w: World) => w.posted.map((entry) => entry.kind)
const failure = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// loom:tc LDV-238#TC-01
test('a watch survives every plugin instance and is still delivered, with none alive', async () => {
  const w = world()
  const first = await w.instance()
  await first.spawn({ notifyOnOutput: true })
  await w.sample(0)
  expect(kinds(w)).toEqual(['output'])
  await first.cleanup()
  expect(reasons(w)).not.toContain('disposed-registration-lost')
  w.terminal.tail = 24
  await w.sample()
  expect(w.posted.map((entry) => entry.outputTail)).toEqual([8, 24])
  expect(w.posted[1]?.sessionID).toBe('ses_A')
})

// loom:tc LDV-238#TC-02
test('the tools of any instance act on the one watch: join, kill and no second watcher', async () => {
  const w = world()
  const first = await w.instance()
  const second = await w.instance()
  await first.spawn({ notifyOnExit: true })
  const reply = await second.watch({ notifyOnOutput: true })
  expect(reply.content).toContain('exit and output')
  await second.watch({ notifyOnOutput: true })
  w.terminal.status = 'exited'
  await w.sample()
  expect(kinds(w).filter((kind) => kind === 'exit')).toHaveLength(1)
  await first.cleanup()
  await second.cleanup()
})

// loom:tc LDV-238#TC-03
test('pty_kill through another instance ends the watch and no exit is reported', async () => {
  const w = world()
  const first = await w.instance()
  await first.spawn({ notifyOnExit: true })
  await w.sample(0)
  await first.cleanup()
  const second = await w.instance()
  await second.kill()
  expect(w.store.load()).toEqual([])
  w.terminal.listed = false
  for (let index = 0; index < 5; index++) await w.sample()
  expect(kinds(w)).toEqual([])
  await second.cleanup()
})

// loom:tc LDV-238#TC-04
test('a late acknowledgement after pty_kill does not bring the watch back', async () => {
  const w = world()
  const held = deferred<void>()
  w.deliverWith(async () => {
    await held.promise
    return undefined
  })
  const only = await w.instance()
  await only.spawn({ notifyOnOutput: true, notifyOnExit: true })
  await w.sample(0)
  expect(kinds(w)).toEqual(['output'])
  await only.kill()
  w.terminal.listed = false
  held.resolve()
  for (let index = 0; index < 6; index++) await w.sample()
  expect(kinds(w)).toEqual(['output'])
  expect(w.store.load()).toEqual([])
  await only.cleanup()
})

// loom:tc LDV-238#TC-05
test('a session the server does not know retires the watch; a conflict retires it; a failure is retried', async () => {
  const missing = world()
  missing.deliverWith(() =>
    failure(404, { _tag: 'SessionNotFoundError', sessionID: 'ses_A', message: 'gone' })
  )
  const a = await missing.instance()
  await a.spawn({ notifyOnOutput: true })
  await missing.sample(0)
  expect(reasons(missing)).toContain('admission-session-missing')
  await resetSharedMonitors()

  const conflict = world()
  conflict.deliverWith(() => failure(409, { _tag: 'ConflictError', message: 'seen' }))
  const b = await conflict.instance()
  await b.spawn({ notifyOnOutput: true })
  await conflict.sample(0)
  expect(reasons(conflict)).toContain('admission-conflict')
  await resetSharedMonitors()

  const flaky = world()
  let fails = 2
  flaky.deliverWith(() => (fails-- > 0 ? failure(500, { message: 'busy' }) : undefined))
  const c = await flaky.instance()
  await c.spawn({ notifyOnOutput: true })
  await flaky.sample(0)
  await flaky.sample()
  await flaky.sample(2000)
  expect(kinds(flaky)).toEqual(['output', 'output', 'output'])
  expect(new Set(flaky.posted.map((entry) => entry.id)).size).toBe(1)
  expect(reasons(flaky)).toContain('admitted')
  expect(reasons(flaky)).not.toContain('admission-session-missing')
})

// loom:tc LDV-238#TC-06
test('after a server restart the stored watches are adopted once and delivered', async () => {
  const w = world()
  const before = await w.instance()
  await before.spawn({ notifyOnExit: true, notifyOnOutput: true })
  await w.sample(0)
  const stored = w.store.load()[0]
  expect(stored?.outputTail).toBe(8)
  await before.cleanup()
  await resetSharedMonitors()
  w.posted.length = 0
  w.terminal.tail = 40
  const after = await w.instance()
  expect(reasons(w)).toContain('adopted')
  await w.sample(0)
  expect(w.posted.map((entry) => entry.outputTail)).toEqual([40])
  w.terminal.listed = false
  for (let index = 0; index < 4; index++) await w.sample()
  expect(kinds(w)).toEqual(['output', 'exit'])
  expect(w.posted[1]?.id).toBe(stored?.notificationID)
  expect(w.store.load()).toEqual([])
  await after.cleanup()
})

// loom:tc LDV-238#TC-07
test('a restart with no new output announces nothing', async () => {
  const w = world()
  const before = await w.instance()
  await before.spawn({ notifyOnOutput: true })
  await w.sample(0)
  await before.cleanup()
  await resetSharedMonitors()
  w.posted.length = 0
  const after = await w.instance()
  await w.sample(0)
  await w.sample()
  expect(kinds(w)).toEqual([])
  await after.cleanup()
})

// loom:tc LDV-238#TC-08
test('a terminal removed before a restart is not adopted', async () => {
  const w = world()
  const before = await w.instance()
  await before.spawn({ notifyOnOutput: true })
  await w.sample(0)
  await before.kill()
  await before.cleanup()
  await resetSharedMonitors()
  w.posted.length = 0
  const after = await w.instance()
  expect(reasons(w)).not.toContain('adopted')
  w.terminal.tail = 99
  await w.sample()
  expect(kinds(w)).toEqual([])
  await after.cleanup()
})

// loom:tc LDV-238#TC-09
test('the session is told when a watch ends because observation failed', async () => {
  const w = world({ status: 'running', listed: false, tail: 8 })
  const only = await w.instance()
  await only.spawn({ notifyOnOutput: true, notifyOnExit: false })
  for (let index = 0; index < 4; index++) await w.sample()
  expect(reasons(w)).toContain('observation-missing-exhausted')
  expect(kinds(w)).toEqual(['watch-ended'])
  expect(w.posted[0]?.text).toContain('pty_watch')
  expect(w.posted[0]?.reason).toBe('observation-missing-exhausted')
  await only.cleanup()
})

// loom:tc LDV-238#TC-10
test('a watch-ended notice that cannot be delivered is reported, not retried', async () => {
  const w = world({ status: 'running', listed: false, tail: 8 })
  w.deliverWith(() => failure(500, { message: 'busy' }))
  const only = await w.instance()
  await only.spawn({ notifyOnOutput: true, notifyOnExit: false })
  for (let index = 0; index < 4; index++) await w.sample()
  await Bun.sleep(0)
  expect(reasons(w)).toContain('watch-end-unconfirmed')
  const count = w.posted.length
  await w.sample(60000)
  expect(w.posted).toHaveLength(count)
  await only.cleanup()
})

// loom:tc LDV-238#TC-11
test('pty_watch starts a watch on a terminal never watched, without respawning it', async () => {
  const w = world()
  const only = await w.instance()
  const reply = await only.watch({ notifyOnOutput: true })
  expect(reply.content).toContain('exit and output')
  await w.sample(0)
  expect(kinds(w)).toEqual(['output'])
  await only.cleanup()
})

// loom:tc LDV-238#TC-12
test('pty_watch restarts a watch that retired', async () => {
  const w = world()
  w.deliverWith(() =>
    failure(404, { _tag: 'SessionNotFoundError', sessionID: 'ses_A', message: '' })
  )
  const only = await w.instance()
  await only.spawn({ notifyOnOutput: true })
  await w.sample(0)
  expect(reasons(w)).toContain('admission-session-missing')
  w.deliverWith(() => undefined)
  w.terminal.tail = 20
  await w.sample()
  expect(
    w.posted.filter((entry) => entry.kind === 'output' && entry.outputTail === 20)
  ).toHaveLength(0)
  await only.watch({ notifyOnOutput: true })
  await w.sample(0)
  await w.sample()
  expect(w.posted.at(-1)?.outputTail).toBe(20)
  w.terminal.tail = 30
  await w.sample()
  expect(w.posted.at(-1)?.outputTail).toBe(30)
  await only.cleanup()
})

// loom:tc LDV-238#TC-13
test('pty_watch adds exit notices to an output-only watch, says what it delivers, refuses nothing-to-watch and a stopped terminal', async () => {
  const w = world()
  const only = await w.instance()
  await expect(only.watch({ notifyOnExit: false })).rejects.toThrow('nothing to watch')
  await only.spawn({ notifyOnOutput: true, notifyOnExit: false })
  const reply = await only.watch({ notifyOnOutput: true })
  expect(reply.content).toContain('exit and output')
  expect(w.store.load()[0]?.notifyOnExit).toBe(true)
  w.terminal.status = 'exited'
  await w.sample()
  expect(kinds(w)).toContain('exit')
  await expect(only.watch({ notifyOnOutput: true })).rejects.toThrow('is not running')
  await only.cleanup()
})

// loom:tc LDV-238#TC-14
test('a failing store is reported once and watching goes on', async () => {
  const store = memoryRegistrationStore('failing')
  const w = world(undefined, {
    key: store.key,
    load: () => [],
    apply: () => {
      throw new Error('disk full')
    },
  })
  const only = await w.instance()
  await only.spawn({ notifyOnOutput: true })
  await w.sample(0)
  await w.sample()
  expect(reasons(w).filter((reason) => reason === 'registration-store-failed')).toHaveLength(1)
  expect(kinds(w)).toEqual(['output'])
  await only.cleanup()
})

// loom:tc LDV-238#TC-15
test('settled watches leave memory; the server is one server under any spelling', async () => {
  const w = world()
  const only = await w.instance()
  await only.spawn({ notifyOnExit: true })
  w.terminal.status = 'exited'
  await w.sample(0)
  await w.sample()
  expect(kinds(w)).toEqual(['exit'])
  w.terminal.status = 'running'
  const again = await only.spawn({ notifyOnExit: true })
  await w.sample(0)
  expect(again.content).toContain('Exit notification:')
  w.terminal.status = 'exited'
  await w.sample()
  // The finished watch left memory, so the same terminal can be watched again.
  expect(kinds(w)).toEqual(['exit', 'exit'])
  expect(serverKey('http://localhost:4097/')).toBe(serverKey('http://127.0.0.1:4097'))
  expect(serverKey('http://127.0.0.1:4096')).not.toBe(serverKey('http://127.0.0.1:4097'))
  await only.cleanup()
})

// loom:tc LDV-238#TC-16
test('the file store keeps watches per server and ignores damaged records', () => {
  mkdirSync(process.env.XDG_STATE_HOME ?? tmpdir(), { recursive: true })
  const directory = mkdtempSync(join(process.env.XDG_STATE_HOME ?? tmpdir(), 'store-'))
  try {
    const record = {
      ptyID: 'pty_persistent_1',
      sessionID: 'ses_A',
      notificationID: 'msg_pty_exit_1',
      notifyOnExit: true,
      notifyOnOutput: true,
      outputTail: 5,
    }
    const a = fileRegistrationStore('http://127.0.0.1:4097/', directory)
    const b = fileRegistrationStore('http://127.0.0.1:4096', directory)
    expect(a.load()).toEqual([])
    a.apply([record], [])
    expect(a.load()).toEqual([record])
    expect(b.load()).toEqual([])
    expect(fileRegistrationStore('http://127.0.0.1:4097', directory).load()).toEqual([record])
    a.apply([{ ...record, outputTail: 9 }], [])
    expect(a.load()).toEqual([{ ...record, outputTail: 9 }])
    a.apply([], [JSON.stringify(['ses_A', 'pty_persistent_1'])])
    expect(a.load()).toEqual([])
    const stored = fileRegistrationStore('http://127.0.0.1:4097', directory)
    stored.apply([record, { ...record, ptyID: 'pty_persistent_2' }], [])
    const name = readdirSync(directory).find((file) => file.startsWith('registrations-'))
    if (!name) throw new Error('store file missing')
    writeFileSync(
      join(directory, name),
      JSON.stringify([record, { ptyID: 7 }, null, { ...record, outputTail: -1 }])
    )
    expect(stored.load()).toEqual([record])
    writeFileSync(join(directory, name), '{not json')
    expect(() => stored.load()).toThrow()
    stored.apply([record], [])
    expect(stored.load()).toEqual([record])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// loom:tc LDV-238#TC-17
test('a 404 that is not a missing session is retried, not treated as a missing session', async () => {
  const w = world()
  w.deliverWith(() => new Response('', { status: 404 }))
  const only = await w.instance()
  await only.spawn({ notifyOnOutput: true })
  await w.sample(0)
  for (let index = 0; index < 8; index++) await w.sample(5000)
  expect(reasons(w)).not.toContain('admission-session-missing')
  expect(reasons(w)).toContain('admission-unconfirmed-exhausted')
  expect(new Set(w.posted.map((entry) => entry.id)).size).toBe(1)
  expect(w.posted.length).toBeGreaterThan(1)
  await only.cleanup()
})

// loom:tc LDV-238#TC-18
test('the delivery request carries the server password', async () => {
  const w = world()
  const tools: ToolInfoV2[] = []
  await setupPtyPlugin(
    {
      options: { serverUrl: `http://127.0.0.1:${ports++}`, serverPassword: 'secret' },
      session: { synthetic: async () => ({}) as never },
      tool: {
        transform: async (callback) => {
          callback({ add: (tool) => tools.push(tool) })
          return { dispose: async () => {} }
        },
      },
    },
    {
      clock: w.clock,
      fetch: async (target, init) => {
        w.authorizations.push(new Headers(init?.headers).get('authorization'))
        return w.fetchFor(target, init)
      },
      store: memoryRegistrationStore('auth'),
    }
  )
  const spawn = tools.find((tool) => tool.name === 'pty_spawn')
  await spawn?.execute(
    { command: '/bin/sh', args: [], description: 'case', notifyOnOutput: true },
    context()
  )
  await w.sample(0)
  expect(w.posted).toHaveLength(1)
  const expected = `Basic ${Buffer.from('opencode:secret').toString('base64')}`
  expect(w.authorizations.length).toBeGreaterThan(1)
  expect(new Set(w.authorizations)).toEqual(new Set([expected]))
})

// loom:tc LDV-238#TC-19
test('a second copy of the module finds the one shared monitor', async () => {
  const first = await import('../src/v2/shared-monitor.ts')
  const second = await import(`../src/v2/shared-monitor.ts?copy=${Date.now()}`)
  expect(second).not.toBe(first)
  const made: object[] = []
  const monitor = first.sharedMonitor('copy-key', () => {
    const created = { adopt: () => 0, dispose: async () => {} }
    made.push(created)
    return created as never
  })
  const again = second.sharedMonitor('copy-key', () => {
    throw new Error('a second copy built its own monitor')
  })
  expect(again).toBe(monitor)
  expect(made).toHaveLength(1)
})

// loom:tc LDV-238#TC-20
test('two servers behind one host and port with different path prefixes are two servers', () => {
  expect(serverKey('http://127.0.0.1:4097/a')).not.toBe(serverKey('http://127.0.0.1:4097/b'))
  expect(serverKey('http://127.0.0.1:4097/a/')).toBe(serverKey('http://127.0.0.1:4097/a'))
})
