import { useId, type ReactNode } from 'react'
import type { SignalDelta, SignalId } from '../../shared/types'
import { SIGNALS, formatSignal } from '../../shared/signals'
import { deltaColor, deltaGlyph } from '../lib/colors'
import { Sparkline } from './charts/Sparkline'
import { EMPTY_SERIES, formatDelta, type SignalSeries } from './SignalTile'

/**
 * "What moved" — pinned above the grid so change is the first thing seen.
 *
 * With no composite score, the fastest route to "is anything wrong today?" is
 * the delta, not the level. topMovers arrives pre-ranked by magnitude, so this
 * component ranks nothing; it only decides what is worth showing at all.
 */

export interface MoversStripProps {
  /** report.topMovers — already ranked worst-first by |magnitude|. */
  movers: readonly SignalDelta[]
  /** report.baseline.label, e.g. "7 days ago (a1b2c3d)". */
  baselineLabel: string
  series: Record<SignalId, SignalSeries>
  /** report.snapshots.length — one snapshot means there is nothing to compare. */
  snapshotCount: number
  onOpen(id: SignalId): void
}

const MAX_CARDS = 5

function Quiet({ children }: { children: ReactNode }): ReactNode {
  return (
    <p className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
      {children}
    </p>
  )
}

function MoverCard({
  delta,
  series,
  onOpen
}: {
  delta: SignalDelta
  series: SignalSeries
  onOpen(id: SignalId): void
}): ReactNode {
  const def = SIGNALS[delta.id]
  const colour = deltaColor(delta.direction)
  const amount = formatDelta(delta.id, delta.absolute)
  const before = formatSignal(delta.id, delta.baseline)
  const after = formatSignal(delta.id, delta.current)
  const word = delta.direction === 'worse' ? 'worse' : delta.direction === 'better' ? 'better' : 'unchanged'

  return (
    <button
      type="button"
      onClick={() => onOpen(delta.id)}
      aria-label={`${def.label}: ${amount}, ${word}. From ${before} to ${after}. Opens details.`}
      className="flex w-full min-w-0 flex-col gap-1.5 rounded-[8px] border border-hairline bg-surface-2 p-2.5 text-left transition-colors hover:bg-surface-3"
    >
      <span className="truncate text-[11px] font-medium" style={{ color: 'var(--ink-secondary)' }}>
        {def.label}
      </span>
      <span className="flex items-center justify-between gap-2">
        <span
          className="tnum flex shrink-0 items-baseline gap-1 text-[15px] leading-none"
          style={{ color: colour }}
        >
          <span aria-hidden="true" className="text-[10px]">
            {deltaGlyph(delta.direction)}
          </span>
          <span>{amount}</span>
        </span>
        <span className="block w-14 shrink-0">
          <Sparkline
            values={series.values}
            baselineIndex={series.baselineIndex}
            height={22}
            label={def.label}
            format={(v) => formatSignal(delta.id, v)}
            ringColor="var(--surface-2)"
          />
        </span>
      </span>
      <span className="tnum truncate text-[10px]" style={{ color: 'var(--ink-muted)' }}>
        {before} <span aria-hidden="true">→</span> {after}
      </span>
    </button>
  )
}

export function MoversStrip({
  movers,
  baselineLabel,
  series,
  snapshotCount,
  onOpen
}: MoversStripProps): ReactNode {
  const headingId = useId()
  const moved = movers.filter((m) => m.direction !== 'flat').slice(0, MAX_CARDS)

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-[12px] font-medium" style={{ color: 'var(--ink-secondary)' }}>
        What moved since {baselineLabel}
      </h2>

      {snapshotCount <= 1 ? (
        <Quiet>
          This repository has a single snapshot, so there is nothing to compare it against yet.
          Trends and movers appear after the next scan.
        </Quiet>
      ) : moved.length === 0 ? (
        <Quiet>Nothing moved. Every signal is holding its previous value against this baseline.</Quiet>
      ) : (
        <ul className="grid list-none grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2">
          {moved.map((m) => (
            <li key={m.id} className="min-w-0">
              <MoverCard delta={m} series={series[m.id] ?? EMPTY_SERIES} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default MoversStrip
