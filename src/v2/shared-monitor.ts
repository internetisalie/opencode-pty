import type { ExitMonitor } from './exit-monitor.ts'

// Held on globalThis: the host can evaluate this module again for each plugin instance (a local-path
// plugin is not cached across instances), and every copy must still find the one monitor.
const KEY = Symbol.for('opencode-pty.shared-monitors')
const registry = globalThis as typeof globalThis & { [KEY]?: Map<string, ExitMonitor> }
const monitors = registry[KEY] ?? new Map<string, ExitMonitor>()
registry[KEY] = monitors

/** The same server under any of its spellings (`localhost`, trailing slash, default port) is one server; a path prefix makes another. */
export function serverKey(serverUrl: string): string {
  const url = new URL(serverUrl)
  const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}${path}`
}

/**
 * The one monitor of an OpenCode server in this process. A terminal outlives the plugin instances the host
 * disposes while idle and rebuilds on demand, so its watch belongs to the process and delivers over the
 * server's own API; instances only expose the tools.
 */
export function sharedMonitor(key: string, make: () => ExitMonitor): ExitMonitor {
  const existing = monitors.get(key)
  if (existing) return existing
  const created = make()
  monitors.set(key, created)
  created.adopt()
  return created
}

/** Disposes every shared monitor; the plugin never calls this, tests do. */
export async function resetSharedMonitors(): Promise<void> {
  const all = [...monitors.values()]
  monitors.clear()
  await Promise.allSettled(all.map((monitor) => monitor.dispose()))
}
