import type { ExitMonitor } from './exit-monitor.ts'
import type { ExitEnrollment } from './exit-runtime.ts'
import type { NativePtyClient, NativePtyInfo } from './native.ts'
import type { ToolContextV2, ToolInfoV2 } from './types.ts'

const string = { type: 'string' }
const integer = { type: 'integer', minimum: 0 }
const bool = { type: 'boolean' }
const input = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

function text(content: string) {
  return { content }
}

function decodeInput(value: string): string {
  return value.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[nrt\\])/g, (match, code: string) => {
    if (code.startsWith('x') || code.startsWith('u')) {
      return String.fromCharCode(Number.parseInt(code.slice(1), 16))
    }
    return code === 'n'
      ? '\n'
      : code === 'r'
        ? '\r'
        : code === 't'
          ? '\t'
          : code === '\\'
            ? '\\'
            : match
  })
}

async function owned(
  client: NativePtyClient,
  id: string,
  ctx: ToolContextV2
): Promise<NativePtyInfo> {
  const info = await client.get(id, ctx.signal)
  if (info.sessionID !== ctx.sessionID) throw new Error(`PTY ${id} does not belong to this session`)
  return info
}

function lines(content: string, offset = 0, limit = 500, pattern?: string, ignoreCase?: boolean) {
  if (offset < 0 || limit < 1 || limit > 5000)
    throw new Error('offset must be nonnegative and limit must be 1 to 5000')
  let all = content.split(/\r?\n/)
  if (pattern) {
    if (pattern.length > 256) throw new Error('pattern must be at most 256 characters')
    const regex = new RegExp(pattern, ignoreCase ? 'i' : '')
    all = all.filter((line) => regex.test(line))
  }
  return { total: all.length, value: all.slice(offset, offset + limit).join('\n') }
}

function spawnNotificationLine(enrollment: ExitEnrollment | undefined): string {
  return enrollment?.status === 'registered'
    ? `Exit notification: ${enrollment.notificationID}. Exit monitoring is activation-local; plugin/server restart loses opt-in and uncertain retry state.`
    : 'Exit monitoring unavailable; PTY retained, no notification promised.'
}

export function nativeTools(client: NativePtyClient, monitor?: ExitMonitor): ToolInfoV2[] {
  return [
    {
      name: 'pty_spawn',
      description: 'Start a native persistent OpenCode terminal for this session.',
      input: input(
        {
          command: string,
          args: { type: 'array', items: string },
          workdir: string,
          env: { type: 'object', additionalProperties: string },
          title: string,
          description: string,
          notifyOnExit: bool,
          notifyOnOutput: bool,
        },
        ['command', 'args', 'description']
      ),
      options: { permission: 'pty_spawn' },
      async execute(
        args: {
          command: string
          args: string[]
          workdir?: string
          env?: Record<string, string>
          title?: string
          description: string
          notifyOnExit?: boolean
          notifyOnOutput?: boolean
        },
        ctx
      ) {
        const sessionID = ctx.sessionID
        const info = await client.create(
          sessionID,
          {
            command: args.command,
            args: args.args,
            cwd: args.workdir,
            env: args.env ?? {},
            title: args.title ?? args.description,
          },
          ctx.signal
        )
        let content = `<pty_spawned>\nID: ${info.id}\nTitle: ${info.title}\nStatus: ${info.status}\nPID: ${info.pid}\n</pty_spawned>`
        if (args.notifyOnExit === true || args.notifyOnOutput === true) {
          if (typeof info.id !== 'string' || !info.id || info.sessionID !== sessionID) {
            throw new Error('created PTY identity mismatch')
          }
          const enrollment = monitor?.register({
            ptyID: info.id,
            sessionID,
            notifyOnExit: args.notifyOnExit === true,
            notifyOnOutput: args.notifyOnOutput === true,
          })
          if (args.notifyOnExit === true)
            content += `\n${spawnNotificationLine(enrollment)}\nExit monitoring retires after bounded missing/incomplete observations or settled admission failures; diagnostics report non-delivery or unconfirmed admission.`
          if (args.notifyOnOutput === true)
            content +=
              enrollment?.status === 'registered'
                ? '\nOutput notifications observe sampled native cursor advances while running; monitoring is activation-local.'
                : '\nOutput monitoring unavailable; PTY retained, no notification promised.'
        }
        return text(content)
      },
    },
    {
      name: 'pty_write',
      description: 'Send input to a native persistent terminal owned by this session.',
      input: input({ id: string, data: string }, ['id', 'data']),
      options: { permission: 'pty_write' },
      async execute(args: { id: string; data: string }, ctx) {
        await owned(client, args.id, ctx)
        await client.write(args.id, decodeInput(args.data), ctx.signal)
        return text(`Sent ${args.data.length} characters to PTY ${args.id}`)
      },
    },
    {
      name: 'pty_read',
      description:
        'Read a native persistent terminal snapshot. Offset and limit apply to snapshot lines.',
      input: input(
        { id: string, offset: integer, limit: integer, pattern: string, ignoreCase: bool },
        ['id']
      ),
      async execute(
        args: {
          id: string
          offset?: number
          limit?: number
          pattern?: string
          ignoreCase?: boolean
        },
        ctx
      ) {
        await owned(client, args.id, ctx)
        const snapshot = await client.snapshot(args.id, ctx.signal)
        const selected = lines(
          snapshot.text,
          args.offset,
          args.limit,
          args.pattern,
          args.ignoreCase
        )
        return text(
          `<pty_output id="${args.id}" status="${snapshot.info.status}">\n${selected.value}\n(${selected.total} snapshot lines)\n</pty_output>`
        )
      },
    },
    {
      name: 'pty_list',
      description: 'List native persistent terminals belonging to this session.',
      input: input({}),
      async execute(_args, ctx) {
        const items = await client.list(ctx.sessionID, ctx.signal)
        return text(
          `<pty_list>\n${items.map((item) => `${item.id} ${item.status} ${item.title}`).join('\n')}\n</pty_list>`
        )
      },
    },
    {
      name: 'pty_kill',
      description: 'Terminate and remove a native persistent terminal owned by this session.',
      input: input({ id: string }, ['id']),
      options: { permission: 'pty_kill' },
      async execute(args: { id: string }, ctx) {
        await owned(client, args.id, ctx)
        await client.remove(args.id, ctx.signal)
        return text(`Removed PTY ${args.id}`)
      },
    },
  ]
}
