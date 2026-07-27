import type { HealthStatus } from '../../shared/types'

/**
 * Colour assignment.
 *
 * The palette rules are enforced here rather than left to each chart, because
 * the failure modes are systematic:
 *
 *   - Categorical hues are assigned in FIXED ORDER and NEVER cycled. There is
 *     no ninth colour; a ninth series folds into "Other". The slot ordering is
 *     the colour-blind-safety mechanism (adjacent pairs were what the validator
 *     checked), so a chart may not reorder them.
 *   - Colour follows the ENTITY, not its rank. `seriesScale` builds a stable
 *     name → slot map so filtering a series out never repaints the survivors.
 *   - Sequential encoding is one hue, light → dark. Never a rainbow.
 *   - Status colours are reserved. They never stand in for a series, and they
 *     never carry meaning without an accompanying icon or label.
 */

/** The eight categorical slots, in validated order. Do not reorder. */
export const SERIES_VARS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)'
] as const

export const SERIES_OTHER = 'var(--series-other)'
export const MAX_SERIES = SERIES_VARS.length

/** The sequential ramp, light → dark. Index 0 is nearest the surface. */
export const SEQUENTIAL = [
  'var(--seq-100)',
  'var(--seq-150)',
  'var(--seq-200)',
  'var(--seq-250)',
  'var(--seq-300)',
  'var(--seq-350)',
  'var(--seq-400)',
  'var(--seq-450)',
  'var(--seq-500)',
  'var(--seq-550)',
  'var(--seq-600)',
  'var(--seq-650)',
  'var(--seq-700)'
] as const

/**
 * The ordinal ramp — a subset of the sequential steps. For discrete ordered
 * marks the step nearest the surface must still clear 2:1 contrast, so this
 * starts at step 250 rather than 100.
 */
export const ORDINAL = SEQUENTIAL.slice(3, 11)

export const STATUS_VAR: Record<HealthStatus, string> = {
  good: 'var(--status-good)',
  warning: 'var(--status-warning)',
  serious: 'var(--status-serious)',
  critical: 'var(--status-critical)'
}

export const STATUS_WASH: Record<HealthStatus, string> = {
  good: 'var(--status-good-wash)',
  warning: 'var(--status-warning-wash)',
  serious: 'var(--status-serious-wash)',
  critical: 'var(--status-critical-wash)'
}

export const STATUS_LABEL: Record<HealthStatus, string> = {
  good: 'Healthy',
  warning: 'Watch',
  serious: 'Serious',
  critical: 'Critical'
}

/**
 * Builds a stable entity → colour mapping.
 *
 * Pass the FULL, UNFILTERED list of entity names in a deterministic order
 * (e.g. ranked by total size across the whole period, not the current slice).
 * Everything past the eighth entity resolves to the "Other" grey, and callers
 * are expected to have aggregated those rows into a single "Other" series —
 * see {@link foldToTopN}.
 */
export function seriesScale(names: readonly string[]): (name: string) => string {
  const map = new Map<string, string>()
  names.forEach((name, i) => {
    if (i < MAX_SERIES) {
      const v = SERIES_VARS[i]
      if (v) map.set(name, v)
    }
  })
  return (name: string) => map.get(name) ?? SERIES_OTHER
}

export interface FoldedSeries<T> {
  /** The top N entities plus, when anything was folded, a trailing "Other". */
  names: string[]
  /** Rows re-keyed so folded entities are merged under "Other". */
  rows: T[]
  foldedCount: number
}

/**
 * Reduces an arbitrary number of categories to at most `limit` plus "Other".
 *
 * This is the alternative to generating a ninth hue, which would be
 * indistinguishable from an existing slot under simulated colour-blindness.
 */
export function foldToTopN<T>(
  items: readonly T[],
  key: (item: T) => string,
  weight: (item: T) => number,
  limit = MAX_SERIES - 1
): FoldedSeries<T> {
  const totals = new Map<string, number>()
  for (const item of items) {
    totals.set(key(item), (totals.get(key(item)) ?? 0) + weight(item))
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const keep = new Set(ranked.slice(0, limit).map(([k]) => k))
  const foldedCount = Math.max(0, ranked.length - keep.size)
  const names = ranked.slice(0, limit).map(([k]) => k)
  if (foldedCount > 0) names.push('Other')
  return { names, rows: items as T[], foldedCount }
}

/** True when this entity was folded and should be drawn in the "Other" grey. */
export function isFolded(name: string, names: readonly string[]): boolean {
  return !names.includes(name)
}

/**
 * Maps 0–1 onto the sequential ramp. Values outside the range clamp.
 * `steps` lets a chart use fewer, more distinguishable classes — past about
 * seven colour classes adjacent bins blur together, so heatmaps should bin.
 */
export function sequential(t: number, steps = SEQUENTIAL.length): string {
  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
  const n = Math.max(2, Math.min(steps, SEQUENTIAL.length))
  const idx = Math.round(clamped * (n - 1))
  const stride = (SEQUENTIAL.length - 1) / (n - 1)
  return SEQUENTIAL[Math.round(idx * stride)] ?? SEQUENTIAL[0]
}

/**
 * Maps −1..0..+1 onto the diverging ramp. The midpoint is neutral grey, never
 * a hue: it must read as "nothing happened".
 */
export function diverging(t: number): string {
  const v = Number.isFinite(t) ? Math.min(1, Math.max(-1, t)) : 0
  if (v <= -0.66) return 'var(--div-neg-3)'
  if (v <= -0.33) return 'var(--div-neg-2)'
  if (v < -0.05) return 'var(--div-neg-1)'
  if (v <= 0.05) return 'var(--div-mid)'
  if (v < 0.33) return 'var(--div-pos-1)'
  if (v < 0.66) return 'var(--div-pos-2)'
  return 'var(--div-pos-3)'
}

/** Delta cues. Always paired with an arrow glyph — never colour alone. */
export function deltaColor(direction: 'worse' | 'better' | 'flat'): string {
  if (direction === 'worse') return 'var(--delta-worse)'
  if (direction === 'better') return 'var(--delta-better)'
  return 'var(--delta-flat)'
}

export function deltaGlyph(direction: 'worse' | 'better' | 'flat'): string {
  if (direction === 'worse') return '▲'
  if (direction === 'better') return '▼'
  return '—'
}
