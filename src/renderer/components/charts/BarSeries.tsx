import { useRef, useState, type ReactNode } from 'react'
import { diverging } from '../../lib/colors'
import { compact, plain } from '../../lib/format'
import {
  AxisX,
  GridLines,
  TableView,
  TooltipProvider,
  niceTicks,
  useMeasure,
  usePlot,
  useTooltip,
  type Margins,
  type Plot
} from './primitives'

/**
 * A small horizontal bar chart, drawn as a DIVERGING pair around zero.
 *
 * WHY DIVERGING RATHER THAN TWO SERIES OR TWO AXES
 * ------------------------------------------------
 * Insertions and deletions in an agent-written repo differ by an order of
 * magnitude or more — one specimen ran 1.2M added against 40k deleted. The
 * three candidate forms:
 *
 *   - Dual axis (one plot, two y-scales). Never. The alignment of the two
 *     scales is arbitrary, so the chart invents a relationship that is not in
 *     the data. It is the single worst chart mistake, and this data set is the
 *     one that most tempts you into it: on a dual axis the two measures look
 *     comparable, which is precisely the lie.
 *   - Two small multiples sharing one scale. Correct, but it spends two cards
 *     on one fact and splits the two halves of a single event apart.
 *   - A diverging bar about a zero baseline, ONE scale, added to the right and
 *     removed to the left. Chosen. The asymmetry IS the finding: the stub on
 *     the left beside the slab on the right is the accretion signal made
 *     visible, and because both sides share a scale that comparison is honest.
 *     The midpoint is neutral grey, never a hue, so zero reads as "nothing".
 *
 * The warm pole sits on the insertions side deliberately: in this application
 * unchecked addition is the pathology, so the heavier-reading hue belongs to
 * the measure that runs away. Position, the axis and the legend each carry the
 * added/removed distinction as well, so colour never carries it alone.
 */

const MARGINS: Margins = { top: 8, right: 16, bottom: 22, left: 96 }
const POSITIVE = diverging(0.5)
const NEGATIVE = diverging(-0.5)
const MIDPOINT = diverging(0)
const DEFAULT_ROW_HEIGHT = 24
/** Half of the 4px surface gap where the two poles meet at zero. */
const ZERO_INSET = 2

export interface BarSeriesRow {
  /** Short category label for the y-axis. */
  label: string
  /** Magnitude drawn to the RIGHT of zero. */
  positive: number
  /** Magnitude drawn to the LEFT of zero. Pass a positive number. */
  negative: number
  /** Longer label used as the tooltip and table heading. Falls back to label. */
  title?: string
}

export interface BarSeriesProps {
  rows: readonly BarSeriesRow[]
  positiveLabel: string
  negativeLabel: string
  ariaLabel: string
  format?: (n: number) => string
}

/** Plot height, x-axis band included, for a given row count. */
export function barSeriesHeight(rowCount: number, rowHeight = DEFAULT_ROW_HEIGHT): number {
  return Math.max(1, rowCount) * rowHeight + MARGINS.top + MARGINS.bottom
}

/** Square at the zero baseline, 4px rounded at the data end. */
function barPath(x0: number, y: number, w: number, h: number, dir: 1 | -1): string {
  const r = Math.max(0, Math.min(4, w / 2, h / 2))
  const xEnd = x0 + dir * w
  if (r < 1) return `M${x0} ${y}H${xEnd}V${y + h}H${x0}Z`
  const sweep = dir === 1 ? 1 : 0
  return (
    `M${x0} ${y}` +
    `H${xEnd - dir * r}` +
    `A${r} ${r} 0 0 ${sweep} ${xEnd} ${y + r}` +
    `V${y + h - r}` +
    `A${r} ${r} 0 0 ${sweep} ${xEnd - dir * r} ${y + h}` +
    `H${x0}Z`
  )
}

export function BarSeries(props: BarSeriesProps): ReactNode {
  return (
    <TooltipProvider>
      <DivergingPlot {...props} />
    </TooltipProvider>
  )
}

function DivergingPlot({
  rows,
  positiveLabel,
  negativeLabel,
  ariaLabel,
  format = compact
}: BarSeriesProps): ReactNode {
  const [ref, size] = useMeasure<HTMLDivElement>()
  const plot = usePlot(size, MARGINS)
  const [hover, setHover] = useState<number | null>(null)

  const maxAbs = rows.reduce((m, r) => Math.max(m, r.positive, r.negative), 0)
  const half = plot.iw / 2
  const scaleX = (v: number): number => half + (maxAbs > 0 ? (v / maxAbs) * half : 0)

  // Ticks stop at or below maxAbs; the bars themselves are scaled to maxAbs, so
  // the longest bar simply runs past the last gridline. That is the right way
  // round — the bar uses the full half-width and the scale stays honest.
  const magnitudes = niceTicks(maxAbs, 3)
  const xTicks = [...magnitudes.slice(1).map((t) => -t).reverse(), ...magnitudes]

  const rowH = rows.length > 0 ? plot.ih / rows.length : 0
  const barH = Math.max(4, Math.min(14, rowH - 10))

  if (rows.length === 0) {
    return (
      <div
        className="flex h-full w-full items-center justify-center text-[11px]"
        style={{ color: 'var(--ink-muted)' }}
      >
        No commit activity in range.
      </div>
    )
  }

  return (
    <div ref={ref} className="h-full w-full">
      {plot.iw > 0 && plot.ih > 0 ? (
        <>
          <svg
            width={plot.width}
            height={plot.height}
            role="img"
            aria-label={ariaLabel}
            className="block"
          >
            <g transform={`translate(${plot.margins.left},${plot.margins.top})`}>
              <GridLines plot={plot} ticks={xTicks} scale={scaleX} orientation="vertical" />

              {rows.map((r, i) => {
                const cy = i * rowH + rowH / 2
                const y = cy - barH / 2
                const pw = r.positive > 0 ? Math.max(1.5, scaleX(r.positive) - half) : 0
                const nw = r.negative > 0 ? Math.max(1.5, half - scaleX(-r.negative)) : 0
                return (
                  <g key={r.label}>
                    {hover === i ? (
                      <rect
                        aria-hidden="true"
                        x={0}
                        y={i * rowH}
                        width={plot.iw}
                        height={rowH}
                        fill="var(--surface-3)"
                      />
                    ) : null}
                    {/* Each pole starts 2px clear of zero: the separation is a
                        surface gap, never a stroke between the two fills. Bar
                        LENGTH still encodes the value — only the origin shifts. */}
                    {nw > 0 ? (
                      <path d={barPath(half - ZERO_INSET, y, nw, barH, -1)} fill={NEGATIVE} />
                    ) : null}
                    {pw > 0 ? (
                      <path d={barPath(half + ZERO_INSET, y, pw, barH, 1)} fill={POSITIVE} />
                    ) : null}
                    <text
                      x={-plot.margins.left + 4}
                      y={cy}
                      dy="0.32em"
                      textAnchor="start"
                      fill="var(--ink-muted)"
                      fontSize={10}
                      aria-hidden="true"
                    >
                      {r.label}
                    </text>
                  </g>
                )
              })}

              {/* Neutral midpoint: zero must read as "nothing happened". */}
              <line
                aria-hidden="true"
                x1={half}
                x2={half}
                y1={0}
                y2={plot.ih}
                stroke={MIDPOINT}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />

              <AxisX
                plot={plot}
                ticks={xTicks}
                scale={scaleX}
                format={(v) => (v === 0 ? '0' : format(Math.abs(v)))}
              />
            </g>
          </svg>
          <RowHitLayer
            rows={rows}
            plot={plot}
            rowH={rowH}
            format={format}
            positiveLabel={positiveLabel}
            negativeLabel={negativeLabel}
            onHover={setHover}
          />
        </>
      ) : null}
    </div>
  )
}

/**
 * Hit targets are full-width row bands, so they clear 24px even though the bar
 * itself is 14px thick. The layer is inset-0 of the tooltip host, so its own
 * box is the tooltip's coordinate space.
 */
function RowHitLayer({
  rows,
  plot,
  rowH,
  format,
  positiveLabel,
  negativeLabel,
  onHover
}: {
  rows: readonly BarSeriesRow[]
  plot: Plot
  rowH: number
  format: (n: number) => string
  positiveLabel: string
  negativeLabel: string
  onHover: (i: number | null) => void
}): ReactNode {
  const layerRef = useRef<HTMLDivElement>(null)
  const { show, hide } = useTooltip()
  return (
    <div
      ref={layerRef}
      className="pointer-events-none absolute inset-0"
      style={{ paddingLeft: plot.margins.left, paddingTop: plot.margins.top }}
      aria-hidden="true"
    >
      <div className="relative" style={{ width: plot.iw, height: plot.ih }}>
        {rows.map((r, i) => (
          <div
            key={r.label}
            className="pointer-events-auto absolute left-0"
            style={{ top: i * rowH, width: plot.iw, height: rowH }}
            onPointerMove={(e) => {
              onHover(i)
              const box = layerRef.current?.getBoundingClientRect()
              show({
                x: e.clientX - (box?.left ?? 0),
                y: e.clientY - (box?.top ?? 0),
                title: r.title ?? r.label,
                rows: [
                  { label: positiveLabel, value: `+${format(r.positive)}`, color: POSITIVE },
                  { label: negativeLabel, value: `−${format(r.negative)}`, color: NEGATIVE },
                  { label: 'Net', value: format(r.positive - r.negative) }
                ]
              })
            }}
            onPointerLeave={() => {
              onHover(null)
              hide()
            }}
          />
        ))}
      </div>
    </div>
  )
}

/** Identity for the two poles. Always rendered — colour never stands alone. */
export const BAR_SERIES_POLES: { positive: string; negative: string } = {
  positive: POSITIVE,
  negative: NEGATIVE
}

export function BarSeriesTable({
  rows,
  positiveLabel,
  negativeLabel,
  format = plain
}: {
  rows: readonly BarSeriesRow[]
  positiveLabel: string
  negativeLabel: string
  format?: (n: number) => string
}): ReactNode {
  return (
    <TableView
      columns={['Period', positiveLabel, negativeLabel, 'Net']}
      rows={rows.map((r) => [
        r.title ?? r.label,
        `+${format(r.positive)}`,
        `−${format(r.negative)}`,
        format(r.positive - r.negative)
      ])}
      caption="One row per period, oldest first. Both directions share one scale."
    />
  )
}
