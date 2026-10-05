import { ExitMonitor } from './exit-monitor.ts'
import type { ExitClock, ExitDiagnostic } from './exit-runtime.ts'
import type { NativePtyOptions } from './native.ts'
import { NativePtyClient } from './native.ts'
import type { RegistrationStore } from './registration-store.ts'
import { fileRegistrationStore } from './registration-store.ts'
import { serverKey, sharedMonitor } from './shared-monitor.ts'
import { nativeTools } from './tools.ts'
import type { PluginContextV2, PtyExitAdmission } from './types.ts'

export interface PluginSetupOptions {
  readonly fetch?: NativePtyOptions['fetch']
  readonly clock?: ExitClock
  readonly report?: (diagnostic: ExitDiagnostic) => void
  readonly store?: RegistrationStore
  /** A monitor of this instance alone, disposed with it. Production shares one monitor per server. */
  readonly private?: boolean
}

export async function setupPtyPlugin(
  ctx: PluginContextV2,
  options?: PluginSetupOptions
): Promise<() => Promise<void>> {
  const serverUrl = ctx.options.serverUrl ?? process.env.OPENCODE_PTY_SERVER_URL
  const client = new NativePtyClient({
    serverUrl,
    password: ctx.options.serverPassword ?? process.env.OPENCODE_SERVER_PASSWORD,
    fetch: options?.fetch,
  })
  const shared = serverUrl !== undefined && options?.private !== true
  const monitor = shared
    ? sharedMonitor(
        serverKey(serverUrl),
        () =>
          new ExitMonitor({
            client,
            // Over the server's API, not this instance's session service: the instance can be disposed
            // while the watch lives on, and the API rebuilds the session's location when it delivers.
            synthetic: (input) => client.synthetic(input) as Promise<PtyExitAdmission>,
            clock: options?.clock,
            report: options?.report,
            store: options?.store ?? fileRegistrationStore(serverKey(serverUrl)),
            pruneSettled: true,
          })
      )
    : new ExitMonitor({
        client,
        synthetic: (input) => ctx.session.synthetic(input),
        clock: options?.clock,
        report: options?.report,
        store: options?.store,
      })
  // A shared monitor outlives this instance and is left alone by its cleanup.
  const release = (): Promise<void> => (shared ? Promise.resolve() : monitor.dispose())
  let registration: { dispose(): Promise<void> }
  try {
    registration = await ctx.tool.transform((draft) => {
      for (const tool of nativeTools(client, monitor)) draft.add(tool)
    })
  } catch (error) {
    try {
      await release()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'PTY setup and cleanup failed')
    }
    throw error
  }
  return pluginCleanup(release, registration)
}

function pluginCleanup(
  release: () => Promise<void>,
  registration: { dispose(): Promise<void> }
): () => Promise<void> {
  let pending: Promise<void> | undefined
  return function cleanup(): Promise<void> {
    if (pending) return pending
    const settlement = Promise.withResolvers<void>()
    pending = settlement.promise
    const monitorWork = release()
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
