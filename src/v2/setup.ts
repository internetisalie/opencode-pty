import { ExitMonitor } from './exit-monitor.ts'
import type { ExitClock, ExitDiagnostic } from './exit-runtime.ts'
import type { NativePtyOptions } from './native.ts'
import { NativePtyClient } from './native.ts'
import { nativeTools } from './tools.ts'
import type { PluginContextV2 } from './types.ts'

export interface PluginSetupOptions {
  readonly fetch?: NativePtyOptions['fetch']
  readonly clock?: ExitClock
  readonly report?: (diagnostic: ExitDiagnostic) => void
}

export async function setupPtyPlugin(
  ctx: PluginContextV2,
  options?: PluginSetupOptions
): Promise<() => Promise<void>> {
  const client = new NativePtyClient({
    serverUrl: ctx.options.serverUrl ?? process.env.OPENCODE_PTY_SERVER_URL,
    password: ctx.options.serverPassword ?? process.env.OPENCODE_SERVER_PASSWORD,
    fetch: options?.fetch,
  })
  const monitor = new ExitMonitor({
    client,
    synthetic: (input) => ctx.session.synthetic(input),
    clock: options?.clock,
    report: options?.report,
  })
  let registration: { dispose(): Promise<void> }
  try {
    registration = await ctx.tool.transform((draft) => {
      for (const tool of nativeTools(client, monitor)) draft.add(tool)
    })
  } catch (error) {
    try {
      await monitor.dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'PTY setup and cleanup failed')
    }
    throw error
  }
  return pluginCleanup(monitor, registration)
}

function pluginCleanup(
  monitor: ExitMonitor,
  registration: { dispose(): Promise<void> }
): () => Promise<void> {
  let pending: Promise<void> | undefined
  return function cleanup(): Promise<void> {
    if (pending) return pending
    const settlement = Promise.withResolvers<void>()
    pending = settlement.promise
    const monitorWork = monitor.dispose()
    const toolWork = Promise.resolve().then(() => registration.dispose())
    Promise.allSettled([monitorWork, toolWork]).then((results) => {
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason)
      if (errors.length) settlement.reject(new AggregateError(errors, 'PTY plugin cleanup failed'))
      else settlement.resolve()
    })
    return pending
  }
}
