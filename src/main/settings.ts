import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'

/**
 * Settings persistence.
 *
 * A dependency-free JSON store. Writes go through a temp file and a rename so a
 * crash mid-write cannot leave a truncated settings file that bricks startup —
 * which is exactly the sort of thing that turns into a support ticket nobody
 * can reproduce.
 */

let cache: Settings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** Drops unknown keys and repairs wrong types, so a hand-edited file can't crash us. */
function coerce(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS }
  const r = raw as Record<string, unknown>
  const out: Settings = { ...DEFAULT_SETTINGS }

  if (r.theme === 'dark' || r.theme === 'light' || r.theme === 'system') out.theme = r.theme
  if (
    r.defaultBaseline === '7d' ||
    r.defaultBaseline === '30d' ||
    r.defaultBaseline === '90d' ||
    r.defaultBaseline === 'first' ||
    r.defaultBaseline === 'commit'
  ) {
    out.defaultBaseline = r.defaultBaseline
  }
  if (Array.isArray(r.excludeGlobs)) out.excludeGlobs = r.excludeGlobs.filter((g): g is string => typeof g === 'string')
  if (Array.isArray(r.generatedGlobs)) {
    out.generatedGlobs = r.generatedGlobs.filter((g): g is string => typeof g === 'string')
  }
  if (typeof r.maxSnapshots === 'number' && Number.isFinite(r.maxSnapshots)) {
    out.maxSnapshots = Math.max(10, Math.min(1000, Math.round(r.maxSnapshots)))
  }
  if (typeof r.watchHead === 'boolean') out.watchHead = r.watchHead
  if (typeof r.textureFills === 'boolean') out.textureFills = r.textureFills
  return out
}

export function getSettings(): Settings {
  if (cache) return cache
  try {
    cache = coerce(JSON.parse(readFileSync(settingsPath(), 'utf8')))
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = coerce({ ...getSettings(), ...patch })
  cache = next
  const p = settingsPath()
  const tmp = `${p}.tmp`
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, p)
  return next
}
