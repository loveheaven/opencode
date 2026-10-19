// Backend client used by the webview.
//
// Replaces sdk.ts::OpencodeClient. Instead of reaching the opencode HTTP API
// through the extension-host proxy, it issues `backend.rpc` calls (dispatched
// by the host against the selected Backend) and receives NeutralUpdate pushes
// plus responses. The webview therefore never sees opencode Part objects or
// ACP SessionUpdate objects — only the neutral model from model.ts/types.ts.
//
// All types here come from model.ts / types.ts, so a single client drives
// both the opencode and dsh backends. Methods that only opencode implements
// simply reject (or return empty) when running on dsh; the host guards them
// by capability before the UI renders them.

import type {
  Message,
  NeutralUpdate,
  PermissionRequest,
  QuestionRequest,
  Session,
} from "../model"
import type {
  AgentInfo,
  CommandInfo,
  McpStatus,
  ProviderInfo,
  ProviderListResult,
  RunCommandInput,
  SkillInfo,
} from "../types"
import type { BackendStatus, PromptInput } from "../backend"
import type { BackendRpcResult } from "../api"

export type PostMessage = (msg: unknown) => void

type Pending = {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
}

export class BackendClient {
  private readonly pending = new Map<string, Pending>()
  private seq = 0
  private updateHandlers = new Set<(u: NeutralUpdate) => void>()
  private statusHandlers = new Set<(s: BackendStatus) => void>()

  constructor(private readonly postMessage: PostMessage) {}

  /** Host → webview dispatch. main.ts forwards every extension message here. */
  handleMessage(msg: unknown): boolean {
    if (!msg || typeof msg !== "object") return false
    const m = msg as { type: string }
    if (m.type === "backend.result") {
      const r = msg as BackendRpcResult
      const pending = this.pending.get(r.id)
      if (!pending) return true
      this.pending.delete(r.id)
      if (r.ok) pending.resolve(r.data)
      else pending.reject(new Error(r.error ?? "backend error"))
      return true
    }
    if (m.type === "backend.update") {
      const update = (msg as { update: NeutralUpdate }).update
      for (const h of this.updateHandlers) h(update)
      return true
    }
    if (m.type === "backend.status") {
      const status = (msg as { status: BackendStatus }).status
      for (const h of this.statusHandlers) h(status)
      return true
    }
    return false
  }

  onUpdate(handler: (u: NeutralUpdate) => void): () => void {
    this.updateHandlers.add(handler)
    return () => this.updateHandlers.delete(handler)
  }

  onStatus(handler: (s: BackendStatus) => void): () => void {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  private rpc<T>(method: string, args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.seq += 1
      const id = `rpc_${Date.now().toString(36)}_${this.seq}`
      this.pending.set(id, {
        resolve: (data) => resolve(data as T),
        reject,
      })
      this.postMessage({ type: "backend.rpc", id, method, args })
    })
  }

  // ---- core conversation (every backend) ----

  listSessions(): Promise<Session[]> {
    return this.rpc<Session[]>("listSessions", [])
  }

  createSession(input?: { title?: string }): Promise<Session> {
    return this.rpc<Session>("createSession", [input])
  }

  getMessages(sessionID: string): Promise<Message[]> {
    return this.rpc<Message[]>("getMessages", [sessionID])
  }

  prompt(input: PromptInput): Promise<void> {
    return this.rpc<void>("prompt", [input])
  }

  abort(sessionID: string): Promise<void> {
    return this.rpc<void>("abort", [sessionID])
  }

  // ---- opencode management surface (rejects on dsh) ----

  deleteSession(sessionID: string): Promise<boolean> {
    return this.rpc<boolean>("deleteSession", [sessionID])
  }

  updateSession(sessionID: string, patch: { title?: string }): Promise<Session> {
    return this.rpc<Session>("updateSession", [sessionID, patch])
  }

  compactSession(sessionID: string, providerID: string, modelID: string): Promise<boolean> {
    return this.rpc<boolean>("compactSession", [sessionID, providerID, modelID])
  }

  respondPermission(sessionID: string, permissionID: string, response: "once" | "always" | "reject"): Promise<boolean> {
    return this.rpc<boolean>("respondPermission", [sessionID, permissionID, response])
  }

  listPermissions(): Promise<PermissionRequest[]> {
    return this.rpc<PermissionRequest[]>("listPermissions", [])
  }

  listQuestions(): Promise<QuestionRequest[]> {
    return this.rpc<QuestionRequest[]>("listQuestions", [])
  }

  replyQuestion(sessionID: string, requestID: string, answers: string[][]): Promise<boolean> {
    return this.rpc<boolean>("replyQuestion", [sessionID, requestID, answers])
  }

  rejectQuestion(sessionID: string, requestID: string): Promise<boolean> {
    return this.rpc<boolean>("rejectQuestion", [sessionID, requestID])
  }

  listAgents(): Promise<AgentInfo[]> {
    return this.rpc<AgentInfo[]>("listAgents", [])
  }

  listCommands(): Promise<CommandInfo[]> {
    return this.rpc<CommandInfo[]>("listCommands", [])
  }

  listSkills(): Promise<SkillInfo[]> {
    return this.rpc<SkillInfo[]>("listSkills", [])
  }

  getMcpStatus(): Promise<Record<string, McpStatus>> {
    return this.rpc<Record<string, McpStatus>>("getMcpStatus", [])
  }

  mcpConnect(name: string): Promise<void> {
    return this.rpc<void>("mcpConnect", [name])
  }

  mcpDisconnect(name: string): Promise<void> {
    return this.rpc<void>("mcpDisconnect", [name])
  }

  listProviders(): Promise<ProviderInfo[]> {
    return this.rpc<ProviderInfo[]>("listProviders", [])
  }

  getProviderList(): Promise<ProviderListResult> {
    return this.rpc<ProviderListResult>("getProviderList", [])
  }

  runCommand(input: RunCommandInput): Promise<void> {
    return this.rpc<void>("runCommand", [input])
  }
}
