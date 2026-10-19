// SKILL.md discovery shared by the pi and dsh backends.
//
// Mirrors both agents' own discovery: a directory containing SKILL.md is a
// skill root; otherwise we recurse into subdirectories to find SKILL.md
// (skipping dot-dirs and node_modules). name/description come from YAML
// frontmatter, falling back to the directory name.

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { basename, join } from "node:path"
import type { SkillInfo } from "../types"

export function scanSkills(dirs: string[]): SkillInfo[] {
  const skills: SkillInfo[] = []
  const seen = new Set<string>()
  for (const dir of dirs) scanDir(dir, skills, seen)
  return skills
}

function scanDir(dir: string, out: SkillInfo[], seen: Set<string>): void {
  if (!existsSync(dir)) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    pushSkill(join(dir, "SKILL.md"), out, seen)
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue
    if (!entry.isDirectory()) continue
    scanDir(join(dir, entry.name), out, seen)
  }
}

function pushSkill(file: string, out: SkillInfo[], seen: Set<string>): void {
  if (seen.has(file)) return
  seen.add(file)
  let content: string
  try {
    content = readFileSync(file, "utf8")
  } catch {
    return
  }
  const fm = parseSkillFrontmatter(content)
  const name = fm.name ?? basename(join(file, ".."))
  if (!fm.description) return
  out.push({ name, description: fm.description, location: file, content })
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith("---")) return {}
  const end = content.indexOf("\n---", 3)
  if (end === -1) return {}
  const block = content.slice(3, end)
  const line = (key: string) => {
    const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined
  }
  const description = (() => {
    const m = block.match(/^description:\s*(\S.*)$/m)
    if (!m) return undefined
    const first = m[1].trim()
    if (first !== ">" && first !== "|") return first.replace(/^["']|["']$/g, "")
    // Folded/literal block: collect indented lines until the next top-level key.
    const rest = block.slice(m.index! + m[0].length)
    const lines = rest.split("\n").filter((l) => l.startsWith("  ") || l.startsWith("\t"))
    const joined = lines.map((l) => l.trim()).filter(Boolean).join(" ")
    return joined || undefined
  })()
  return { name: line("name"), description }
}
