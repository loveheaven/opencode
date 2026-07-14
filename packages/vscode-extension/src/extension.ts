import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as http from "node:http"
import { URL } from "node:url"
import { ServerManager, identifyOpencode, probeOnce, type ServerStatus } from "./server-manager"
import type { AttachmentPayload, BootstrapMessage, ExtensionMessage, WebviewRequest } from "./api"
import { pathToFileURL } from "node:url"

const VIEW_ID = "opencode.chat"
// Key used to persist the debug logging flag across sessions via
// context.globalState. When true, proxyHttp / proxySseOpen dump the full
// request and response payloads (headers + body) to the OpenCode output
// channel so users can inspect what the webview and the opencode server
// are actually exchanging.
const DEBUG_LOG_KEY = "opencode.debugLog"
// Remembers the URL of the last opencode server we successfully talked to,
// regardless of whether the extension spawned it or the user pointed us at
// an already-running one. On next activation resolveServerUrlWithFallback()
// probes this URL first (via ServerManager.start(preferredUrl) and
// identifyOpencode) and reuses it if it's still an opencode server. This is
// what makes "the extension attaches to the same host:port next time it
// starts" work across VSCode restarts and reloads. Stored in globalState so
// it's shared across workspaces — pick one running server and every window
// finds it.
const LAST_SERVER_URL_KEY = "opencode.lastServerUrl"
// Cap for logged bodies. Prompt/streaming responses can be many megabytes;
// truncating keeps the output panel responsive while still surfacing enough
// to reproduce most bugs.
const DEBUG_MAX_BODY_LEN = 32 * 1024

let provider: OpencodeViewProvider | undefined
let serverManager: ServerManager | undefined
let output: vscode.OutputChannel | undefined

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("OpenCode")
  context.subscriptions.push(output)

  const version = (context.extension.packageJSON as { version?: string }).version ?? "unknown"
  output.appendLine(`[opencode-ext] activate v${version} at ${new Date().toISOString()}`)
  output.appendLine(`[opencode-ext]   workspaceFolders: ${(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath).join(", ") || "(none)"}`)

  serverManager = new ServerManager(output)
  context.subscriptions.push(serverManager)

  provider = new OpencodeViewProvider(context, serverManager, output)

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    serverManager.onStatusChanged((status) => provider?.onServerStatus(status)),
    vscode.window.onDidChangeActiveColorTheme(() => provider?.onThemeChanged()),
    vscode.commands.registerCommand("opencode.open", () => revealView()),
    vscode.commands.registerCommand("opencode.newSession", () => provider?.postToWebview({ type: "newSession" } as never)),
    vscode.commands.registerCommand("opencode.showSessions", () => provider?.postToWebview({ type: "showSessions" } as never)),
    vscode.commands.registerCommand("opencode.reload", () => provider?.reload()),
    vscode.commands.registerCommand("opencode.restartServer", () => provider?.restartServer()),
    vscode.commands.registerCommand("opencode.showLogs", () => output?.show(true)),
    // Single entry point into the tab-based settings overlay inside the chat
    // panel. Chat state stays intact behind it; user closes to return.
    // Defaults to the MCP tab — most common thing users want to see/toggle.
    vscode.commands.registerCommand("opencode.showSettings", () => provider?.showSettings("mcp")),
    // Right-click entries. Signatures follow VSCode's conventions:
    //   explorer/context: (uri, allUris) — allUris carries every item when
    //     the user multi-selected before right-clicking.
    //   editor/context:   (uri) — the active editor's document URI.
    //   editor/title/context: (uri) — the tab whose title was clicked.
    // We accept both shapes and fall back to the active editor if invoked
    // from the palette with no arguments.
    vscode.commands.registerCommand("opencode.addToChat", (uri?: vscode.Uri, allUris?: vscode.Uri[]) =>
      provider?.addToChat(pickUris(uri, allUris), undefined),
    ),
    vscode.commands.registerCommand("opencode.addSelectionToChat", (uri?: vscode.Uri) => {
      const editor = vscode.window.activeTextEditor
      const targetUri = uri ?? editor?.document.uri
      if (!targetUri) return
      const selection = editor?.selection && !editor.selection.isEmpty ? editor.selection : undefined
      provider?.addToChat([targetUri], selection)
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("opencode")) provider?.reload()
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider?.reload()),
  )
}

export function deactivate() {
  provider = undefined
  serverManager = undefined
  output = undefined
}

function getConfig() {
  return vscode.workspace.getConfiguration("opencode")
}

function getWorkspaceDirectory(): string | undefined {
  const folders = vscode.workspace.workspaceFolders
  if (!folders || folders.length === 0) return undefined
  return folders[0].uri.fsPath
}

async function revealView() {
  await vscode.commands.executeCommand("workbench.view.extension.opencode")
  await vscode.commands.executeCommand(`${VIEW_ID}.focus`)
}

function themeKind(): BootstrapMessage["themeKind"] {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return "light"
    case vscode.ColorThemeKind.HighContrast:
    case vscode.ColorThemeKind.HighContrastLight:
      return "high-contrast"
    default:
      return "dark"
  }
}

type ActiveSource = "spawned" | "reattached" | "external"

class OpencodeViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private lastServerUrl: string | undefined
  // How the current lastServerUrl was resolved. Cleared on spawn errors,
  // updated by resolveServerUrlWithFallback and onServerStatus. Settings
  // uses it to label the "Currently talking to …" badge honestly.
  private activeSource: ActiveSource | undefined

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly server: ServerManager,
    private readonly output: vscode.OutputChannel,
  ) {}

  // ---- Debug logging ----------------------------------------------------
  //
  // The extension host is the only place that can see the raw HTTP traffic
  // between the webview and the opencode server (the webview's fetch calls
  // are proxied through proxyHttp / proxySseOpen). When the user flips the
  // Debug toggle in the Settings tab, we start writing full request lines,
  // headers, and response bodies to the OpenCode output channel.

  private isDebugEnabled(): boolean {
    return this.context.globalState.get<boolean>(DEBUG_LOG_KEY, false) === true
  }

  private async setDebugEnabled(enabled: boolean) {
    await this.context.globalState.update(DEBUG_LOG_KEY, enabled)
    if (enabled) this.output.appendLine(`[opencode-ext] debug logging ENABLED at ${new Date().toISOString()}`)
    else this.output.appendLine(`[opencode-ext] debug logging disabled at ${new Date().toISOString()}`)
    // Confirm to the webview so the toggle reflects the persisted state.
    this.view?.webview.postMessage({ type: "debugState", enabled })
  }

  private debugLog(lines: readonly string[]) {
    if (!this.isDebugEnabled()) return
    for (const line of lines) this.output.appendLine(line)
  }

  onServerStatus(status: ServerStatus): void {
    if (!this.view) return
    if (status.state === "ready") {
      this.lastServerUrl = status.url
      // Fire-and-forget: persist the newly-live URL so next start reattaches.
      void this.setLastServerUrl(status.url)
      void this.sendBootstrap()
      return
    }
    if (status.state === "error") {
      this.view.webview.postMessage({ type: "serverError", message: status.message })
    }
  }

  onThemeChanged(): void {
    this.view?.webview.postMessage({ type: "themeChanged", themeKind: themeKind() } satisfies ExtensionMessage)
  }

  postToWebview(message: unknown): void {
    this.view?.webview.postMessage(message)
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview")],
    }

    webviewView.webview.onDidReceiveMessage((raw: unknown) => this.onWebviewMessage(raw))
    webviewView.onDidDispose(() => {
      for (const [id] of this.sseStreams) this.proxySseClose(id)
      if (this.view === webviewView) this.view = undefined
    })

    // Resolve server URL BEFORE building HTML so CSP connect-src includes the loopback origin.
    // Without this, the meta CSP tag is baked with empty connect-src and every fetch/SSE is blocked.
    this.lastServerUrl = await this.resolveServerUrlWithFallback()

    webviewView.webview.html = await this.buildHtml(webviewView.webview)
    void this.sendBootstrap()
  }

  async reload(): Promise<void> {
    if (!this.view) return
    this.lastServerUrl = await this.resolveServerUrlWithFallback({ preferCachedSpawn: true })
    this.view.webview.html = await this.buildHtml(this.view.webview)
    void this.sendBootstrap()
  }

  // Central "which URL should the webview talk to?" decision. Called from
  // resolveWebviewView() and reload() so both paths behave identically.
  //
  // Policy: reattach if we can, spawn if we can't.
  //   1. Cache: if this session already has a ready server via
  //      ServerManager, and the caller opted into cache reuse, return that
  //      URL. Prevents gratuitous restarts on unrelated config changes.
  //   2. Reattach: probe the last URL we successfully connected to
  //      (globalState). If /doc identifies it as opencode, reuse it.
  //   3. Spawn: start a fresh local server via ServerManager.
  //
  // Whichever URL we end up on gets written back to globalState so the
  // *next* start has something to reattach to.
  private async resolveServerUrlWithFallback(opts?: { preferCachedSpawn?: boolean }): Promise<string | undefined> {
    if (opts?.preferCachedSpawn) {
      const cached = this.server.getStatus()
      if (cached.state === "ready") return cached.url
    }

    const lastUrl = this.getLastServerUrl()
    if (lastUrl) {
      this.output.appendLine(`[opencode-ext] probing last-known server ${lastUrl}`)
      if (await identifyOpencode(lastUrl)) {
        this.output.appendLine(`[opencode-ext] reattached to ${lastUrl}`)
        // Seed ServerManager status too, so getStatus() reflects the
        // reattached URL (settings display + reload() cache depend on it).
        const status = await this.server.ensureRunning(lastUrl)
        if (status.state === "ready") {
          this.activeSource = "reattached"
          await this.setLastServerUrl(status.url)
          return status.url
        }
      } else {
        this.output.appendLine(`[opencode-ext] last-known ${lastUrl} not opencode (or gone); spawning`)
      }
    }

    const status = await this.server.ensureRunning()
    if (status.state === "ready") {
      this.activeSource = "spawned"
      await this.setLastServerUrl(status.url)
      return status.url
    }
    this.activeSource = undefined
    return undefined
  }

  private getLastServerUrl(): string | undefined {
    const raw = this.context.globalState.get<string>(LAST_SERVER_URL_KEY)
    if (!raw) return undefined
    const trimmed = raw.trim().replace(/\/+$/, "")
    if (!trimmed) return undefined
    try {
      // Reject anything that doesn't parse as a URL so a corrupted state
      // (e.g. from an older extension version that stored a different
      // shape) can't wedge us into an infinite failure loop.
      new URL(trimmed)
      return trimmed
    } catch {
      return undefined
    }
  }

  private async setLastServerUrl(url: string): Promise<void> {
    const clean = url.trim().replace(/\/+$/, "")
    const prev = this.context.globalState.get<string>(LAST_SERVER_URL_KEY)
    if (prev === clean) return
    await this.context.globalState.update(LAST_SERVER_URL_KEY, clean)
    this.output.appendLine(`[opencode-ext] remembered last server URL: ${clean}`)
  }

  // Public entry so extension commands can jump straight into the config
  // editor without going through the webview.
  async openConfig(section: ConfigSection): Promise<void> {
    await this.openOpencodeConfig(section)
  }

  // Open the settings overlay inside the chat webview. `tab` selects the
  // initial tab (mcp / skills / plugins). Reveals the chat view first so
  // the overlay lands on top of a visible panel.
  async showSettings(tab: "mcp" | "skills" | "plugins" | "settings"): Promise<void> {
    await revealView()
    // Ensure server is up so the panel's fetches work; also lets the
    // webview receive the bootstrap before we ask it to render settings.
    // Uses the same reattach-or-spawn policy as startup.
    if (!this.lastServerUrl) {
      this.lastServerUrl = await this.resolveServerUrlWithFallback()
    }
    this.view?.webview.postMessage({ type: "showSettings", tab })
  }

  // Right-click handler: turn a list of file/dir URIs (+ optional selection)
  // into opencode `file` parts and hand them to the webview to stage as
  // pending attachments. We construct `file://…?start=…&end=…` URLs — server
  // parses those to slice files by line, expand directories, etc. See
  // packages/opencode/src/session/prompt.ts resolvePart.
  async addToChat(uris: vscode.Uri[], selection: vscode.Selection | undefined): Promise<void> {
    if (uris.length === 0) return
    const workspaceRoot = getWorkspaceDirectory()
    const attachments: AttachmentPayload[] = []
    for (const uri of uris) {
      if (uri.scheme !== "file") continue
      try {
        const stat = await vscode.workspace.fs.stat(uri)
        const isDir = (stat.type & vscode.FileType.Directory) !== 0
        const abs = uri.fsPath
        const rel = workspaceRoot && abs.startsWith(workspaceRoot)
          ? abs.slice(workspaceRoot.length).replace(/^[/\\]/, "")
          : abs
        // Only apply selection when we have exactly one file target — using
        // the same selection across multiple picks makes no sense.
        const useSelection = !isDir && uris.length === 1 && selection && !selection.isEmpty
        const startLine = useSelection ? selection!.start.line + 1 : undefined
        const endLine = useSelection ? selection!.end.line + 1 : undefined
        const url = fileUrlWithRange(abs, startLine, endLine)
        const hint = isDir
          ? `${rel || abs}/`
          : useSelection
            ? `${rel || abs}:${startLine}-${endLine}`
            : rel || abs
        attachments.push({
          filename: hint,
          mime: isDir ? "application/x-directory" : "text/plain",
          url,
          hint,
        })
      } catch (err) {
        vscode.window.showWarningMessage(`OpenCode: cannot attach ${uri.fsPath}: ${(err as Error).message}`)
      }
    }
    if (attachments.length === 0) return
    // Make sure the chat panel is showing so the user actually sees the
    // attachments strip fill up.
    await revealView()
    // Give the webview a moment to become visible (revealView is async but
    // postMessage before the DOM binds can be lost). We keep it opportunistic
    // — main.ts also processes late messages once bootstrap completes.
    this.view?.webview.postMessage({ type: "addAttachments", attachments } satisfies ExtensionMessage)
  }

  // "Restart Server" always spawns a brand-new local server, no matter what
  // we were previously connected to. If the current connection is a reused
  // external one we have no handle on the process and cannot kill it — but
  // starting our own gives the user a working panel immediately. The newly
  // spawned URL then becomes the remembered "last URL".
  async restartServer(): Promise<void> {
    const status = await this.server.start()
    if (status.state === "ready") {
      this.lastServerUrl = status.url
      this.activeSource = "spawned"
      await this.setLastServerUrl(status.url)
      // Re-render the webview so CSP connect-src picks up the new origin
      // and every existing SSE stream re-opens against the fresh server.
      await this.reload()
    }
  }

  private async sendBootstrap() {
    if (!this.view || !this.lastServerUrl) return
    const directory = getWorkspaceDirectory() ?? ""
    const msg: BootstrapMessage = {
      type: "bootstrap",
      serverUrl: this.lastServerUrl,
      directory,
      defaultAgent: getConfig().get<string>("defaultAgent", "").trim(),
      defaultModel: getConfig().get<string>("defaultModel", "").trim(),
      themeKind: themeKind(),
    }
    this.view.webview.postMessage(msg)
  }

  private async buildHtml(webview: vscode.Webview): Promise<string> {
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview")
    const htmlPath = vscode.Uri.joinPath(distRoot, "index.html").fsPath
    let template: string
    try {
      template = await fs.readFile(htmlPath, "utf8")
    } catch (err) {
      this.output.appendLine(`[opencode-ext] failed to read webview html: ${(err as Error).message}`)
      return `<html><body style="color:var(--vscode-errorForeground);padding:16px;font-family:var(--vscode-font-family)">Webview bundle missing. Run <code>bun run build</code> in packages/vscode-extension.</body></html>`
    }
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, "main.js"))
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, "styles.css"))
    const nonce = randomNonce()
    // Loopback opencode server is trusted; we spawn it ourselves. Allow the currently-known
    // origin plus every 127.0.0.1/localhost port so that reconnects after port changes still work.
    // Without listing loopback wildcards the meta CSP baked at HTML build time silently
    // blocks every fetch/EventSource once the server URL changes (permission buttons no-op).
    const serverOrigin = this.lastServerUrl ? new URL(this.lastServerUrl).origin : ""
    const wsOrigin = serverOrigin.replace(/^http/, "ws")
    const loopback = [
      "http://127.0.0.1:*",
      "http://localhost:*",
      "ws://127.0.0.1:*",
      "ws://localhost:*",
    ]
    const connectSources = [serverOrigin, wsOrigin, ...loopback].filter(Boolean).join(" ")
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `connect-src ${connectSources}`,
      `font-src ${webview.cspSource} data:`,
    ].join("; ")
    return template
      .replaceAll("__CSP__", csp)
      .replaceAll("__NONCE__", nonce)
      .replaceAll("__SCRIPT__", scriptUri.toString())
      .replaceAll("__STYLE__", styleUri.toString())
  }

  private readonly sseStreams = new Map<string, http.ClientRequest>()

  private async onWebviewMessage(raw: unknown) {
    if (!raw || typeof raw !== "object") return
    const msg = raw as WebviewRequest & { type: string }
    switch (msg.type) {
      case "openFile":
        await this.openFile(msg as WebviewRequest & { type: "openFile" })
        return
      case "showDiff":
        await this.showDiff(msg as WebviewRequest & { type: "showDiff" })
        return
      case "showMessage":
        this.showMessage(msg as WebviewRequest & { type: "showMessage" })
        return
      case "confirm":
        await this.handleConfirm(msg as Extract<WebviewRequest, { type: "confirm" }>)
        return
      case "input":
        await this.handleInput(msg as Extract<WebviewRequest, { type: "input" }>)
        return
      case "openProviderConfig":
        await this.openOpencodeConfig("provider")
        return
      case "openMcpConfig": {
        const req = msg as Extract<WebviewRequest, { type: "openMcpConfig" }>
        await this.openOpencodeConfig("mcp")
        // Optional server name: jump the cursor onto that entry after the
        // section anchor lands. Falls back to the mcp anchor if not found.
        if (req.name) {
          const editor = vscode.window.activeTextEditor
          if (editor) {
            const anchor = `"${req.name}"`
            const doc = editor.document
            for (let i = 0; i < doc.lineCount; i++) {
              const idx = doc.lineAt(i).text.indexOf(anchor)
              if (idx === -1) continue
              const pos = new vscode.Position(i, idx)
              editor.selection = new vscode.Selection(pos, pos)
              editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
              break
            }
          }
        }
        return
      }
      case "openPluginConfig":
        await this.openOpencodeConfig("plugin")
        return
      case "openSkillsConfig":
        await this.openOpencodeConfig("skills")
        return
      case "insertProviderConfig": {
        const req = msg as Extract<WebviewRequest, { type: "insertProviderConfig" }>
        await this.insertProviderIntoConfig(req.id, req.entry)
        return
      }
      case "saveProviderAuth": {
        const req = msg as Extract<WebviewRequest, { type: "saveProviderAuth" }>
        await this.saveProviderAuth(req.providerID, req.apiKey)
        return
      }
      case "openSkillContent": {
        const req = msg as Extract<WebviewRequest, { type: "openSkillContent" }>
        const doc = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: `<!-- Built-in skill: ${req.name} -->\n\n${req.content}`,
        })
        await vscode.window.showTextDocument(doc, { preview: true })
        return
      }
      case "httpRequest":
        this.proxyHttp(msg as Extract<WebviewRequest, { type: "httpRequest" }>)
        return
      case "sseOpen":
        this.proxySseOpen(msg as Extract<WebviewRequest, { type: "sseOpen" }>)
        return
      case "sseClose":
        this.proxySseClose((msg as Extract<WebviewRequest, { type: "sseClose" }>).id)
        return
      case "webviewReady":
        // Webview handshake — its `message` listener is now wired, so any
        // bootstrap we may have posted during resolveWebviewView() before
        // the iife finished loading was dropped by vscode-webview's async
        // transport. Re-send now. Cheap and idempotent; the webview
        // handles duplicate bootstraps by simply reinitialising.
        this.output.appendLine(`[opencode-ext] webviewReady received — (re)sending bootstrap`)
        void this.sendBootstrap()
        return
      case "getDebug":
        this.view?.webview.postMessage({ type: "debugState", enabled: this.isDebugEnabled() })
        return
      case "setDebug":
        void this.setDebugEnabled(Boolean((msg as Extract<WebviewRequest, { type: "setDebug" }>).enabled))
        return
      case "openDebugLog":
        this.output.show(true)
        return
      case "getServerConfig": {
        this.postServerConfig()
        return
      }
      case "attachToServer": {
        const req = msg as Extract<WebviewRequest, { type: "attachToServer" }>
        void this.handleAttachToServer(req.url)
        return
      }
    }
  }

  // -------------------------------------------------------------------
  // Server connection settings ("Settings → Server connection")
  // -------------------------------------------------------------------
  //
  // On startup and on user "Attach", the extension prefers a specific URL
  // and verifies it with identifyOpencode(). If verified, we record it as
  // the remembered last-server URL (globalState) and use it. If it fails,
  // we spawn a fresh local server and record that URL instead. This UI
  // just lets the user pin a preferred URL — there is no spawn/external
  // mode switch.

  private postServerConfig() {
    this.view?.webview.postMessage({
      type: "serverConfig",
      activeUrl: this.lastServerUrl,
      activeSource: this.activeSource,
    } satisfies ExtensionMessage)
  }

  private async handleAttachToServer(url: string | undefined) {
    const clean = (url ?? "").trim().replace(/\/+$/, "")
    if (!/^https?:\/\/[^\s]+:\d+$/.test(clean) && !/^https?:\/\/[^\s/:]+$/.test(clean)) {
      vscode.window.showErrorMessage(`OpenCode: invalid server URL "${url}"`)
      return
    }
    // Same policy as startup: verify it's opencode, remember it, and reload.
    // If not opencode, fall back to spawn (record the spawned URL instead).
    this.output.appendLine(`[opencode-ext] attach requested: ${clean}`)
    const identified = await identifyOpencode(clean)
    if (identified) {
      this.lastServerUrl = clean
      this.activeSource = "reattached"
      await this.setLastServerUrl(clean)
      // Also seed ServerManager status so subsequent settings queries see
      // the reattached URL and existing spawned children get dropped.
      await this.server.ensureRunning(clean)
      vscode.window.showInformationMessage(`OpenCode: attached to ${clean}`)
      await this.reload()
      return
    }
    vscode.window.showWarningMessage(
      `OpenCode: could not verify opencode at ${clean}. Spawning a local server instead.`,
    )
    const status = await this.server.start()
    if (status.state === "ready") {
      this.lastServerUrl = status.url
      this.activeSource = "spawned"
      await this.setLastServerUrl(status.url)
      await this.reload()
    }
  }

  private proxyHttp(msg: Extract<WebviewRequest, { type: "httpRequest" }>) {
    const view = this.view
    if (!view) return
    let url: URL
    try {
      url = new URL(msg.url)
    } catch (err) {
      view.webview.postMessage({ type: "httpError", id: msg.id, message: `bad url: ${(err as Error).message}` })
      return
    }
    // Debug is read at every log point (not captured once) so toggling the
    // flag mid-request still records the response. This matters because SSE
    // streams live for the whole session — capturing a boolean at open time
    // would silently drop every subsequent event.
    const started = Date.now()
    this.debugLog([
      `\n[opencode-debug] >>> HTTP ${msg.id} ${msg.method} ${msg.url}`,
      `[opencode-debug]  headers: ${JSON.stringify(msg.headers ?? {})}`,
      `[opencode-debug]  body: ${truncateForLog(msg.body)}`,
    ])
    const req = http.request(
      {
        method: msg.method,
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        headers: msg.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8")
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k] = v
            else if (Array.isArray(v)) headers[k] = v.join(",")
          }
          const status = res.statusCode ?? 0
          this.debugLog([
            `[opencode-debug] <<< HTTP ${msg.id} ${status} ${res.statusMessage ?? ""} (+${Date.now() - started}ms)`,
            `[opencode-debug]  headers: ${JSON.stringify(headers)}`,
            `[opencode-debug]  body: ${truncateForLog(body)}`,
          ])
          view.webview.postMessage({
            type: "httpResponse",
            id: msg.id,
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage ?? "",
            headers,
            body,
          })
        })
      },
    )
    req.on("error", (err) => {
      this.debugLog([`[opencode-debug] !!! HTTP ${msg.id} error: ${err.message}`])
      view.webview.postMessage({ type: "httpError", id: msg.id, message: err.message })
    })
    if (msg.body) req.write(msg.body)
    req.end()
  }

  private proxySseOpen(msg: Extract<WebviewRequest, { type: "sseOpen" }>) {
    const view = this.view
    if (!view) return
    // Close any previous stream with same id.
    this.proxySseClose(msg.id)
    let url: URL
    try {
      url = new URL(msg.url)
    } catch (err) {
      view.webview.postMessage({ type: "sseError", id: msg.id, message: `bad url: ${(err as Error).message}` })
      return
    }
    // Read the flag at every log call (not once) — the SSE stream lives for
    // the entire session, so a snapshot taken at open time would freeze the
    // "off" state and drop every subsequent event once the user toggled
    // debug on. This is why users see the outbound prompt (fresh HTTP call
    // after toggle) but not the response frames (SSE opened at bootstrap,
    // before the toggle).
    this.debugLog([
      `\n[opencode-debug] >>> SSE ${msg.id} OPEN ${msg.url}`,
      `[opencode-debug]  headers: ${JSON.stringify({ accept: "text/event-stream", ...(msg.headers ?? {}) })}`,
    ])
    const req = http.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        headers: { accept: "text/event-stream", ...(msg.headers ?? {}) },
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          this.debugLog([`[opencode-debug] !!! SSE ${msg.id} status ${res.statusCode}`])
          view.webview.postMessage({ type: "sseError", id: msg.id, message: `HTTP ${res.statusCode}` })
          req.destroy()
          this.sseStreams.delete(msg.id)
          return
        }
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headers[k] = v
          else if (Array.isArray(v)) headers[k] = v.join(",")
        }
        this.debugLog([
          `[opencode-debug] <<< SSE ${msg.id} ${res.statusCode ?? 0} ${res.statusMessage ?? ""}`,
          `[opencode-debug]  headers: ${JSON.stringify(headers)}`,
        ])
        res.setEncoding("utf8")
        let buffer = ""
        res.on("data", (chunk: string) => {
          buffer += chunk
          let idx: number
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue
              const data = line.slice(5).trimStart()
              if (!data) continue
              this.debugLog([`[opencode-debug]  SSE ${msg.id} event: ${truncateForLog(data)}`])
              view.webview.postMessage({ type: "sseEvent", id: msg.id, data })
            }
          }
        })
        res.on("end", () => {
          this.debugLog([`[opencode-debug] === SSE ${msg.id} END`])
          view.webview.postMessage({ type: "sseEnd", id: msg.id })
          this.sseStreams.delete(msg.id)
        })
        res.on("error", (err) => {
          this.debugLog([`[opencode-debug] !!! SSE ${msg.id} error: ${err.message}`])
          view.webview.postMessage({ type: "sseError", id: msg.id, message: err.message })
          this.sseStreams.delete(msg.id)
        })
      },
    )
    req.on("error", (err) => {
      this.debugLog([`[opencode-debug] !!! SSE ${msg.id} req error: ${err.message}`])
      view.webview.postMessage({ type: "sseError", id: msg.id, message: err.message })
      this.sseStreams.delete(msg.id)
    })
    req.end()
    this.sseStreams.set(msg.id, req)
  }

  private proxySseClose(id: string) {
    const req = this.sseStreams.get(id)
    if (!req) return
    this.sseStreams.delete(id)
    try {
      req.destroy()
    } catch {
      // ignore
    }
  }

  private async openFile(msg: Extract<WebviewRequest, { type: "openFile" }>) {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.path))
      const options: vscode.TextDocumentShowOptions = { preview: true }
      if (typeof msg.line === "number") {
        const line = Math.max(0, msg.line - 1)
        const column = Math.max(0, (msg.column ?? 1) - 1)
        options.selection = new vscode.Range(line, column, line, column)
      }
      await vscode.window.showTextDocument(doc, options)
    } catch (err) {
      vscode.window.showErrorMessage(`OpenCode: could not open ${msg.path}: ${(err as Error).message}`)
    }
  }

  private async showDiff(msg: Extract<WebviewRequest, { type: "showDiff" }>) {
    try {
      const scheme = "opencode-diff"
      // Register a lazy content provider once per file so vscode.diff can fetch our virtual content.
      const originalUri = vscode.Uri.parse(`${scheme}:${msg.path}?original=1&t=${Date.now()}`)
      const modifiedUri = vscode.Uri.parse(`${scheme}:${msg.path}?modified=1&t=${Date.now()}`)
      diffContent.set(originalUri.toString(), msg.original)
      diffContent.set(modifiedUri.toString(), msg.modified)
      ensureDiffProvider(this.context)
      await vscode.commands.executeCommand("vscode.diff", originalUri, modifiedUri, msg.title ?? path.basename(msg.path))
    } catch (err) {
      vscode.window.showErrorMessage(`OpenCode: diff failed: ${(err as Error).message}`)
    }
  }

  private showMessage(msg: Extract<WebviewRequest, { type: "showMessage" }>) {
    if (msg.level === "error") void vscode.window.showErrorMessage(msg.message)
    else if (msg.level === "warn") void vscode.window.showWarningMessage(msg.message)
    else void vscode.window.showInformationMessage(msg.message)
  }

  private async handleConfirm(msg: Extract<WebviewRequest, { type: "confirm" }>) {
    const view = this.view
    if (!view) return
    // Modal confirmation. Use destructive style for delete-like actions.
    const confirmLabel = msg.destructive ? "Delete" : "OK"
    const picked = await vscode.window.showWarningMessage(msg.message, { modal: true }, confirmLabel)
    view.webview.postMessage({ type: "confirmResponse", id: msg.id, result: picked === confirmLabel })
  }

  private async handleInput(msg: Extract<WebviewRequest, { type: "input" }>) {
    const view = this.view
    if (!view) return
    const value = await vscode.window.showInputBox({ prompt: msg.prompt, value: msg.defaultValue ?? "" })
    view.webview.postMessage({ type: "inputResponse", id: msg.id, value })
  }

  // Open ~/.config/opencode/opencode.jsonc so the user can add a custom
  // provider/model or MCP server. opencode server reads this file to
  // discover both — the extension can't inject them at runtime; the source of
  // truth stays with the server config. Create a scaffolded file if missing,
  // and jump the cursor near the relevant section so the user knows where to
  // edit. `section` decides which snippet the scaffold emphasises.
  private async openOpencodeConfig(section: ConfigSection) {
    const home = process.env.HOME
    if (!home) {
      vscode.window.showErrorMessage("OpenCode: cannot resolve $HOME")
      return
    }
    const configPath = path.join(home, ".config", "opencode", "opencode.jsonc")
    let created = false
    try {
      await fs.access(configPath)
    } catch {
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, configScaffold(), "utf8")
      created = true
    }

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath))
    const editor = await vscode.window.showTextDocument(doc, { preview: false })

    // Try to place the cursor at the section the user wants to configure.
    const anchor = `"${section}"`
    for (let i = 0; i < doc.lineCount; i++) {
      const line = doc.lineAt(i).text
      const idx = line.indexOf(anchor)
      if (idx === -1) continue
      const pos = new vscode.Position(i, idx)
      editor.selection = new vscode.Selection(pos, pos)
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
      break
    }

    if (created) {
      vscode.window.showInformationMessage(
        `Created opencode.jsonc with scaffold for provider / mcp / plugin / skills. Edit the ${section} section, save, then run "OpenCode: Restart Server" to apply.`,
      )
    } else if (!doc.getText().includes(anchor)) {
      vscode.window.showInformationMessage(
        `No \`${section}\` section found. Add one at the top level; see https://opencode.ai/docs for the schema.`,
      )
    }
  }

  // Inject a new `provider.<id>: {...}` entry into ~/.config/opencode/opencode.jsonc.
  //
  // We do simple text manipulation rather than round-tripping the JSONC
  // through a real parser: comments and existing formatting must survive
  // untouched, and any parser we drop in would need to re-emit whitespace
  // decisions we don't want to fight with. Approach:
  //   1. Locate `"provider": {` in the file (case-sensitive; standard key).
  //   2. If found, find its matching closing brace and insert our entry
  //      just before it (comma-safe: check whether the block is empty).
  //   3. If not found, insert a whole `"provider": { ... }` block at the
  //      top level (after the opening `{` of the root object).
  // Falls back to opening the config for manual editing on any surprise.
  private async insertProviderIntoConfig(id: string, entry: Record<string, unknown>): Promise<void> {
    const home = process.env.HOME
    if (!home) {
      vscode.window.showErrorMessage("OpenCode: cannot resolve $HOME")
      return
    }
    // Defense-in-depth: strip any plaintext apiKey from `options` before
    // touching disk. The webview form already refuses to send them, but
    // this handler is the last hop before the config file gets written,
    // so we re-validate here in case another postMessage source (a
    // future plugin, a compromised webview) tries to sneak one through.
    // Accepted apiKey values: `{env:NAME}` templates only.
    const sanitized = sanitizeProviderEntry(entry)
    if (sanitized.rejectedFields.length > 0) {
      vscode.window.showWarningMessage(
        `OpenCode: dropped ${sanitized.rejectedFields.join(", ")} — API keys must not be stored in opencode.jsonc. Use \`{env:NAME}\` or run \`opencode auth login\` after inserting.`,
      )
    }

    const configPath = path.join(home, ".config", "opencode", "opencode.jsonc")
    let created = false
    try {
      await fs.access(configPath)
    } catch {
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, configScaffold(), "utf8")
      created = true
    }

    const original = await fs.readFile(configPath, "utf8")
    const inserted = injectProviderEntry(original, id, sanitized.entry)
    if (!inserted) {
      vscode.window.showErrorMessage(
        `OpenCode: could not locate the "provider" block in opencode.jsonc; opening the file so you can add the entry manually.`,
      )
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath))
      await vscode.window.showTextDocument(doc, { preview: false })
      return
    }

    await fs.writeFile(configPath, inserted, "utf8")

    // Re-open (or refresh) the file so the user can review before restarting.
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath))
    const editor = await vscode.window.showTextDocument(doc, { preview: false })
    // Jump the cursor to the freshly-inserted entry.
    const anchor = `"${id}"`
    for (let i = 0; i < doc.lineCount; i++) {
      const idx = doc.lineAt(i).text.indexOf(anchor)
      if (idx === -1) continue
      const pos = new vscode.Position(i, idx)
      editor.selection = new vscode.Selection(pos, pos)
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
      break
    }

    vscode.window.showInformationMessage(
      `Provider "${id}" added${created ? " (config file was created)" : ""}. Review the entry, save, then run "OpenCode: Restart Server" to activate.`,
    )
  }

  // Store a provider's API key in ~/.local/share/opencode/auth.json using
  // the exact schema opencode's CLI uses (`{ [providerID]: { type: "api",
  // key: "..." } }`). Merges with existing entries — never clobbers unrelated
  // providers. File permission is locked to 0600 mode to match what
  // `opencode auth login` writes; if the file already exists with looser
  // perms we still tighten it.
  //
  // Design note: we deliberately don't wrap this in a "server API call"
  // because opencode doesn't expose an HTTP endpoint for it — the CLI's
  // `auth login` also writes the file directly. So we replicate that
  // behaviour rather than shelling out to `opencode auth login`, which
  // would require opencode to be on PATH and interactive stdin.
  private async saveProviderAuth(providerID: string, apiKey: string): Promise<void> {
    const home = process.env.HOME
    if (!home) {
      vscode.window.showErrorMessage("OpenCode: cannot resolve $HOME to locate auth.json")
      return
    }
    const trimmedID = providerID.trim().replace(/\/+$/, "")
    if (!trimmedID) {
      vscode.window.showErrorMessage("OpenCode: providerID is required to save auth.")
      return
    }
    const trimmedKey = apiKey.trim()
    if (!trimmedKey) {
      vscode.window.showErrorMessage("OpenCode: apiKey is required to save auth.")
      return
    }

    const authPath = path.join(home, ".local", "share", "opencode", "auth.json")
    let existing: Record<string, unknown> = {}
    try {
      const raw = await fs.readFile(authPath, "utf8")
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>
      }
    } catch (err: unknown) {
      // ENOENT is fine — first-time write. Anything else (permission,
      // corrupted JSON) should stop us so we don't blow away the file.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        vscode.window.showErrorMessage(
          `OpenCode: failed to read auth.json (${(err as Error).message}). Refusing to overwrite.`,
        )
        return
      }
    }

    existing[trimmedID] = { type: "api", key: trimmedKey }

    await fs.mkdir(path.dirname(authPath), { recursive: true })
    // writeFile followed by chmod, in case the file already existed with
    // group/world-readable perms — opencode's own writer uses 0600 too.
    await fs.writeFile(authPath, JSON.stringify(existing, null, 2), { mode: 0o600 })
    try {
      await fs.chmod(authPath, 0o600)
    } catch {
      // On non-POSIX filesystems chmod is a no-op; nothing to do.
    }

    vscode.window.showInformationMessage(
      `Saved API key for "${trimmedID}" to ~/.local/share/opencode/auth.json (0600). Restart the opencode server to activate.`,
    )
  }
}

type ConfigSection = "provider" | "mcp" | "plugin" | "skills"

// One scaffold to rule them all. Emits every top-level key the extension
// surfaces as a "settings" action so the user only has to uncomment and edit.
// See https://opencode.ai/docs/config for the full schema.
function configScaffold(): string {
  return `// opencode config. See https://opencode.ai/docs for the full schema.
// After editing, save and run "OpenCode: Restart Server" for opencode to
// pick up new providers / MCP servers / plugins / skills.
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    // Custom LLM providers. Duplicate this block for each provider you want.
    // After editing, click "Reload provider list" in the OpenCode model menu.
    // "my-provider": {
    //   "name": "My Provider",
    //   "npm": "@ai-sdk/openai-compatible",
    //   "options": {
    //     "baseURL": "https://api.example.com/v1",
    //     "apiKey": "{env:MY_PROVIDER_API_KEY}"
    //   },
    //   "models": {
    //     "my-model": { "name": "My Model" }
    //   }
    // }
  },
  "mcp": {
    // Local stdio MCP server (spawned as a child process).
    // "filesystem": {
    //   "type": "local",
    //   "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/allow"],
    //   "enabled": true,
    //   "environment": { "SOME_VAR": "value" }
    // },
    // Remote HTTP/SSE MCP server.
    // "context7": {
    //   "type": "remote",
    //   "url": "https://mcp.context7.com/mcp",
    //   "enabled": true,
    //   "headers": { "Authorization": "Bearer \${env:CONTEXT7_TOKEN}" }
    // }
  },
  "plugin": [
    // opencode plugins are JS modules that hook provider loading, tools, etc.
    // Reference them by npm package name or absolute path.
    // "@opencode-ai/plugin-example",
    // "/absolute/path/to/plugin/index.ts"
  ],
  "skills": {
    // Additional folders opencode should scan for SKILL.md files.
    // Skills live under <folder>/<name>/SKILL.md and get auto-attached to
    // the build agent based on their description. opencode already scans
    // ./.opencode/skills, ./.claude/skills and ./.agents/skills; only add
    // extra roots here.
    // "paths": ["/absolute/path/to/skills"]
  }
}
`
}

// Virtual content provider so we can hand vscode.diff two throwaway URIs whose
// bodies live in memory. Content is keyed by the full URI string so both sides
// of the same diff round-trip cleanly.
const diffContent = new Map<string, string>()
let diffProviderRegistered = false
function ensureDiffProvider(context: vscode.ExtensionContext) {
  if (diffProviderRegistered) return
  diffProviderRegistered = true
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent(uri) {
      return diffContent.get(uri.toString()) ?? ""
    },
  }
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("opencode-diff", provider))
}

// Normalise the args VSCode hands to context-menu commands. Explorer passes
// (clickedUri, allSelectedUris); editor context and palette pass a single
// uri (or nothing). Everything falls back to the active editor's document
// so invoking the command from the palette on an open file also works.
// Build `file:///abs/path?start=&end=` URLs the opencode server understands.
// pathToFileURL handles the abs → file:// encoding (spaces, unicode, drive
// letters on windows); we only need to attach the query params ourselves,
// since URL.searchParams stringifies them without breaking the path.
function fileUrlWithRange(absPath: string, startLine?: number, endLine?: number): string {
  const url = pathToFileURL(absPath)
  if (startLine !== undefined) url.searchParams.set("start", String(startLine))
  if (endLine !== undefined && endLine !== startLine) url.searchParams.set("end", String(endLine))
  return url.toString()
}

function pickUris(uri?: vscode.Uri, allUris?: vscode.Uri[]): vscode.Uri[] {
  if (allUris && allUris.length > 0) return allUris
  if (uri) return [uri]
  const active = vscode.window.activeTextEditor?.document.uri
  return active ? [active] : []
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""
  for (let i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

// Filter out plaintext credentials from a provider entry before it's
// written to disk. Whitelist policy for `options.apiKey`:
//
//   • `{env:NAME}` templates — kept (opencode expands at load time).
//   • Anything else, including bare `$VAR` refs — dropped, and the field
//     name is returned so the UI can surface a warning to the user.
//
// We only inspect `options` for now. If future opencode versions add more
// credential-bearing fields (headers, cookies, etc.), extend the same
// pattern here.
export function sanitizeProviderEntry(entry: Record<string, unknown>): {
  entry: Record<string, unknown>
  rejectedFields: string[]
} {
  const rejected: string[] = []
  const clone: Record<string, unknown> = { ...entry }
  const opts = clone.options
  if (opts && typeof opts === "object" && !Array.isArray(opts)) {
    const optsCopy: Record<string, unknown> = { ...(opts as Record<string, unknown>) }
    for (const [k, v] of Object.entries(optsCopy)) {
      // Fields that historically carry secrets; extend as needed. Keep the
      // list conservative — false positives here silently drop user data.
      if (k === "apiKey" || k === "api_key" || k === "token" || k === "authorization") {
        if (typeof v === "string" && /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(v.trim())) {
          continue // safe env template, keep as-is
        }
        rejected.push(`options.${k}`)
        delete optsCopy[k]
      }
    }
    clone.options = optsCopy
  }
  return { entry: clone, rejectedFields: rejected }
}

// Insert a `"<id>": <serialized-entry>` pair into the `"provider": { ... }`
// block of an opencode.jsonc file. Returns the modified source, or
// `undefined` if we couldn't confidently locate an insertion point (caller
// falls back to opening the file for manual editing).
//
// The approach is stringly-typed on purpose:
//   • jsonc-parser would drop comments if we re-serialised.
//   • Any AST-based edit would lose the user's whitespace/formatting.
// So we scan char-by-char for balanced braces, respecting string literals
// and both `//` and `/* */` comments. That's enough to find the matching
// `}` for the `provider` object without pulling in a dependency.
export function injectProviderEntry(source: string, id: string, entry: Record<string, unknown>): string | undefined {
  const providerKey = /"provider"\s*:\s*\{/g
  const match = providerKey.exec(source)
  const serialized = serialiseEntry(id, entry)

  if (match) {
    // Position right after the opening `{`.
    const openBraceIdx = match.index + match[0].length - 1
    const closeBraceIdx = findMatchingClose(source, openBraceIdx)
    if (closeBraceIdx === -1) return undefined

    const inner = source.slice(openBraceIdx + 1, closeBraceIdx)
    const hasContent = /[^\s\/][^\n]*/.test(stripLineComments(inner))
    const blockIndent = detectIndent(source, openBraceIdx)
    const indent = blockIndent + "  "
    const separator = hasContent ? "," : ""
    // If the block is single-line (`"provider": {}`) we need to push the
    // closing brace onto its own line, otherwise the result reads as
    // `"foo": {...}}` on one physical line.
    const needsTrailingNewline = !inner.includes("\n")
    const trailing = needsTrailingNewline ? `\n${blockIndent}` : ""
    const insertion = `\n${indent}${serialized.replace(/\n/g, `\n${indent}`)}${separator}${trailing}`
    return source.slice(0, openBraceIdx + 1) + insertion + source.slice(openBraceIdx + 1)
  }

  // No `provider` block found — inject a whole `"provider": { ... }` at the
  // top of the root object. We locate the root `{` as the first `{` that
  // isn't inside a comment.
  const rootIdx = findFirstBrace(source)
  if (rootIdx === -1) return undefined
  const indent = "  "
  const inner = source.slice(rootIdx + 1)
  const alreadyEmpty = /^\s*\}/.test(inner)
  const trailing = alreadyEmpty ? "" : ","
  const insertion = `\n${indent}"provider": {\n${indent}  ${serialized.replace(/\n/g, `\n${indent}  `)}\n${indent}}${trailing}`
  return source.slice(0, rootIdx + 1) + insertion + source.slice(rootIdx + 1)
}

function serialiseEntry(id: string, entry: Record<string, unknown>): string {
  const body = JSON.stringify(entry, null, 2)
  // JSON.stringify already gives us "  " indent; prefix each line so it fits
  // whatever block we're inserting into (indent is added by the caller).
  return `"${id}": ${body}`
}

// Strip line comments so we can cheaply check whether a block is "empty".
// Not exact — doesn't touch `/* … */` blocks — but good enough for the
// hasContent heuristic. The real brace-matcher below is comment-aware.
function stripLineComments(s: string): string {
  return s.replace(/\/\/[^\n]*/g, "")
}

// Detect the indentation width of the line containing `pos`. Used to indent
// the inserted entry so it lines up with sibling keys inside the block.
function detectIndent(source: string, pos: number): string {
  const lineStart = source.lastIndexOf("\n", pos - 1) + 1
  const line = source.slice(lineStart, pos)
  const match = /^\s*/.exec(line)
  return match ? match[0] : ""
}

// Format a body/payload for the debug log. Keeps it inline (single log line)
// unless it contains newlines already; truncates long payloads so the output
// panel stays usable during streaming.
function truncateForLog(body: string | undefined): string {
  if (body === undefined || body === null) return "(empty)"
  if (body === "") return "(empty)"
  if (body.length <= DEBUG_MAX_BODY_LEN) return body
  return `${body.slice(0, DEBUG_MAX_BODY_LEN)}… [truncated ${body.length - DEBUG_MAX_BODY_LEN} bytes]`
}

function findFirstBrace(source: string): number {
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i + 2)
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === "{") return i
    i++
  }
  return -1
}

// Find the `}` that matches the `{` at `openIdx`. Respects string literals
// (including escaped quotes) and both comment styles. Returns -1 if the
// braces are unbalanced (which would mean the file is broken).
function findMatchingClose(source: string, openIdx: number): number {
  let depth = 0
  let i = openIdx
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"') {
      i++
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2
          continue
        }
        if (source[i] === '"') break
        i++
      }
      i++
      continue
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i + 2)
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

