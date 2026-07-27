import type { ReactNode } from 'react'

/**
 * The colour key for the Map.
 *
 * Two modes, because there are exactly two kinds of colour encoding in this app
 * and they must never be confused for one another:
 *
 *   sequential   one hue, binned. Oriented low → high, left → right, with the
 *                bin boundaries printed under the strip so the reader can turn a
 *                tile back into a number without hovering anything.
 *   categorical  the fixed series slots, name beside swatch. Identity is carried
 *                by the *pair*, never by the swatch alone.
 *
 * It is deliberately compact: it lives in the Map's single toolbar row, not in a
 * card of its own.
 */

export interface SequentialBin {
  /** CSS colour token for this bin. Always a var(), never a literal. */
  color: string
  /** Pre-formatted inclusive lower bound, e.g. "0.14". */
  fromLabel: string
  /** Pre-formatted upper bound. */
  toLabel: string
  /** True when this is the top bin and everything above it clamps in. */
  open?: boolean
}

export interface CategoricalEntry {
  name: string
  color: string
}

export interface SequentialLegendProps {
  mode: 'sequential'
  /** Names the measure, e.g. "Risk". */
  label: string
  bins: SequentialBin[]
  /** Optional clarifier printed after the strip, e.g. "p95". */
  note?: string
}

export interface CategoricalLegendProps {
  mode: 'categorical'
  label: string
  entries: CategoricalEntry[]
}

export type ColorLegendProps = SequentialLegendProps | CategoricalLegendProps

const CAPTION_CLASS = 'shrink-0 text-[10px] leading-none tracking-[0.06em] uppercase'

export function ColorLegend(props: ColorLegendProps): ReactNode {
  return props.mode === 'sequential' ? (
    <SequentialLegend {...props} />
  ) : (
    <CategoricalLegend {...props} />
  )
}

function SequentialLegend({ label, bins, note }: SequentialLegendProps): ReactNode {
  if (bins.length === 0) return null
  const last = bins[bins.length - 1]
  // Above five bins the per-bin boundary labels start to collide, so they are
  // thinned to every other boundary. The swatch's title still carries the exact
  // range, and the chart's table twin carries the values themselves.
  const thinned = bins.length > 5

  return (
    <div
      role="group"
      aria-label={`${label} colour scale, ${bins.length} bins from ${bins[0]?.fromLabel ?? ''} to ${
        last?.toLabel ?? ''
      }`}
      className="flex min-w-0 items-center gap-2"
    >
      <span className={CAPTION_CLASS} style={{ color: 'var(--ink-muted)' }}>
        {label}
      </span>
      <ul className="flex items-start gap-[2px]" role="list">
        {bins.map((bin, i) => {
          const range = bin.open
            ? `${bin.fromLabel} and above`
            : `${bin.fromLabel} to ${bin.toLabel}`
          return (
            <li key={`${bin.color}-${i}`} className="w-[26px] shrink-0">
              <span
                aria-hidden="true"
                className="block h-2.5 w-full rounded-[2px]"
                style={{ background: bin.color }}
              />
              <span
                className="tnum mt-1 block text-[9px] leading-none"
                style={{ color: 'var(--ink-faint)' }}
              >
                <span className="sr-only">{range}</span>
                <span aria-hidden="true">{!thinned || i % 2 === 0 ? bin.fromLabel : ' '}</span>
              </span>
            </li>
          )
        })}
        <li className="shrink-0 pl-1" aria-hidden="true">
          <span className="block h-2.5" />
          <span className="tnum mt-1 block text-[9px] leading-none" style={{ color: 'var(--ink-faint)' }}>
            {last ? `${last.toLabel}${last.open ? '+' : ''}` : ''}
          </span>
        </li>
      </ul>
      {note ? (
        <span className="shrink-0 self-start text-[10px] leading-[10px]" style={{ color: 'var(--ink-faint)' }}>
          {note}
        </span>
      ) : null}
    </div>
  )
}

function CategoricalLegend({ label, entries }: CategoricalLegendProps): ReactNode {
  if (entries.length === 0) return null
  return (
    <div
      role="group"
      aria-label={`${label} colour key`}
      className="flex min-w-0 items-center gap-2"
    >
      <span className={CAPTION_CLASS} style={{ color: 'var(--ink-muted)' }}>
        {label}
      </span>
      <ul className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1" role="list">
        {entries.map((entry) => (
          <li key={entry.name} className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block size-2 shrink-0 rounded-[2px]"
              style={{ background: entry.color }}
            />
            <span className="truncate text-[11px] leading-none" style={{ color: 'var(--ink-secondary)' }}>
              {entry.name}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default ColorLegend
