// Best-effort discovery of already-running agent backends on this machine.
//
// The extension hosts opencode / dsh / pi as child processes it spawns itself,
// but those processes can also be started out-of-band (CLI, another window, a
// previous extension session that crashed before cleanup). The Settings tab
// lists what's actually alive so the user can see which backend a switch would
// attach to. This is purely informational — it never sends signals.
//
// Matching is deliberately conservative: we key off command-line signatures
// that are unique to each product rather than the short bin names (`dsh`,
// `pi`), which would false-positive on unrelated processes.

import { execFileSync } from "node:child_process"
import type { BackendProcessInfo } from "../api"
import type { BackendKind } from "./index"

export function scanRunningBackends(): BackendProcessInfo[] {
  let lines: string[]
  try {
    lines = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).split("\n")
  } catch {
    return []
  }

  const found: BackendProcessInfo[] = []
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match) continue
    const pid = Number(match[1])
    const args = match[2].trim()
    if (pid === process.pid) continue
    const kind = detectKind(args)
    if (!kind) continue
    const port = Number(args.match(/--port[= ](\d+)/)?.[1]) || undefined
    const hostname = args.match(/--hostname[= ](\S+)/)?.[1]
    found.push({ kind, pid, port, hostname, label: describe(kind, args) })
  }
  return found
}

function detectKind(args: string): BackendKind | undefined {
  if (/\bopencode\b/.test(args) && /\bserve\b/.test(args)) return "opencode"
  if (/deepseek-harness/.test(args) || /--profile[= ]acp/.test(args)) return "dsh"
  // pi rewrites its own process title to bare "pi" at startup, dropping the
  // `--mode rpc` flags, so match the exact title as well as the raw args.
  if (/pi-coding-agent/.test(args) || /--mode[= ]rpc/.test(args) || args === "pi") return "pi"
  return undefined
}

function describe(kind: BackendKind, args: string): string {
  const port = args.match(/--port[= ](\d+)/)?.[1]
  if (kind === "opencode") return port ? `opencode serve (port ${port})` : "opencode serve"
  const profile = args.match(/--profile[= ](\S+)/)?.[1]
  if (kind === "dsh") return profile ? `dsh --profile ${profile}` : "dsh"
  if (kind === "pi") return "pi (rpc)"
  return args.length > 80 ? `${args.slice(0, 80)}…` : args
}
