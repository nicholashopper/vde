import { useEffect, useMemo, type ReactNode } from 'react'
import type { TimelineBucket } from '../../../shared/types'
import { SERIES_VARS } from '../../lib/colors'
import { compact, plain } from '../../lib/format'
import {
  AxisY,
  GridLines,
  TableView,
  TooltipProvider,
  niceTicks,
  useMeasure,
  useNearestIndex,
  usePlot,
  useTooltip,
  type Margins
} from './primitives'

/**
 * Commits per day.
 *
 * One column per calendar day across the report's whole range. Three decisions
 * worth stating:
 *
 *   1. A mega-commit day is marked with a CARET ABOVE the column, never by
 *      recolouring it. The column's hue already means "commits"; giving it a
 *      second meaning would double-encode and make the two unreadable together.
 *   2. Zero-commit days punch a visible GAP in the baseline rule. Without it a
 *      dead day is indistinguishable from a day the analyser never saw, and
 *      "nothing happened" is the single most diagnostic fact on this chart.
 *      That gap is why this chart draws its own baseline instead of AxisX —
 *      AxisX's rule is unconditionally continuous, which is right for chrome
 *      and wrong here, where the baseline carries data.
 *   3. Columns collapse from 24px caps → 2px-gapped bars → 1px gapless columns
 *      as the range outgrows the pixels. The gap is dropped before the bar is,
 *      because a 1px bar with a 1px gap aliases into a grey wash.
 */

const DAY_MS = 86_400_000
/** ~55 years. Guards against a nonsense domain turning into an unbounded loop. */
const MAX_DAYS = 20_000
const MARGINS: Margins = { top: 14, right: 30, bottom: 22, left: 46 }
const BAR_COLOR = SERIES_VARS[0]

// format.ts's shortDate parses 'YYYY-MM-DD' as UTC midnight and formats it in
// the local zone, which lands on the previous day west of Greenwich. Day
// buckets are calendar days, so they are anchored to LOCAL midnight here.
const DAY_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const DAY_LABEL_LONG = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric'
})

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * niceTicks() stops at or BELOW `max`, so its last tick is not a safe scale
 * top: a peak of 63 against ticks 0/20/40/60 would draw 5% above the plot and
 * push the mega-caret out through the top of the svg. This takes niceTicks'
 * step and re-runs the ladder past `max`.
 *
 * The step is also floored at 1, because commits per day is a count — a 0.5
 * step would label two gridlines "1" after rounding.
 */
function axisScale(max: number, target: number): { ticks: number[]; top: number } {
  const base = niceTicks(max, target)
  let step = (base[1] ?? 0) - (base[0] ?? 0)
  if (step <= 0) return { ticks: [0], top: max > 0 ? max : 1 }
  if (step < 1) step = 1
  const top = Math.max(step, Number((Math.ceil(max / step) * step).toFixed(10)))
  const ticks: number[] = []
  for (let v = 0; v <= top + step * 1e-6; v += step) ticks.push(Number(v.toFixed(10)))
  return { ticks, top }
}

interface Day {
  ms: number
  date: string
  commits: number
  insertions: number
  deletions: number
  filesTouched: number
  megaCommits: number
  authors: number
}

/** Square at the baseline, 4px rounded at the data end. */
function columnPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h))
  if (rr < 1) return `M${x} ${y}h${w}v${h}h${-w}Z`
  return (
    `M${x} ${y + h}V${y + rr}` +
    `A${rr} ${rr} 0 0 1 ${x + rr} ${y}` +
    `H${x + w - rr}` +
    `A${rr} ${rr} 0 0 1 ${x + w} ${y + rr}` +
    `V${y + h}Z`
  )
}

export interface CommitTimelineProps {
  buckets: readonly TimelineBucket[]
  /** Inclusive local-midnight ms range, shared by every chart on the screen. */
  domain: readonly [number, number]
}

export function CommitTimeline({ buckets, domain }: CommitTimelineProps): ReactNode {
  const domStart = domain[0]
  const domEnd = domain[1]

  const days = useMemo<Day[]>(() => {
    if (!Number.isFinite(domStart) || !Number.isFinite(domEnd) || domEnd < domStart) return []
    const byDate = new Map<string, TimelineBucket>()
    for (const b of buckets) byDate.set(b.date, b)
    const count = Math.min(MAX_DAYS, Math.round((domEnd - domStart) / DAY_MS) + 1)
    const anchor = new Date(domStart)
    const out: Day[] = []
    for (let i = 0; i < count; i += 1) {
      // Stepping by calendar date rather than by +86.4e6 ms keeps the series
      // aligned through daylight-saving transitions.
      const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + i)
      const key = ymd(d)
      const b = byDate.get(key)
      out.push({
        ms: d.getTime(),
        date: key,
        commits: b?.commits ?? 0,
        insertions: b?.insertions ?? 0,
        deletions: b?.deletions ?? 0,
        filesTouched: b?.filesTouched ?? 0,
        megaCommits: b?.megaCommits ?? 0,
        authors: b?.authors ?? 0
      })
    }
    return out
  }, [buckets, domStart, domEnd])

  const totals = useMemo(() => {
    let commits = 0
    let active = 0
    let peak = 0
    for (const d of days) {
      commits += d.commits
      if (d.commits > 0) active += 1
      if (d.commits > peak) peak = d.commits
    }
    return { commits, active, peak }
  }, [days])

  const label =
    days.length === 0
      ? 'Commits per day. No history in range.'
      : `Commits per day across ${plain(days.length)} days. ${plain(totals.commits)} commits on ${plain(totals.active)} active days, peaking at ${plain(totals.peak)} in a day.`

  return (
    <TooltipProvider>
      <Plot days={days} ariaLabel={label} />
    </TooltipProvider>
  )
}

function Plot({ days, ariaLabel }: { days: Day[]; ariaLabel: string }): ReactNode {
  const [ref, size] = useMeasure<HTMLDivElement>()
  const plot = usePlot(size, MARGINS)
  const { index, handlers, pointer } = useNearestIndex(plot, days.length)
  const { show, hide } = useTooltip()

  const maxCommits = useMemo(() => days.reduce((m, d) => Math.max(m, d.commits), 0), [days])
  const axis = useMemo(() => axisScale(maxCommits, 4), [maxCommits])
  const yTicks = axis.ticks
  const yTop = axis.top
  const scaleY = (v: number): number => plot.ih - (yTop > 0 ? (v / yTop) * plot.ih : 0)

  const n = days.length
  const band = n > 0 ? plot.iw / n : 0
  // The gap yields before the bar does — a 1px bar flanked by a 1px gap aliases
  // into a grey wash — and it shrinks monotonically so a resize never makes the
  // columns momentarily thinner. Caps at 24px so a short history reads as
  // columns rather than as blocks.
  const gap = band >= 3 ? 2 : Math.max(0, band - 1)
  const barW = Math.max(1, Math.min(24, band - gap))
  const offset = (band - barW) / 2

  const barsPath = useMemo(() => {
    if (plot.iw <= 0 || plot.ih <= 0 || n === 0) return ''
    let d = ''
    for (let i = 0; i < n; i += 1) {
      const day = days[i]
      if (!day || day.commits <= 0) continue
      const h = Math.max(1, plot.ih - scaleY(day.commits))
      d += columnPath(i * band + offset, plot.ih - h, barW, h, 4)
    }
    return d
    // scaleY is derived from plot.ih/yTop, both of which are in the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, n, band, barW, offset, plot.iw, plot.ih, yTop])

  /** Runs of consecutive days that saw at least one commit. */
  const activeRuns = useMemo(() => {
    const runs: Array<[number, number]> = []
    let start = -1
    for (let i = 0; i < n; i += 1) {
      const live = (days[i]?.commits ?? 0) > 0
      if (live && start === -1) start = i
      if (!live && start !== -1) {
        runs.push([start, i])
        start = -1
      }
    }
    if (start !== -1) runs.push([start, n])
    return runs
  }, [days, n])

  const megaDays = useMemo(
    () =>
      days
        .map((d, i) => ({ day: d, i }))
        .filter((e) => e.day.megaCommits > 0),
    [days]
  )

  const xTicks = useMemo(() => {
    if (n === 0) return []
    const want = Math.min(6, n)
    const out: number[] = []
    for (let i = 0; i < want; i += 1) {
      const idx = want === 1 ? 0 : Math.round((i * (n - 1)) / (want - 1))
      if (!out.includes(idx)) out.push(idx)
    }
    return out
  }, [n])

  const active = index !== null ? days[index] : undefined

  useEffect(() => {
    if (!active) {
      hide()
      return
    }
    show({
      x: pointer.x,
      y: pointer.y,
      title: DAY_LABEL_LONG.format(active.ms),
      rows: [
        { label: 'Commits', value: plain(active.commits), color: BAR_COLOR },
        { label: 'Lines added', value: `+${plain(active.insertions)}` },
        { label: 'Lines removed', value: `−${plain(active.deletions)}` },
        { label: 'Files touched', value: plain(active.filesTouched) },
        { label: 'Authors', value: plain(active.authors) },
        ...(active.megaCommits > 0
          ? [{ label: 'Mega-commits', value: plain(active.megaCommits) }]
          : [])
      ]
    })
  }, [active, pointer.x, pointer.y, show, hide])

  if (n === 0) {
    return (
      <div
        className="flex h-full w-full items-center justify-center text-[11px]"
        style={{ color: 'var(--ink-muted)' }}
      >
        No commit history in range.
      </div>
    )
  }

  return (
    <div ref={ref} className="h-full w-full">
      {plot.iw > 0 && plot.ih > 0 ? (
        <svg
          width={plot.width}
          height={plot.height}
          role="img"
          aria-label={ariaLabel}
          className="block touch-none"
          {...handlers}
        >
          <g transform={`translate(${plot.margins.left},${plot.margins.top})`}>
            <GridLines plot={plot} ticks={yTicks} scale={scaleY} />

            {/* Hover band sits behind the marks so the column stays unmodified. */}
            {index !== null ? (
              <rect
                aria-hidden="true"
                x={index * band}
                y={0}
                width={Math.max(3, band)}
                height={plot.ih}
                fill="var(--surface-3)"
              />
            ) : null}

            <AxisY plot={plot} ticks={yTicks} scale={scaleY} format={compact} />

            {/* The baseline is drawn per active run, so a dead day reads as a
                hole in the rule rather than as data the analyser never had. */}
            <g aria-hidden="true">
              {activeRuns.map(([s, e]) => (
                <line
                  key={`${s}-${e}`}
                  x1={s * band}
                  x2={e * band}
                  y1={plot.ih}
                  y2={plot.ih}
                  stroke="var(--axis)"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
              ))}
            </g>

            {barsPath ? <path d={barsPath} fill={BAR_COLOR} /> : null}

            {/* Mega-commit carets. Ink, not a hue: this is a glyph channel. */}
            <g aria-hidden="true" fill="var(--ink-secondary)">
              {megaDays.map(({ day, i }) => {
                const cx = i * band + band / 2
                const top = plot.ih - Math.max(1, plot.ih - scaleY(day.commits))
                if (band < 3) {
                  return <rect key={day.date} x={cx - 0.5} y={top - 7} width={1} height={4} />
                }
                const w = Math.min(7, Math.max(3, band))
                return (
                  <path
                    key={day.date}
                    d={`M${cx - w / 2} ${top - 8}H${cx + w / 2}L${cx} ${top - 3}Z`}
                  />
                )
              })}
            </g>

            <g aria-hidden="true">
              {xTicks.map((idx, i) => {
                const day = days[idx]
                if (!day) return null
                const anchor = i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'
                const x = i === 0 ? 0 : i === xTicks.length - 1 ? plot.iw : idx * band + band / 2
                return (
                  <text
                    key={day.date}
                    x={x}
                    y={plot.ih + 14}
                    textAnchor={anchor}
                    className="tnum"
                    fill="var(--ink-muted)"
                    fontSize={10}
                  >
                    {DAY_LABEL.format(day.ms)}
                  </text>
                )
              })}
            </g>

            {index !== null ? (
              <line
                aria-hidden="true"
                x1={index * band + band / 2}
                x2={index * band + band / 2}
                y1={0}
                y2={plot.ih}
                stroke="var(--hairline-strong)"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
            ) : null}
          </g>
        </svg>
      ) : null}
    </div>
  )
}

/** Explains the caret channel. Not a legend — there is only one series. */
export function CommitTimelineKey(): ReactNode {
  return (
    <p className="flex items-center gap-1.5 px-1 pt-2 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
      <svg width="9" height="7" viewBox="0 0 9 7" aria-hidden="true" className="shrink-0">
        <path d="M0.5 0.5H8.5L4.5 6Z" fill="var(--ink-secondary)" />
      </svg>
      <span>caret marks a day containing a mega-commit · a break in the baseline is a day with no commits</span>
    </p>
  )
}

export function CommitTimelineTable({
  buckets
}: {
  buckets: readonly TimelineBucket[]
}): ReactNode {
  const rows = useMemo(
    () =>
      buckets.map((b) => [
        b.date,
        plain(b.commits),
        `+${plain(b.insertions)}`,
        `−${plain(b.deletions)}`,
        plain(b.filesTouched)
      ]),
    [buckets]
  )
  return (
    <TableView
      columns={['Date', 'Commits', '+ lines', '− lines', 'Files']}
      rows={rows}
      caption={`${plain(buckets.length)} daily buckets, oldest first.`}
    />
  )
}
