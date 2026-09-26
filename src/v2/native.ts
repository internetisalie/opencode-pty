export interface NativePtyInfo {
  id: string
  sessionID: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: 'running' | 'exited'
  pid: number
  exitCode?: number
  size: { cols: number; rows: number }
}

export interface NativePtySnapshot {
  info: NativePtyInfo
  text: string
}

export interface NativePtyOptions {
  serverUrl?: string
  password?: string
  fetch?: (url: URL, init?: RequestInit) => Promise<Response>
  openSocket?: (url: string) => WebSocket
}

export class NativePtyClient {
  private readonly base?: URL
  private readonly password?: string
  private readonly send: (url: URL, init?: RequestInit) => Promise<Response>
  private readonly openSocket: (url: string) => WebSocket

  constructor(options: NativePtyOptions) {
    if (options.serverUrl) {
      const base = new URL(options.serverUrl)
      if (base.protocol !== 'http:' && base.protocol !== 'https:') {
        throw new Error('OpenCode PTY serverUrl must use http or https')
      }
      if (base.username || base.password)
        throw new Error('OpenCode PTY serverUrl must not contain credentials')
      this.base = base
    }
    this.password = options.password
    this.send = options.fetch ?? fetch
    this.openSocket = options.openSocket ?? ((url) => new WebSocket(url))
  }

  private url(path: string): URL {
    if (!this.base) {
      throw new Error('OpenCode v2 PTY requires plugin option serverUrl or OPENCODE_PTY_SERVER_URL')
    }
    const base = new URL(this.base)
    if (!base.pathname.endsWith('/')) base.pathname += '/'
    return new URL(path.replace(/^\//, ''), base)
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    extra?: HeadersInit
  ): Promise<T> {
    const headers = new Headers(extra)
    if (this.password)
      headers.set(
        'authorization',
        `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`
      )
    if (body !== undefined) headers.set('content-type', 'application/json')
    const response = await this.send(this.url(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(
        `OpenCode PTY ${method} ${path} failed (${response.status}): ${detail.slice(0, 500)}`
      )
    }
    if (response.status === 204) return undefined as T
    const data = (await response.json()) as unknown
    if (typeof data === 'object' && data !== null && 'data' in data) return data.data as T
    return data as T
  }

  list(sessionID: string, signal?: AbortSignal) {
    return this.request<NativePtyInfo[]>(
      'GET',
      `api/experimental/session/${encodeURIComponent(sessionID)}/terminal`,
      undefined,
      signal
    )
  }

  create(
    sessionID: string,
    input: {
      command: string
      args: string[]
      cwd?: string
      title: string
      env: Record<string, string>
    },
    signal?: AbortSignal
  ) {
    return this.request<NativePtyInfo>(
      'POST',
      `api/experimental/session/${encodeURIComponent(sessionID)}/terminal`,
      input,
      signal
    )
  }

  get(id: string, signal?: AbortSignal) {
    return this.request<NativePtyInfo>(
      'GET',
      `api/experimental/persistent-pty/${encodeURIComponent(id)}`,
      undefined,
      signal
    )
  }

  snapshot(id: string, signal?: AbortSignal) {
    return this.request<NativePtySnapshot>(
      'GET',
      `api/experimental/persistent-pty/${encodeURIComponent(id)}/snapshot`,
      undefined,
      signal
    )
  }

  remove(id: string, signal?: AbortSignal) {
    return this.request<void>(
      'DELETE',
      `api/experimental/persistent-pty/${encodeURIComponent(id)}`,
      undefined,
      signal
    )
  }

  async write(id: string, data: string, signal?: AbortSignal): Promise<void> {
    const info = await this.get(id, signal)
    if (info.status !== 'running') throw new Error(`Cannot write to exited PTY ${id}`)
    const token = await this.request<{ ticket: string }>(
      'POST',
      `api/experimental/persistent-pty/${encodeURIComponent(id)}/connect-token`,
      undefined,
      signal,
      { 'x-opencode-ticket': '1' }
    )
    const url = this.url(`api/experimental/persistent-pty/${encodeURIComponent(id)}/connect`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('ticket', token.ticket)
    url.searchParams.set('role', 'controller')
    url.searchParams.set('cursor', '0')
    url.searchParams.set('input_ack', '1')
    const socket = this.openSocket(url.toString())
    await new Promise<void>((resolve, reject) => {
      let done = false
      let sent = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: Error) => {
        if (done) return
        done = true
        if (timeout) clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
        socket.close()
        if (error) reject(error)
        else resolve()
      }
      const abort = () => finish(new Error('PTY write aborted'))
      timeout = setTimeout(
        () => finish(new Error('PTY WebSocket input acknowledgement timed out')),
        10_000
      )
      signal?.addEventListener('abort', abort, { once: true })
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        let message: { type?: string; role?: string }
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }
        if (message.type === 'input_ack') {
          if (sent) finish()
          return
        }
        if (message.type !== 'attached' || sent) return
        if (message.role !== 'controller')
          return finish(new Error('PTY connection did not obtain control'))
        try {
          socket.send(data)
          sent = true
        } catch (error) {
          finish(error as Error)
        }
      })
      socket.addEventListener('error', () => finish(new Error('PTY WebSocket failed')))
      socket.addEventListener('close', () =>
        finish(new Error('PTY WebSocket closed before input acknowledgement'))
      )
      if (signal?.aborted) abort()
    })
  }
}
