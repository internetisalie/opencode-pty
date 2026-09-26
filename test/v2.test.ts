import { describe, expect, it } from 'bun:test'
import { NativePtyClient, nativeTools, Plugin } from '../src/v2/index.ts'
import type { ToolInfoV2 } from '../src/v2/types.ts'

const info = {
  id: 'pty_123',
  sessionID: 'ses_1',
  title: 'echo',
  command: 'echo',
  args: ['hello'],
  cwd: '/work',
  status: 'running' as const,
  pid: 42,
  size: { cols: 80, rows: 24 },
}
const ctx = { sessionID: 'ses_1', agent: 'build', signal: new AbortController().signal }

function fakeClient() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const client = new NativePtyClient({
    serverUrl: 'http://127.0.0.1:9876/',
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname
      calls.push({
        method: init?.method ?? 'GET',
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      const data = path.endsWith('/snapshot')
        ? { info, text: 'alpha\nbeta\nalpha' }
        : path.endsWith('/terminal') && init?.method === 'GET'
          ? [info]
          : info
      return Response.json({ data })
    },
  })
  return { client, calls }
}

function requiredTool(client: NativePtyClient, name: string): ToolInfoV2 {
  const found = nativeTools(client).find((tool) => tool.name === name)
  if (!found) throw new Error(`Missing tool ${name}`)
  return found
}

describe('OpenCode v2 native PTY adapter', () => {
  it('registers all five tools with the actual v2 tool editor and disposes them', async () => {
    expect(Plugin.id).toBe('opencode-pty')
    const added: ToolInfoV2[] = []
    let disposed = false
    const cleanup = await Plugin.setup({
      options: { serverUrl: 'http://127.0.0.1:9876/' },
      tool: {
        transform: async (fn) => {
          fn({ add: (tool) => added.push(tool) })
          return {
            dispose: async () => {
              disposed = true
            },
          }
        },
      },
    })
    expect(added.map((tool) => tool.name)).toEqual([
      'pty_spawn',
      'pty_write',
      'pty_read',
      'pty_list',
      'pty_kill',
    ])
    await cleanup?.()
    expect(disposed).toBe(true)
  })

  it('creates, reads, lists, and removes terminals using v2 native endpoints', async () => {
    const { client, calls } = fakeClient()
    expect(
      (
        await requiredTool(client, 'pty_spawn').execute(
          { command: 'echo', args: ['hello'], description: 'test echo' },
          ctx
        )
      ).content
    ).toContain('pty_123')
    expect((await requiredTool(client, 'pty_list').execute({}, ctx)).content).toContain('pty_123')
    expect(
      (
        await requiredTool(client, 'pty_read').execute(
          { id: 'pty_123', pattern: 'alpha', offset: 1 },
          ctx
        )
      ).content
    ).toContain('alpha')
    await requiredTool(client, 'pty_kill').execute({ id: 'pty_123' }, ctx)
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /api/experimental/session/ses_1/terminal',
      'GET /api/experimental/session/ses_1/terminal',
      'GET /api/experimental/persistent-pty/pty_123',
      'GET /api/experimental/persistent-pty/pty_123/snapshot',
      'GET /api/experimental/persistent-pty/pty_123',
      'DELETE /api/experimental/persistent-pty/pty_123',
    ])
    expect(calls[0]?.body).toEqual({
      command: 'echo',
      args: ['hello'],
      title: 'test echo',
      env: {},
    })
  })

  it('rejects access to another session terminal', async () => {
    const { client } = fakeClient()
    const read = requiredTool(client, 'pty_read')
    await expect(read.execute({ id: 'pty_123' }, { ...ctx, sessionID: 'ses_2' })).rejects.toThrow(
      'does not belong'
    )
  })

  it('fails clearly when the native server URL has not been configured', async () => {
    const client = new NativePtyClient({})
    await expect(client.list('ses_1')).rejects.toThrow('serverUrl')
  })

  it('writes through the native ticketed persistent PTY WebSocket', async () => {
    const requests: string[] = []
    const sent: string[] = []
    let socketUrl = ''
    let closed = false
    const socket = new EventTarget() as EventTarget & { send(data: string): void; close(): void }
    socket.send = (data) => sent.push(data)
    socket.close = () => {
      closed = true
    }
    const client = new NativePtyClient({
      serverUrl: 'http://127.0.0.1:9876/',
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname
        requests.push(`${init?.method} ${path}`)
        if (path.endsWith('/connect-token')) {
          expect(new Headers(init?.headers).get('x-opencode-ticket')).toBe('1')
          return Response.json({ data: { ticket: 'one-use-ticket' } })
        }
        return Response.json({ data: info })
      },
      openSocket: (url) => {
        socketUrl = url
        queueMicrotask(() =>
          socket.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ type: 'attached', role: 'controller' }),
            })
          )
        )
        return socket as WebSocket
      },
    })
    const write = requiredTool(client, 'pty_write')
    let completed = false
    const pending = write.execute({ id: 'pty_123', data: 'hello\\n\\x03' }, ctx).then(() => {
      completed = true
    })
    await Bun.sleep(0)
    expect(sent).toEqual(['hello\n\x03'])
    expect(completed).toBe(false)
    expect(closed).toBe(false)
    socket.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify({ type: 'input_ack' }) })
    )
    await pending
    expect(completed).toBe(true)
    expect(closed).toBe(true)
    expect(new URL(socketUrl).searchParams.get('ticket')).toBe('one-use-ticket')
    expect(new URL(socketUrl).searchParams.get('input_ack')).toBe('1')
    expect(requests).toEqual([
      'GET /api/experimental/persistent-pty/pty_123',
      'GET /api/experimental/persistent-pty/pty_123',
      'POST /api/experimental/persistent-pty/pty_123/connect-token',
    ])
  })

  it('uses a disposable HTTP server without contacting installed OpenCode', async () => {
    const requests: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requests.push(`${request.method} ${url.pathname}`)
        if (url.pathname.endsWith('/snapshot'))
          return Response.json({ data: { info, text: 'native output' } })
        return Response.json({ data: info })
      },
    })
    try {
      const client = new NativePtyClient({ serverUrl: server.url.origin })
      const created = await client.create('ses_1', {
        command: 'echo',
        args: ['hello'],
        title: 'echo',
        env: {},
      })
      const snapshot = await client.snapshot(created.id)
      expect(snapshot.text).toBe('native output')
      expect(requests).toEqual([
        'POST /api/experimental/session/ses_1/terminal',
        'GET /api/experimental/persistent-pty/pty_123/snapshot',
      ])
    } finally {
      server.stop(true)
    }
  })
})
