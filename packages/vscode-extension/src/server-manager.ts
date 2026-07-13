import * as vscode from "vscode"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import * as net from "node:net"
import * as fs from "node:fs"
import * as path from "node:path"
import * as http from "node:http"
import { URL } from "node:url"

export type ServerStatus =
  | { state: "idle" }
  | { state: "starting"; url: string }
  | { state: "ready"; url: string }
  | { state: "error"; message: string }

export class ServerManager implements vscode.Disposable {
  private proc: ChildProcess | undefined
  private status: ServerStatus = { state: "idle" }
  private readonly emitter = new vscode.EventEmitter<ServerStatus>()
  private readonly output: vscode.OutputChannel
  private stopping = false

  readonly onStatusChanged = this.emitter.event

  constructor(output: vscode.OutputChannel) {
    this.output = output
  }

  getStatus(): ServerStatus {
    return this.status
  }

  getUrl(): string | undefined {
    return this.status.state === "ready" || this.status.state === "starting" ? this.status.url : undefined
  }

  async ensureRunning(): Promise<ServerStatus> {
    if (this.status.state === "ready") return this.status
    if (this.status.state === "starting") {
      const url = this.status.url
      const ready = await waitForReady(url, 20000)
      this.setStatus(ready ? { state: "ready", url } : { state: "error", message: `Server did not become ready at ${url}` })
      return this.status
    }
    return this.start()
  }

  async start(): Promise<ServerStatus> {
    await this.stop()

    // Prefer a deterministic port derived from the current workspace path.
    // Same-workspace reload gets the same port so cookies/localStorage stick.
    const preferred = preferredPort()
    const preferredSeed = portSeed()

    // Reap only servers occupying THIS workspace's preferred port. Anything
    // else on the machine — including opencode servers spawned by a sibling
    // VSCode window opened on a different workspace — is left alone. Without
    // this narrowing, reap used to sweep every `opencode serve` / `bun run
    // src/index.ts serve` on the host, which killed the sibling window's
    // live session mid-stream. See git history for the previous broad match.
    await reapStrayServersOnPort(preferred, this.output)

    const port = await pickPort(preferred)
    const url = `http://127.0.0.1:${port}`

    // Resolve HOW to launch opencode. Order:
    //  1. `opencode` CLI on PATH (or well-known install dirs) — production path;
    //     works on Remote-SSH hosts where the user just `npm i -g opencode`.
    //  2. `bun run ./src/index.ts serve` from an opencode source checkout —
    //     developer path; picks up local edits without a build step.
    //  3. If neither exists, offer to install via `npm i -g opencode`.
    const launcher = await this.resolveLauncher(port)
    if (!launcher) return this.status // status already set to error

    this.output.appendLine(`[opencode-ext] Starting opencode server`)
    this.output.appendLine(`  mode: ${launcher.mode}`)
    this.output.appendLine(`  bin:  ${launcher.command}`)
    if (launcher.cwd) this.output.appendLine(`  cwd:  ${launcher.cwd}`)
    this.output.appendLine(`  port: ${port} (preferred=${preferred}, seed="${preferredSeed}")`)

    let child: ChildProcess
    try {
      // detached: true puts the child in its own process group so we can signal
      // the entire tree (bun run → bun serve, plus any grandchildren) via
      // process.kill(-pid). Without this, SIGTERM only reaches the top-level
      // wrapper and the actual server keeps holding the port on the next reload.
      child = spawn(launcher.command, launcher.args, {
        cwd: launcher.cwd,
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD ?? "" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setStatus({ state: "error", message: `Failed to spawn ${launcher.mode}: ${message}` })
      return this.status
    }

    this.proc = child
    this.stopping = false
    this.setStatus({ state: "starting", url })

    child.stdout?.on("data", (chunk: Buffer) => this.output.append(chunk.toString()))
    child.stderr?.on("data", (chunk: Buffer) => this.output.append(chunk.toString()))
    child.on("exit", (code, signal) => {
      const wasStopping = this.stopping
      this.stopping = false
      this.proc = undefined
      this.output.appendLine(`[opencode-ext] server exited (code=${code}, signal=${signal})`)
      if (!wasStopping) {
        this.setStatus({
          state: "error",
          message: `opencode server exited unexpectedly (code=${code}${signal ? `, signal=${signal}` : ""}). See “OpenCode” output for details.`,
        })
      }
    })
    child.on("error", (error) => {
      const enoent = (error as NodeJS.ErrnoException).code === "ENOENT"
      const detail = enoent
        ? `${launcher.command} not found. ${launcher.mode === "opencode-cli" ? "Install opencode (npm i -g opencode) or set opencode.serverMode=spawn-source with a repo checkout." : "Install bun (https://bun.sh) or set opencode.bunPath."}`
        : error.message
      this.output.appendLine(`[opencode-ext] spawn error: ${detail}`)
      this.setStatus({ state: "error", message: `Server process error: ${detail}` })
    })

    const ready = await waitForReady(url, 30000)
    if (ready) {
      this.setStatus({ state: "ready", url })
    } else if (this.status.state !== "error") {
      this.setStatus({ state: "error", message: `Server did not become ready at ${url} within 30s` })
    }
    return this.status
  }

  async stop(): Promise<void> {
    const child = this.proc
    if (!child) {
      if (this.status.state !== "idle" && this.status.state !== "error") this.setStatus({ state: "idle" })
      return
    }
    this.stopping = true
    this.proc = undefined
    const pid = child.pid
    this.output.appendLine(`[opencode-ext] stopping server pid=${pid ?? "?"}`)
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      child.once("exit", finish)
      killTree(pid, "SIGTERM", this.output)
      setTimeout(() => {
        if (done) return
        killTree(pid, "SIGKILL", this.output)
      }, 3000)
      setTimeout(finish, 5000)
    })
    this.setStatus({ state: "idle" })
  }

  dispose(): void {
    // dispose() runs during extension deactivation. We can't await here, but we
    // must at least send the kill signal synchronously so the OS reaps the tree
    // even if the extension host exits before the async settle completes.
    const child = this.proc
    if (child) {
      const pid = child.pid
      this.output.appendLine(`[opencode-ext] dispose: killing server tree pid=${pid ?? "?"}`)
      killTree(pid, "SIGTERM", this.output)
      // Give it a beat then hard-kill as a fallback.
      setTimeout(() => killTree(pid, "SIGKILL", this.output), 500).unref()
    }
    this.proc = undefined
    this.emitter.dispose()
  }

  private setStatus(next: ServerStatus) {
    this.status = next
    this.emitter.fire(next)
  }

  // Decide which command to spawn. Returns undefined AFTER setting an error
  // status (with a helpful message) when nothing suitable is available and
  // the user declines to install.
  private async resolveLauncher(port: number): Promise<Launcher | undefined> {
    const commonArgs = ["serve", "--port", String(port), "--hostname", "127.0.0.1"]
    const cfg = vscode.workspace.getConfiguration("opencode")
    const forced = (cfg.get<string>("launcher", "auto") || "auto").trim() // auto | cli | source

    // A user-provided repo path always wins for "source" mode.
    const repoRoot = forced === "cli" ? undefined : findRepoRoot(this.output)

    // 1. opencode CLI (unless the user explicitly forced source mode).
    if (forced !== "source") {
      const cli = await resolveOpencodeCli(this.output)
      if (cli) {
        return { mode: "opencode-cli", command: cli, args: commonArgs, cwd: undefined }
      }
      if (forced === "cli") {
        // Explicitly asked for CLI but it's not there — offer to install.
        const installed = await this.offerInstallOpencode()
        if (installed) {
          const after = await resolveOpencodeCli(this.output)
          if (after) return { mode: "opencode-cli", command: after, args: commonArgs, cwd: undefined }
        }
        this.setStatus({
          state: "error",
          message:
            "opencode CLI not found on PATH. Install it with `npm install -g opencode` on the machine running the extension host, or set `opencode.launcher` to `source` and provide `opencode.repoPath`.",
        })
        return undefined
      }
    }

    // 2. Source checkout via bun (developer mode).
    if (repoRoot) {
      const bun = resolveBunPath(this.output)
      const opencodeDir = path.join(repoRoot, "packages", "opencode")
      return {
        mode: "bun-source",
        command: bun,
        cwd: opencodeDir,
        args: ["run", "--conditions=browser", "./src/index.ts", ...commonArgs],
      }
    }

    // 3. Nothing worked. Offer to install opencode CLI as a last resort.
    const installed = await this.offerInstallOpencode()
    if (installed) {
      const after = await resolveOpencodeCli(this.output)
      if (after) return { mode: "opencode-cli", command: after, args: commonArgs, cwd: undefined }
    }
    this.setStatus({
      state: "error",
      message:
        "opencode is not installed. Install with `npm install -g opencode` (recommended) or open the opencode repo in this workspace / set `opencode.repoPath`.",
    })
    return undefined
  }

  // Prompt the user to `npm i -g opencode`. Runs the install synchronously
  // and streams output to the OpenCode channel. Returns whether install
  // succeeded (or at least completed with exit 0).
  private async offerInstallOpencode(): Promise<boolean> {
    const npm = await resolveNpm(this.output)
    if (!npm) {
      vscode.window.showErrorMessage(
        "OpenCode: npm is not installed on the extension host. Install Node.js/npm first, then retry.",
      )
      return false
    }
    const choice = await vscode.window.showInformationMessage(
      "opencode CLI is not installed. Install it now with `npm install -g opencode`?",
      { modal: true },
      "Install",
    )
    if (choice !== "Install") return false

    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Installing opencode (npm i -g)…", cancellable: false },
      () =>
        new Promise<boolean>((resolve) => {
          this.output.appendLine(`[opencode-ext] Running: ${npm} install -g opencode`)
          const proc = spawn(npm, ["install", "-g", "opencode"], { stdio: ["ignore", "pipe", "pipe"] })
          proc.stdout?.on("data", (c: Buffer) => this.output.append(c.toString()))
          proc.stderr?.on("data", (c: Buffer) => this.output.append(c.toString()))
          proc.on("exit", (code) => {
            const ok = code === 0
            if (!ok) {
              vscode.window.showErrorMessage(
                `opencode install failed (exit ${code}). If this is EACCES, run \`sudo npm i -g opencode\` in a terminal, then retry.`,
              )
            }
            resolve(ok)
          })
          proc.on("error", (err) => {
            this.output.appendLine(`[opencode-ext] npm spawn error: ${err.message}`)
            resolve(false)
          })
        }),
    )
  }
}

type Launcher = {
  mode: "opencode-cli" | "bun-source"
  command: string
  args: string[]
  cwd: string | undefined
}

function findRepoRoot(output?: vscode.OutputChannel): string | undefined {
  const configured = vscode.workspace.getConfiguration("opencode").get<string>("repoPath", "").trim()
  const seeds: string[] = []
  if (configured) seeds.push(configured)

  const folders = vscode.workspace.workspaceFolders
  if (folders) {
    for (const f of folders) {
      seeds.push(f.uri.fsPath)
      // Additionally seed each immediate child directory. This lets us find
      // an opencode source checkout when the user has opened a *parent* of
      // the checkout as their VSCode workspace — a common layout is
      // `~/projects` opened at the top level with `~/projects/opencode`
      // (or similar) inside. Without this, findRepoRoot would only walk
      // upward from the workspace folder and miss the checkout entirely,
      // and with no CLI on PATH the extension falls back to "server is
      // not ready" instead of spawning via bun-source. Silent on
      // EACCES/ENOENT because permission-denied on a top-level workspace
      // is common and shouldn't spam the log.
      try {
        for (const entry of fs.readdirSync(f.uri.fsPath, { withFileTypes: true })) {
          if (entry.isDirectory()) seeds.push(path.join(f.uri.fsPath, entry.name))
        }
      } catch {
        // ignore
      }
    }
  }

  const activeUri = vscode.window.activeTextEditor?.document?.uri
  if (activeUri && activeUri.scheme === "file") seeds.push(path.dirname(activeUri.fsPath))

  // The extension itself lives in <repo>/packages/vscode-extension when running from source
  // or inside the VSCode extensions cache when installed as .vsix. Only the source case helps.
  try {
    seeds.push(__dirname)
  } catch {
    // ignore
  }

  const tried: string[] = []
  const seen = new Set<string>()
  for (const start of seeds) {
    if (!start) continue
    let dir = start
    for (let i = 0; i < 10; i++) {
      if (seen.has(dir)) break
      seen.add(dir)
      tried.push(dir)
      if (isRepoRoot(dir)) {
        output?.appendLine(`[opencode-ext] Located repo root: ${dir}`)
        return dir
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  if (output) {
    output.appendLine(
      `[opencode-ext] No opencode source checkout found nearby (this is fine when using the installed opencode CLI).`,
    )
  }
  return undefined
}

function isRepoRoot(dir: string): boolean {
  try {
    const pkg = path.join(dir, "packages", "opencode", "package.json")
    if (!fs.existsSync(pkg)) return false
    const raw = fs.readFileSync(pkg, "utf8")
    const parsed = JSON.parse(raw)
    return parsed?.name === "opencode"
  } catch {
    return false
  }
}

// FNV-1a 32-bit; deterministic and dependency-free. We only need a stable
// spread over a small port range per workspace path, not cryptographic quality.
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function portSeed(): string {
  const folders = vscode.workspace.workspaceFolders
  return folders && folders.length > 0 ? folders[0].uri.fsPath : (process.env.HOME ?? "opencode-vscode")
}

function preferredPort(): number {
  const configured = vscode.workspace.getConfiguration("opencode").get<number>("port", 0)
  if (configured && Number.isFinite(configured) && configured > 0 && configured < 65536) return Math.floor(configured)

  // Map to 41000..49999 to avoid collisions with common dev ports (3000/4096/8080/…).
  const span = 9000
  return 41000 + (fnv1a(portSeed()) % span)
}

function tryListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", () => resolve(false))
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true))
    })
  })
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address()
      if (typeof address === "object" && address && "port" in address) {
        const port = address.port
        srv.close(() => resolve(port))
        return
      }
      srv.close()
      reject(new Error("Could not obtain free port"))
    })
  })
}

async function pickPort(preferred: number): Promise<number> {
  if (await tryListen(preferred)) return preferred
  return findFreePort()
}

function waitForReady(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  return new Promise((resolve) => {
    const attempt = () => {
      // Short per-attempt budget during spawn readiness polling — the server
      // is local, so anything slower than ~800ms per probe means it's not
      // actually up yet and we should keep looping until timeoutMs runs out.
      // Distinct from probeOnce's default (3s) which is used for external
      // attach where the far side may be behind a proxy/tunnel.
      probeOnce(url, 800).then((ok) => {
        if (ok) return resolve(true)
        if (Date.now() - start > timeoutMs) return resolve(false)
        setTimeout(attempt, 300)
      })
    }
    attempt()
  })
}

// Exported so extension.ts can reuse this on the external-mode fast-path
// (attach if the configured URL responds, otherwise fall back to spawn).
// The check is intentionally lenient: any HTTP status < 500 counts as
// "someone is listening", because opencode's root path may 404 for
// unauthenticated GETs but the port is clearly held.
//
// The internal waitForReady() loop calls this repeatedly with a short per-
// attempt budget so an unresponsive port fails quickly during startup.
// The external-mode fast-path in extension.ts only calls probeOnce once,
// so it needs to be lenient enough that a real (but slower) server on the
// far side isn't misclassified as "gone" — e.g. an opencode server sitting
// behind mitmproxy / a Cloudflare tunnel can easily take >1s to complete
// the first GET / round-trip. Default is picked to be comfortably above
// that while still failing fast when nothing is listening.
export function probeOnce(url: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      resolve(false)
      return
    }
    const req = http.request(
      {
        method: "GET",
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: "/",
        timeout: timeoutMs,
      },
      (res) => {
        res.resume()
        const status = res.statusCode ?? 0
        resolve(status >= 200 && status < 500)
      },
    )
    req.on("timeout", () => {
      req.destroy()
      resolve(false)
    })
    req.on("error", () => resolve(false))
    req.end()
  })
}

// Extra install directories to probe when a binary isn't on PATH. VSCode
// launched from Finder/Dock (macOS) or as a systemd unit (Linux) inherits a
// stripped PATH that typically omits Homebrew, ~/.bun/bin, and volta/nvm
// shims. We union those with $PATH before giving up.
function extraSearchDirs(): string[] {
  const home = process.env.HOME
  const dirs: string[] = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
  if (home) {
    dirs.push(
      path.join(home, ".bun", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".nvm", "versions", "node"), // handled specially below when needed
      path.join(home, ".local", "bin"),
      path.join(home, "n", "bin"),
    )
  }
  return dirs
}

function findBinary(name: string, output?: vscode.OutputChannel): string | undefined {
  const explicit = process.env.PATH?.split(path.delimiter) ?? []
  for (const dir of [...explicit, ...extraSearchDirs()]) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile()) {
        output?.appendLine(`[opencode-ext] Found ${name} at ${candidate}`)
        return candidate
      }
    } catch {
      // not found here, keep looking
    }
  }
  return undefined
}

async function resolveOpencodeCli(output?: vscode.OutputChannel): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration("opencode").get<string>("opencodePath", "").trim()
  if (configured) {
    if (fs.existsSync(configured)) return configured
    output?.appendLine(`[opencode-ext] opencode.opencodePath="${configured}" does not exist; falling back to auto-detect.`)
  }
  return findBinary("opencode", output)
}

async function resolveNpm(output?: vscode.OutputChannel): Promise<string | undefined> {
  return findBinary("npm", output)
}

// VSCode launched from Finder/Dock inherits a stripped PATH that usually
// omits Homebrew (/opt/homebrew/bin) and ~/.bun/bin, so a bare `"bun"` spawn
// fails with ENOENT — surfacing to the webview as "Failed to fetch" because
// no server ever comes up. Probe well-known install locations before giving
// up so the extension works out of the box.
function resolveBunPath(output?: vscode.OutputChannel): string {
  const explicit = vscode.workspace.getConfiguration("opencode").get<string>("bunPath", "").trim()
  if (explicit) return explicit

  const candidates = [
    process.env.HOME ? path.join(process.env.HOME, ".bun", "bin", "bun") : undefined,
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
    "/usr/bin/bun",
  ].filter((p): p is string => typeof p === "string")

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        output?.appendLine(`[opencode-ext] Using bun at ${candidate}`)
        return candidate
      }
    } catch {
      // ignore
    }
  }
  output?.appendLine(`[opencode-ext] Could not resolve bun in standard locations; falling back to PATH lookup ("bun"). Set opencode.bunPath if this fails.`)
  return "bun"
}

// Kill the child and any descendants. We spawn with `detached: true` so the
// child becomes the leader of its own process group and its pid can be used as
// a negative pgid to signal every descendant. Falls back to signaling the pid
// directly if the negative-pid path fails (unlikely on Unix, but harmless).
function killTree(pid: number | undefined, signal: NodeJS.Signals, output?: vscode.OutputChannel) {
  if (!pid) return
  try {
    process.kill(-pid, signal)
    return
  } catch (err) {
    output?.appendLine(`[opencode-ext] killTree(-${pid}, ${signal}) failed: ${(err as Error).message}`)
  }
  try {
    process.kill(pid, signal)
  } catch (err) {
    output?.appendLine(`[opencode-ext] killTree(${pid}, ${signal}) failed: ${(err as Error).message}`)
  }
}

// Kill previously-orphaned opencode dev servers that are holding OUR
// workspace's preferred port. Two things could leave one behind:
//
//   • `bun run ./src/index.ts` loses its subprocess tree when the extension
//     host crashes without running `dispose()` — the exec'd child gets
//     reparented to init with a different pgid and keeps holding the port.
//   • A prior `restartServer` command that failed to fully teardown.
//
// This is intentionally scoped to the target port (this workspace's
// preferredPort) so that a sibling VSCode window running a completely
// different workspace — which will have picked a different preferredPort
// via fnv1a(workspaceFolder) — is never touched. The old implementation
// swept every `opencode serve` / `bun ... src/index.ts serve` on the host
// and killed the sibling window's live session mid-stream.
//
// The identity check is two-step: (1) find the pid listening on `port`,
// (2) verify its command line looks like one of our spawns before killing.
async function reapStrayServersOnPort(port: number, output: vscode.OutputChannel) {
  if (process.platform === "win32") return
  const pids = pidsListeningOnPort(port, output)
  if (pids.length === 0) return

  const victims: number[] = []
  for (const pid of pids) {
    if (!Number.isFinite(pid) || pid === process.pid) continue
    const cmd = commandForPid(pid, output)
    if (!cmd) continue
    // Match either launch mode our extension might have spawned:
    //   • bun-source: `bun run --conditions=browser ./src/index.ts serve ...`
    //   • opencode-cli: `opencode serve ...` (installed binary)
    // Both include `serve --port` and `--hostname 127.0.0.1`, which is a
    // strong signal it's ours and not the user's own opencode invocation.
    const isSourceMode = cmd.includes("src/index.ts serve") && cmd.includes("--conditions=browser")
    const isCliMode = /\bopencode\s+serve\b/.test(cmd) && cmd.includes("--hostname 127.0.0.1")
    if (!isSourceMode && !isCliMode) {
      output.appendLine(`[opencode-ext] reap: pid=${pid} occupies port ${port} but is not an opencode server (cmd: ${cmd}); leaving it alone.`)
      continue
    }
    victims.push(pid)
  }
  if (victims.length === 0) return
  output.appendLine(`[opencode-ext] reap: killing ${victims.length} orphan opencode server(s) on port ${port}: ${victims.join(", ")}`)
  for (const pid of victims) killTree(pid, "SIGTERM", output)
  await new Promise((resolve) => setTimeout(resolve, 400))
  for (const pid of victims) {
    try {
      process.kill(pid, 0)
      killTree(pid, "SIGKILL", output)
    } catch {
      // already gone
    }
  }
}

// Find PIDs listening on a TCP port. Prefer `lsof -ti` (portable across
// macOS/Linux, ships in most base images). Fall back to `ss -H -Ktlnp` on
// Linux if lsof is missing. Returns empty on failure; a stale server that
// happens to be undetectable just means we won't clean it up automatically.
function pidsListeningOnPort(port: number, output: vscode.OutputChannel): number[] {
  const pids = new Set<number>()

  // lsof: "-t" pid-only, "-i" internet sockets, "-sTCP:LISTEN" listeners only.
  // "-P -n" skip name resolution for speed. "@127.0.0.1:PORT" pins the
  // interface too since we always bind loopback.
  try {
    const out = execFileSync("lsof", ["-tiTCP@127.0.0.1:" + port, "-sTCP:LISTEN", "-P", "-n"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    for (const line of out.split("\n")) {
      const n = Number(line.trim())
      if (Number.isFinite(n) && n > 0) pids.add(n)
    }
    if (pids.size > 0) return [...pids]
  } catch {
    // lsof missing or returned non-zero (also happens when nothing matches
    // — lsof exits 1 in that case). Fall through to ss.
  }

  // ss -Htlnp: header-less TCP LISTEN sockets with process info. The pid
  // is embedded like `users:(("opencode",pid=12345,fd=7))`.
  try {
    const out = execFileSync("ss", ["-Htlnp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    for (const line of out.split("\n")) {
      // Local address column contains `127.0.0.1:<port>`.
      if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`)) continue
      const match = /pid=(\d+)/.exec(line)
      if (!match) continue
      const n = Number(match[1])
      if (Number.isFinite(n) && n > 0) pids.add(n)
    }
  } catch (err) {
    output.appendLine(`[opencode-ext] reap: no lsof/ss available; skipping port ${port} reap: ${(err as Error).message}`)
  }
  return [...pids]
}

// Read /proc/<pid>/cmdline on Linux, fall back to `ps -o command=` elsewhere.
// Returns the joined command line, or undefined if the pid is gone or
// unreadable (permission-denied on foreign UIDs is common; we just skip).
function commandForPid(pid: number, output: vscode.OutputChannel): string | undefined {
  if (process.platform === "linux") {
    try {
      // /proc/<pid>/cmdline uses NUL as arg separator.
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")
      const joined = raw.replace(/\0+$/, "").split("\0").join(" ").trim()
      if (joined) return joined
    } catch {
      // fall through to ps
    }
  }
  try {
    const out = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    const trimmed = out.trim()
    return trimmed || undefined
  } catch (err) {
    output.appendLine(`[opencode-ext] reap: cannot read command for pid=${pid}: ${(err as Error).message}`)
    return undefined
  }
}
