import { setupPtyPlugin } from './setup.ts'
import type { PluginV2 } from './types.ts'

export * from './native.ts'
export * from './tools.ts'
export * from './types.ts'

/** OpenCode v2 adapter backed by the host's native persistent PTY service. */
export const Plugin: PluginV2 = {
  id: 'opencode-pty',
  setup: setupPtyPlugin,
}

export default Plugin
