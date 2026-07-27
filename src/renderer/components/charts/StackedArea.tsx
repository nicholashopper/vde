import { useEffect, useMemo, type ReactNode } from 'react'
import { compact, percent } from '../../lib/format'
import {
  AxisX,
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
 * Composition over time.
 *
 * Notes on the form:
 *
 *   - NO SMOOTHING. These are discrete snapshots taken at specific commits.
 *     A spline between them would draw readings that were never taken.
 *   - Bands are filled SOLID, not at the 10% wash used for overlapping areas.
 *     A stack is read by comparing band thicknesses; a wash makes the upper
 *     bands unresolvable against each other. The calm comes from the 2px
 *     surface gaps and the short height, not from lowering the fills.
 *   - The 2px separation between neighbouring bands is a GAP — each band is
 *     inset 1px on every shared edge — never a stroke drawn around the fill.
 *   - Colour arrives with the entity: the caller passes an already-ordered
 *     series list built from the FULL period, so a language keeps its hue when
 *     the mix shifts underneath it.
 */

const MARGINS: Margins = { top: 10, right: 30, bottom: 22, left: 46 }

// Local-midnight parsing: format.ts's shortDate would render 'YYYY-MM-DD' a day
// early anywhere west of Greenwich, because it parses as UTC and formats local.
const DAY_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const DAY_LABEL_LONG = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
})

function parseDay(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd)
  if (!m) {
    const t = Date.parse(ymd)
    return Number.isFinite(t) ? t : Number.NaN
  }
  const [, y = '1970', mo = '01', d = '01'] = m
  return new Date(Number(y), Number(mo) - 1, Number(d)).getTime()
}

/**
 * niceTicks() stops at or BELOW `max`, so its last tick is not a safe scale
 * top: the tallest column would poke out of the plot and be clipped at the svg
 * edge. This takes niceTicks' step and re-runs the ladder past `max`. The step
 * is floored at 1 because line counts are integers, and a fractional step
 * labels two gridlines with the same rounded number.
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

export interface StackedAreaSeries {
  name: string
  /** A colours.ts token. Assigned by entity, never by rank. */
  color: string
}

export interface StackedAreaPoint {
  /** YYYY-MM-DD */
  date: string
  values: Readonly<Record<string, number>>
}

export interface StackedAreaProps {
  points: readonly StackedAreaPoint[]
  /** Stack order, bottom → top. */
  series: readonly StackedAreaSeries[]
  /** Inclusive local-midnight ms range, shared by every chart on the screen. */
  domain: readonly [number, number]
  ariaLabel: string
  /** Value formatter for ticks, tooltip and table. Defaults to compact(). */
  format?: (n: number) => string
  /** Noun for the tooltip header, e.g. "lines". */
  unitLabel?: string
}

interface Column {
  ms: number
  date: string
  x: number
  /** Cumulative boundaries, length series.length + 1, in value space. */
  bounds: number[]
  total: number
}

export function StackedArea(props: StackedAreaProps): ReactNode {
  return (
    <TooltipProvider>
      <Plot {...props} />
    </TooltipProvider>
  )
}

function Plot({
  points,
  series,
  domain,
  ariaLabel,
  format = compact,
  unitLabel = 'lines'
}: StackedAreaProps): ReactNode {
  const [ref, size] = useMeasure<HTMLDivElement>()
  const plot = usePlot(size, MARGINS)
  const { index, handlers, pointer } = useNearestIndex(plot, points.length)
  const { show, hide } = useTooltip()

  const domStart = domain[0]
  const domEnd = domain[1]
  const span = Math.max(1, domEnd - domStart)

  const columns = useMemo<Column[]>(() => {
    return points.map((p) => {
      const ms = parseDay(p.date)
      const bounds: number[] = [0]
      let acc = 0
      for (const s of series) {
        acc += Math.max(0, p.values[s.name] ?? 0)
        bounds.push(acc)
      }
      const t = Number.isFinite(ms) ? (ms - domStart) / span : 0
      return {
        ms,
        date: p.date,
        x: Math.min(1, Math.max(0, t)) * plot.iw,
        bounds,
        total: acc
      }
    })
  }, [points, series, domStart, span, plot.iw])

  const maxTotal = useMemo(() => columns.reduce((m, c) => Math.max(m, c.total), 0), [columns])
  const axis = useMemo(() => axisScale(maxTotal, 3), [maxTotal])
  const yTicks = axis.ticks
  const yTop = axis.top
  const scaleY = (v: number): number => plot.ih - (yTop > 0 ? (v / yTop) * plot.ih : 0)

  const bands = useMemo(() => {
    if (plot.iw <= 0 || plot.ih <= 0 || columns.length === 0) return []
    const k = series.length
    return series.map((s, si) => {
      const top: number[] = []
      const bottom: number[] = []
      for (const c of columns) {
        const yTopRaw = scaleY(c.bounds[si + 1] ?? 0)
        const yBotRaw = scaleY(c.bounds[si] ?? 0)
        // 1px inset on each SHARED edge → a 2px surface gap between bands.
        const t = yTopRaw + (si < k - 1 ? 1 : 0)
        const b = yBotRaw - (si > 0 ? 1 : 0)
        if (b >= t) {
          top.push(t)
          bottom.push(b)
        } else {
          const mid = (yTopRaw + yBotRaw) / 2
          top.push(mid)
          bottom.push(mid)
        }
      }
      // A lone snapshot has no width to sweep, so it is drawn as a narrow
      // column instead of a zero-area polygon that renders as nothing.
      if (columns.length === 1) {
        const c = columns[0]
        const w = Math.min(24, plot.iw)
        const x0 = Math.max(0, Math.min(plot.iw - w, (c?.x ?? 0) - w / 2))
        const t = top[0] ?? 0
        const b = bottom[0] ?? 0
        return { series: s, d: b > t ? `M${x0} ${t}H${x0 + w}V${b}H${x0}Z` : '' }
      }
      let d = ''
      columns.forEach((c, i) => {
        d += `${i === 0 ? 'M' : 'L'}${c.x} ${top[i] ?? 0}`
      })
      for (let i = columns.length - 1; i >= 0; i -= 1) {
        d += `L${columns[i]?.x ?? 0} ${bottom[i] ?? 0}`
      }
      d += 'Z'
      return { series: s, d }
    })
    // scaleY is a pure function of plot.ih and yTop, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, series, plot.iw, plot.ih, yTop])

  /** Direct-label only the largest band at the right edge — never every series. */
  const endLabel = useMemo(() => {
    const last = columns[columns.length - 1]
    if (!last || plot.iw < 220 || series.length === 0) return null
    let bestIdx = 0
    let bestVal = -1
    series.forEach((_, si) => {
      const v = (last.bounds[si + 1] ?? 0) - (last.bounds[si] ?? 0)
      if (v > bestVal) {
        bestVal = v
        bestIdx = si
      }
    })
    const s = series[bestIdx]
    if (!s || bestVal <= 0) return null
    const yA = scaleY(last.bounds[bestIdx + 1] ?? 0)
    const yB = scaleY(last.bounds[bestIdx] ?? 0)
    if (yB - yA < 16) return null
    // Anchored to where the band actually ends, not to the plot edge — the
    // last snapshot can predate the domain end.
    return { name: s.name, value: bestVal, y: (yA + yB) / 2, x: Math.min(plot.iw, last.x) - 6 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, series, plot.iw, plot.ih, yTop])

  const xTicks = useMemo(() => {
    const want = 6
    const out: number[] = []
    // Over a range of a few days six evenly spaced ticks render the same date
    // twice; drop the repeats rather than print a ladder of duplicates. Each
    // surviving tick still sits at its own exact position.
    const seen = new Set<string>()
    for (let i = 0; i < want; i += 1) {
      const v = domStart + (span * i) / (want - 1)
      const key = DAY_LABEL.format(v)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(v)
    }
    return out
  }, [domStart, span])

  // Snapshots are taken on an ADAPTIVE cadence (daily recently, then weekly,
  // then monthly), so they are not evenly spaced along x. useNearestIndex
  // assumes even spacing; it is used here for pointer tracking and enter/leave,
  // and the index is then re-resolved against the real x positions.
  const activeIndex = useMemo(() => {
    if (index === null || columns.length === 0) return null
    const px = pointer.x - plot.margins.left
    let best = 0
    let bestD = Number.POSITIVE_INFINITY
    columns.forEach((c, i) => {
      const d = Math.abs(c.x - px)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }, [index, pointer.x, columns, plot.margins.left])

  const active = activeIndex !== null ? columns[activeIndex] : undefined

  useEffect(() => {
    if (!active) {
      hide()
      return
    }
    const rows = series
      .map((s, si) => {
        const v = (active.bounds[si + 1] ?? 0) - (active.bounds[si] ?? 0)
        return { name: s.name, color: s.color, value: v }
      })
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
    show({
      x: pointer.x,
      y: pointer.y,
      title: `${DAY_LABEL_LONG.format(active.ms)} · ${format(active.total)} ${unitLabel}`,
      rows: rows.map((r) => ({
        label: r.name,
        color: r.color,
        value: `${format(r.value)}  ${active.total > 0 ? percent((r.value / active.total) * 100, 0) : '—'}`
      }))
    })
  }, [active, pointer.x, pointer.y, series, format, unitLabel, show, hide])

  if (points.length === 0) {
    return (
      <div
        className="flex h-full w-full items-center justify-center text-[11px]"
        style={{ color: 'var(--ink-muted)' }}
      >
        No snapshots in range.
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
            <AxisY plot={plot} ticks={yTicks} scale={scaleY} format={format} />

            {bands.map((b) => (
              <path key={b.series.name} d={b.d} fill={b.series.color} />
            ))}

            {endLabel ? (
              <text
                x={endLabel.x}
                y={endLabel.y}
                dy="0.32em"
                textAnchor="end"
                fontSize={11}
                fill="var(--ink-primary)"
                stroke="var(--surface-1)"
                strokeWidth={3}
                paintOrder="stroke"
                aria-hidden="true"
              >
                {`${endLabel.name} · ${format(endLabel.value)}`}
              </text>
            ) : null}

            <AxisX
              plot={plot}
              ticks={xTicks}
              scale={(v) => ((v - domStart) / span) * plot.iw}
              format={(v) => DAY_LABEL.format(v)}
            />

            {active ? (
              <line
                aria-hidden="true"
                x1={active.x}
                x2={active.x}
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

export function StackedAreaTable({
  points,
  series,
  format = compact
}: {
  points: readonly StackedAreaPoint[]
  series: readonly StackedAreaSeries[]
  format?: (n: number) => string
}): ReactNode {
  const rows = useMemo(
    () =>
      points.map((p) => [
        DAY_LABEL_LONG.format(parseDay(p.date)),
        ...series.map((s) => format(Math.max(0, p.values[s.name] ?? 0)))
      ]),
    [points, series, format]
  )
  return (
    <TableView
      columns={['Snapshot', ...series.map((s) => s.name)]}
      rows={rows}
      caption="One row per snapshot, oldest first."
    />
  )
}

/**
 * Exported so callers computing a shared x-domain use the same local-midnight
 * interpretation of a 'YYYY-MM-DD' bucket key that this chart plots against.
 */
export { parseDay as parseDayLocal }
