// Backend-neutral management types shared by the extension host and the
// webview. These describe the opencode management surface (providers, agents,
// skills, MCP, commands) that the opencode backend exposes directly. The dsh
// backend does not implement these — its capabilities are all false and the
// webview hides the corresponding tabs.
//
// Like model.ts, keep this file free of `vscode` imports.

export type ProviderInfo = {
  id: string
  name?: string
  models?: Record<string, { id: string; name?: string }>
  source?: "env" | "config" | "custom" | "api"
  env?: readonly string[]
  options?: Record<string, unknown>
  key?: string
}

export type ProviderListResult = {
  all: ProviderInfo[]
  connected: string[]
  default: Record<string, string>
}

export type AgentInfo = {
  name: string
  description?: string
  builtIn?: boolean
  mode?: "primary" | "subagent" | "all"
  hidden?: boolean
}

export type CommandInfo = {
  name: string
  description?: string
  source?: string
  template?: string
  hints?: string[]
}

export type SkillInfo = {
  name: string
  description?: string
  location: string
  content: string
}

export type McpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "configured" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string }

export type RunCommandInput = {
  sessionID: string
  command: string
  arguments: string
  messageID?: string
  agent?: string
  model?: string
}
