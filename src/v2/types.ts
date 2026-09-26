export interface OpencodePtyOptions {
  /** URL of this OpenCode v2 server. Required because the v2 plugin host exposes only terminal.read. */
  serverUrl?: string
  /** OpenCode server password. OPENCODE_SERVER_PASSWORD is used when omitted. */
  serverPassword?: string
}

export interface ToolContextV2 {
  readonly sessionID: string
  readonly agent: string
  readonly signal: AbortSignal
}

export interface ToolInfoV2 {
  readonly name: string
  readonly description: string
  readonly input: Record<string, unknown>
  readonly options?: { readonly permission?: string }
  // The V2 host validates `input` against the JSON schema before dispatch; each tool has its own shape.
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool registrations erase the validated input type here.
  readonly execute: (input: any, context: ToolContextV2) => Promise<{ readonly content: string }>
}

export interface PluginContextV2 {
  readonly options: OpencodePtyOptions & Record<string, unknown>
  readonly tool: {
    transform(
      callback: (draft: { add(tool: ToolInfoV2): void }) => void
    ): Promise<{ dispose(): Promise<void> }>
  }
}

export interface PluginV2 {
  readonly id: string
  readonly setup: (
    context: PluginContextV2
  ) => Promise<(() => Promise<void>) | void> | (() => Promise<void>) | void
}
