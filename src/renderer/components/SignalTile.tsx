import type { ReactNode } from 'react'
import type { HealthStatus, SignalDelta, SignalId, SignalValue } from '../../shared/types'
import { SIGNALS, formatSignal } from '../../shared/signals'
import { STATUS_LABEL, STATUS_VAR, deltaColor, deltaGlyph } from '../lib/colors'
import { signed } from '../lib/format'
import { Sparkline } from './charts/Sparkline'
import { StatusPip } from './ui/StatusPip'

/**
 * One signal, one tile.
 *
 * Every tile is read the same way because every signal points the same way:
 * higher is worse, without exception. That invariant is what lets this screen
 * work without a composite score, so nothing here may quietly invert it.
 *
 * The tile is a <button>, so its children are spans rather than divs — a button
 * takes phrasing content, and the tile's accessible name is its aria-label.
 */

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/**
 * One signal's history, extracted from report.snapshots.
 *
 * Snapshots may be missing a value for a given signal, so each series carries
 * its OWN dates and its own baseline index: a shared index would silently
 * mis-align the baseline hairline for any signal with a gap.
 */
export interface SignalSeries {
  values: number[]
  /** YYYY-MM-DD, parallel to `values`. */
  dates: string[]
  /** Index of the baseline point within `values`, or null. */
  baselineIndex: number | null
}

export const EMPTY_SERIES: SignalSeries = { values: [], dates: [], baselineIndex: null }

/** Tight unit suffix for a delta sitting beside a value. */
export function tightSuffix(id: SignalId): string {
  switch (SIGNALS[id].unit) {
    case 'percent':
      return '%'
    case 'ratio':
      return '×'
    case 'days':
      return 'd'
    default:
      return ''
  }
}

/** The value, split so the number can wear .figure and the unit cannot. */
export function splitValue(id: SignalId, value: number): { body: string; unit: string } {
  const def = SIGNALS[id]
  const n = Number.isFinite(value) ? value : 0
  const body = n.toFixed(def.precision)
  switch (def.unit) {
    case 'percent':
      return { body, unit: '%' }
    case 'files':
      return { body, unit: 'files' }
    case 'days':
      return { body, unit: 'days' }
    case 'lines':
      return { body, unit: 'lines' }
    case 'ratio':
      return { body, unit: '×' }
    default:
      return { body, unit: '' }
  }
}

/**
 * A delta that rounds to nothing at the signal's display precision still moved.
 * Escalate up to two extra digits rather than printing a bare "0" beside an
 * arrow that claims otherwise.
 */
function deltaPrecision(id: SignalId, absolute: number): number {
  const base = SIGNALS[id].precision
  const a = Math.abs(absolute)
  let p = base
  while (p < base + 2 && a > 0 && a < 10 ** -p / 2) p += 1
  return p
}

/** Signed, with a tight unit — e.g. "+1.2%". */
export function formatDelta(id: SignalId, absolute: number): string {
  return `${signed(absolute, deltaPrecision(id, absolute))}${tightSuffix(id)}`
}

/** Unsigned magnitude, for prose. */
export function formatDeltaMagnitude(id: SignalId, absolute: number): string {
  return `${Math.abs(absolute).toFixed(deltaPrecision(id, absolute))}${tightSuffix(id)}`
}

/** "Worse by 1.2%", written for a screen reader rather than for a glyph. */
function deltaSentence(id: SignalId, delta: SignalDelta | undefined): string {
  if (!delta) return 'No baseline comparison available.'
  if (delta.direction === 'flat') return 'Unchanged since the baseline.'
  const amount = formatDeltaMagnitude(id, delta.absolute)
  if (delta.direction === 'worse') return `Up ${amount} since the baseline, which is worse.`
  return `Down ${amount} since the baseline, which is better.`
}

/** Where the next band starts — the thing the threshold ticks show visually. */
function bandSentence(id: SignalId, status: HealthStatus): string {
  const t = SIGNALS[id].thresholds
  if (status === 'good') return `Watch band starts above ${formatSignal(id, t.good)}.`
  if (status === 'warning') return `Serious band starts above ${formatSignal(id, t.warning)}.`
  if (status === 'serious') return `Critical band starts above ${formatSignal(id, t.serious)}.`
  return `Already past the critical threshold of ${formatSignal(id, t.serious)}.`
}

// ---------------------------------------------------------------------------
// The threshold bar
// ---------------------------------------------------------------------------

/**
 * Value against displayMax, with the three band boundaries marked.
 *
 * This is the tile's most useful affordance: it answers "how close am I to the
 * next band?" without a second number. The ticks overhang the track top and
 * bottom so they stay legible where they cross the tinted fill.
 */
function ThresholdBar({
  id,
  value,
  status
}: {
  id: SignalId
  value: number
  status: HealthStatus
}): ReactNode {
  const def = SIGNALS[id]
  const max = def.displayMax > 0 ? def.displayMax : 1
  const pct = (v: number): number => Math.max(0, Math.min(100, (v / max) * 100))
  const fill = pct(Number.isFinite(value) ? value : 0)
  const ticks = [def.thresholds.good, def.thresholds.warning, def.thresholds.serious].filter(
    (t) => t > 0 && t < max
  )

  return (
    <span aria-hidden="true" className="relative block h-2 w-full">
      <span
        className="absolute inset-0 block overflow-hidden rounded-[4px]"
        style={{ background: 'var(--surface-3)' }}
      >
        <span
          className="absolute inset-y-0 left-0 block rounded-l-[4px]"
          style={{ width: `${fill}%`, background: STATUS_VAR[status], opacity: 0.32 }}
        />
        {/* The data end: the crisp read point, full-opacity status colour. */}
        <span
          className="absolute inset-y-0 block"
          style={{
            left: `calc(${fill}% - 1px)`,
            width: 2,
            borderRadius: 1,
            background: STATUS_VAR[status]
          }}
        />
      </span>
      {ticks.map((t) => (
        <span
          key={t}
          className="absolute block"
          style={{
            left: `calc(${pct(t)}% - 0.5px)`,
            top: -3,
            bottom: -3,
            width: 1,
            background: 'var(--ink-faint)'
          }}
        />
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// The tile
// ---------------------------------------------------------------------------

export interface SignalTileProps {
  signal: SignalValue
  delta?: SignalDelta | undefined
  series: SignalSeries
  onOpen(id: SignalId): void
}

export function SignalTile({ signal, delta, series, onOpen }: SignalTileProps): ReactNode {
  const def = SIGNALS[signal.id]
  const { body, unit } = splitValue(signal.id, signal.value)
  const aria = `${def.label}: ${formatSignal(signal.id, signal.value)}, ${
    STATUS_LABEL[signal.status]
  }. ${deltaSentence(signal.id, delta)} ${bandSentence(signal.id, signal.status)} Opens details.`

  return (
    <button
      type="button"
      onClick={() => onOpen(signal.id)}
      aria-label={aria}
      className="card flex min-w-0 flex-col gap-3 bg-surface-1 p-3.5 text-left transition-colors hover:bg-surface-2"
    >
      <span className="flex items-start justify-between gap-2">
        <span
          className="min-w-0 flex-1 truncate text-[12px] font-medium"
          style={{ color: 'var(--ink-secondary)' }}
        >
          {def.label}
        </span>
        <StatusPip status={signal.status} wash />
      </span>

      <span className="flex items-baseline gap-1.5">
        <span className="figure text-[27px] leading-none" style={{ color: 'var(--ink-primary)' }}>
          {body}
        </span>
        {unit ? (
          <span className="text-[12px] leading-none" style={{ color: 'var(--ink-muted)' }}>
            {unit}
          </span>
        ) : null}
        {delta ? (
          <span
            className="tnum ml-auto flex shrink-0 items-baseline gap-1 text-[12px] leading-none"
            style={{ color: deltaColor(delta.direction) }}
          >
            <span aria-hidden="true" className="text-[9px]">
              {deltaGlyph(delta.direction)}
            </span>
            <span>{formatDelta(signal.id, delta.absolute)}</span>
          </span>
        ) : null}
      </span>

      <Sparkline
        values={series.values}
        baselineIndex={series.baselineIndex}
        height={38}
        label={def.label}
        format={(v) => formatSignal(signal.id, v)}
        ringColor="var(--surface-1)"
      />

      <span
        className="block truncate text-[11px] leading-snug"
        style={{ color: 'var(--ink-muted)' }}
        title={def.measures}
      >
        {def.measures}
      </span>

      <ThresholdBar id={signal.id} value={signal.value} status={signal.status} />
    </button>
  )
}

export default SignalTile
