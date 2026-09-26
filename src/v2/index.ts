import { NativePtyClient } from './native.ts'
import { nativeTools } from './tools.ts'
import type { PluginContextV2, PluginV2 } from './types.ts'

export * from './native.ts'
export * from './tools.ts'
export * from './types.ts'

/** OpenCode v2 adapter backed by the host's native persistent PTY service. */
export const Plugin: PluginV2 = {
  id: 'opencode-pty',
  setup: async (ctx: PluginContextV2) => {
    const client = new NativePtyClient({
      serverUrl: ctx.options.serverUrl ?? process.env.OPENCODE_PTY_SERVER_URL,
      password: ctx.options.serverPassword ?? process.env.OPENCODE_SERVER_PASSWORD,
    })
    const registration = await ctx.tool.transform((draft) => {
      for (const tool of nativeTools(client)) draft.add(tool)
    })
    return () => registration.dispose()
  },
}

export default Plugin
