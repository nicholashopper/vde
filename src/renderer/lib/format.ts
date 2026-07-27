/**
 * Display formatting.
 *
 * One rule worth stating: `tabular-nums` belongs on numbers that align
 * vertically (table rows, axis ticks) and NOT on large standalone figures,
 * where equal-width digits make a value look loose. The `.tnum` and `.figure`
 * classes in globals.css encode that; these helpers only produce the strings.
 */

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const PLAIN = new Intl.NumberFormat('en-US')

export function compact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return Math.abs(n) < 1000 ? String(Math.round(n)) : COMPACT.format(n)
}

export function plain(n: number): string {
  return Number.isFinite(n) ? PLAIN.format(Math.round(n)) : '—'
}

export function percent(n: number, precision = 1): string {
  return Number.isFinite(n) ? `${n.toFixed(precision)}%` : '—'
}

export function signed(n: number, precision = 1): string {
  if (!Number.isFinite(n)) return '—'
  // Below half the last displayed digit the sign is noise, so drop it.
  if (Math.abs(n) < 10 ** -precision / 2) return (0).toFixed(precision)
  return `${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(precision)}`
}

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** "3 days ago", "in 2 hours". Uses the real relative-time formatter. */
const RELATIVE = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' })

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const deltaSec = (t - now) / 1000
  const abs = Math.abs(deltaSec)
  if (abs < 60) return RELATIVE.format(Math.round(deltaSec), 'second')
  if (abs < 3600) return RELATIVE.format(Math.round(deltaSec / 60), 'minute')
  if (abs < 86400) return RELATIVE.format(Math.round(deltaSec / 3600), 'hour')
  if (abs < 86400 * 30) return RELATIVE.format(Math.round(deltaSec / 86400), 'day')
  if (abs < 86400 * 365) return RELATIVE.format(Math.round(deltaSec / (86400 * 30)), 'month')
  return RELATIVE.format(Math.round(deltaSec / (86400 * 365)), 'year')
}

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const DATE_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export function shortDate(iso: string): string {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? DATE.format(t) : '—'
}

export function fullDate(iso: string): string {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? DATE_YEAR.format(t) : '—'
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const h = ms / 3_600_000
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (h < 48) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}

/** Truncates a path from the left, keeping the filename legible. */
export function ellipsisPath(path: string, max = 48): string {
  if (path.length <= max) return path
  const parts = path.split('/')
  const file = parts[parts.length - 1] ?? path
  if (file.length >= max - 3) return `…${file.slice(-(max - 1))}`
  let out = file
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const next = `${parts[i]}/${out}`
    if (next.length > max - 2) return `…/${out}`
    out = next
  }
  return out
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}
