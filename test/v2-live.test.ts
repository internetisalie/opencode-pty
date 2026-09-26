import { expect, test } from 'bun:test'
import { NativePtyClient, nativeTools } from '../src/v2/index.ts'

const serverUrl = process.env.OPENCODE_PTY_V2_TEST_SERVER_URL
const password = process.env.OPENCODE_PTY_V2_TEST_PASSWORD
const live =
  process.env.OPENCODE_PTY_V2_TEST_DISPOSABLE === '1' && serverUrl && password ? test : test.skip

live(
  'runs all five v2 tools against a disposable OpenCode server',
  async () => {
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
    const readyDeadline = Date.now() + 30_000
    while (true) {
      try {
        const ready = await fetch(new URL('/api/info', serverUrl), { headers: { authorization } })
        if (ready.ok) break
      } catch {}
      if (Date.now() >= readyDeadline) throw new Error('Disposable OpenCode server did not start')
      await Bun.sleep(250)
    }
    const created = await fetch(new URL('/api/session', serverUrl), {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Disposable PTY test', location: { directory: '/root' } }),
    })
    expect(created.status).toBe(200)
    const sessionID = ((await created.json()) as { data: { id: string } }).data.id
    const client = new NativePtyClient({ serverUrl, password })
    const tools = new Map(nativeTools(client).map((tool) => [tool.name, tool]))
    const ctx = { sessionID, agent: 'build', signal: new AbortController().signal }
    const run = (name: string, args: unknown) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`Missing ${name}`)
      return tool.execute(args as never, ctx)
    }
    let id: string | undefined
    try {
      const spawned = await run('pty_spawn', {
        command: 'cat',
        args: [],
        description: 'Disposable cat',
      })
      id = /ID: (pty_\S+)/.exec(spawned.content)?.[1]
      if (!id) throw new Error(`Missing terminal ID: ${spawned.content}`)
      expect((await run('pty_list', {})).content).toContain(id)
      await run('pty_write', { id, data: 'smoke-line\n' })
      const deadline = Date.now() + 10_000
      let output = ''
      while (Date.now() < deadline) {
        output = (await run('pty_read', { id })).content
        if (output.includes('smoke-line')) break
        await Bun.sleep(100)
      }
      expect(output).toContain('smoke-line')
      await run('pty_kill', { id })
      id = undefined
    } finally {
      if (id) await client.remove(id).catch(() => {})
      await fetch(new URL(`/api/session/${sessionID}`, serverUrl), {
        method: 'DELETE',
        headers: { authorization },
      }).catch(() => {})
    }
  },
  30_000
)
