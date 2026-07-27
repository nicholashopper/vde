import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'

/**
 * Chart primitives.
 *
 * These encode the house rules so individual charts cannot drift from them:
 *
 *   - Gridlines and axes are SOLID hairlines one shade off the surface. Never
 *     dashed — dashing reads as "threshold" or "projection" when it is just a
 *     grid.
 *   - The plot area's height budget INCLUDES the x-axis band. A container sized
 *     to the plot alone produces a card with a tiny nested scrollbar.
 *   - Marks are thin: 2px strokes, ≥8px markers, 4px rounded data-ends.
 *   - Every chart gets a hover layer by default, and every chart has a table
 *     twin so no value is reachable only by hovering.
 *   - Hit targets are ≥24px even when the mark is smaller.
 */

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export interface Size {
  width: number
  height: number
}

/** Observes an element's box. Returns zeroes until the first measurement. */
export function useMeasure<T extends HTMLElement = HTMLDivElement>(): [RefObject<T | null>, Size] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const box = entry.contentRect
      setSize((prev) =>
        Math.abs(prev.width - box.width) < 0.5 && Math.abs(prev.height - box.height) < 0.5
          ? prev
          : { width: box.width, height: box.height }
      )
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, size]
}

// ---------------------------------------------------------------------------
// Plot geometry
// ---------------------------------------------------------------------------

export interface Margins {
  top: number
  right: number
  bottom: number
  left: number
}

/** Bottom leaves room for the x-axis band; left for y tick labels. */
export const DEFAULT_MARGINS: Margins = { top: 8, right: 12, bottom: 22, left: 40 }
export const BARE_MARGINS: Margins = { top: 2, right: 2, bottom: 2, left: 2 }

export interface Plot {
  width: number
  height: number
  margins: Margins
  /** Inner plot area. */
  iw: number
  ih: number
}

export function usePlot(size: Size, margins: Margins = DEFAULT_MARGINS): Plot {
  return useMemo(
    () => ({
      width: size.width,
      height: size.height,
      margins,
      iw: Math.max(0, size.width - margins.left - margins.right),
      ih: Math.max(0, size.height - margins.top - margins.bottom)
    }),
    [size.width, size.height, margins]
  )
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

export function GridLines({
  plot,
  ticks,
  scale,
  orientation = 'horizontal'
}: {
  plot: Plot
  ticks: number[]
  scale: (v: number) => number
  orientation?: 'horizontal' | 'vertical'
}): ReactNode {
  return (
    <g aria-hidden="true">
      {ticks.map((t) =>
        orientation === 'horizontal' ? (
          <line
            key={t}
            x1={0}
            x2={plot.iw}
            y1={scale(t)}
            y2={scale(t)}
            stroke="var(--gridline)"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        ) : (
          <line
            key={t}
            y1={0}
            y2={plot.ih}
            x1={scale(t)}
            x2={scale(t)}
            stroke="var(--gridline)"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        )
      )}
    </g>
  )
}

export function AxisY({
  plot,
  ticks,
  scale,
  format
}: {
  plot: Plot
  ticks: number[]
  scale: (v: number) => number
  format: (v: number) => string
}): ReactNode {
  return (
    <g aria-hidden="true">
      {ticks.map((t) => (
        <text
          key={t}
          x={-8}
          y={scale(t)}
          dy="0.32em"
          textAnchor="end"
          className="tnum"
          fill="var(--ink-muted)"
          fontSize={10}
        >
          {format(t)}
        </text>
      ))}
      <line x1={0} x2={0} y1={0} y2={plot.ih} stroke="var(--axis)" strokeWidth={1} shapeRendering="crispEdges" />
    </g>
  )
}

export function AxisX({
  plot,
  ticks,
  scale,
  format
}: {
  plot: Plot
  ticks: number[]
  scale: (v: number) => number
  format: (v: number) => string
}): ReactNode {
  return (
    <g aria-hidden="true">
      <line
        x1={0}
        x2={plot.iw}
        y1={plot.ih}
        y2={plot.ih}
        stroke="var(--axis)"
        strokeWidth={1}
        shapeRendering="crispEdges"
      />
      {ticks.map((t) => (
        <text
          key={t}
          x={scale(t)}
          y={plot.ih + 14}
          textAnchor="middle"
          className="tnum"
          fill="var(--ink-muted)"
          fontSize={10}
        >
          {format(t)}
        </text>
      ))}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

export interface TooltipRow {
  label: string
  value: string
  /** A colour swatch is drawn when provided — identity beside the text, never
   *  colour *as* the text. */
  color?: string
}

export interface TooltipState {
  x: number
  y: number
  title: string
  rows: TooltipRow[]
}

const TooltipCtx = createContext<{
  show: (s: TooltipState) => void
  hide: () => void
} | null>(null)

/**
 * Provides a single tooltip surface for a chart card. One surface per card
 * rather than per mark keeps the DOM small on charts with thousands of marks.
 */
export function TooltipProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<TooltipState | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const value = useMemo(
    () => ({ show: (s: TooltipState) => setState(s), hide: () => setState(null) }),
    []
  )

  return (
    <TooltipCtx.Provider value={value}>
      <div ref={hostRef} className="relative h-full w-full">
        {children}
        {state ? <TooltipSurface state={state} host={hostRef} /> : null}
      </div>
    </TooltipCtx.Provider>
  )
}

function TooltipSurface({
  state,
  host
}: {
  state: TooltipState
  host: RefObject<HTMLDivElement | null>
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: state.x, top: state.y })

  // Flip the tooltip inside the card when it would overflow, so it is never
  // clipped by the card's own bounds.
  useLayoutEffect(() => {
    const el = ref.current
    const parent = host.current
    if (!el || !parent) return
    const pw = parent.clientWidth
    const ph = parent.clientHeight
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = state.x + 12
    let top = state.y + 12
    if (left + w > pw - 4) left = Math.max(4, state.x - w - 12)
    if (top + h > ph - 4) top = Math.max(4, state.y - h - 12)
    setPos({ left, top })
  }, [state.x, state.y, state.title, state.rows, host])

  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none absolute z-50 min-w-[140px] rounded-md px-2.5 py-2 text-[11px] shadow-lg"
      style={{
        left: pos.left,
        top: pos.top,
        background: 'var(--surface-3)',
        border: '1px solid var(--hairline-strong)',
        color: 'var(--ink-primary)'
      }}
    >
      <div className="mb-1 font-medium" style={{ color: 'var(--ink-primary)' }}>
        {state.title}
      </div>
      {state.rows.map((r, i) => (
        <div key={`${r.label}-${i}`} className="flex items-center justify-between gap-3 leading-5">
          <span className="flex min-w-0 items-center gap-1.5">
            {r.color ? (
              <span
                aria-hidden="true"
                className="inline-block size-2 shrink-0 rounded-[2px]"
                style={{ background: r.color }}
              />
            ) : null}
            <span className="truncate" style={{ color: 'var(--ink-secondary)' }}>
              {r.label}
            </span>
          </span>
          <span className="tnum shrink-0" style={{ color: 'var(--ink-primary)' }}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  )
}

export function useTooltip(): { show: (s: TooltipState) => void; hide: () => void } {
  const ctx = useContext(TooltipCtx)
  // A chart used outside a provider degrades to no tooltip rather than throwing.
  return ctx ?? { show: () => {}, hide: () => {} }
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

export interface LegendItem {
  name: string
  color: string
  /** Dimmed when the series is toggled off. */
  active?: boolean
}

/**
 * A legend is ALWAYS present for two or more series, so identity is never
 * carried by colour alone. A single-series chart needs none — its title names
 * the series.
 */
export function Legend({
  items,
  onToggle
}: {
  items: LegendItem[]
  onToggle?: (name: string) => void
}): ReactNode {
  if (items.length < 2) return null
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pt-2 text-[11px]">
      {items.map((it) => {
        const dim = it.active === false
        const content = (
          <>
            <span
              aria-hidden="true"
              className="inline-block size-2 shrink-0 rounded-[2px]"
              style={{ background: it.color, opacity: dim ? 0.3 : 1 }}
            />
            <span
              className="truncate"
              style={{ color: dim ? 'var(--ink-faint)' : 'var(--ink-secondary)' }}
            >
              {it.name}
            </span>
          </>
        )
        return (
          <li key={it.name} className="flex min-w-0 items-center gap-1.5">
            {onToggle ? (
              <button
                type="button"
                onClick={() => onToggle(it.name)}
                aria-pressed={!dim}
                className="flex min-h-6 min-w-0 items-center gap-1.5 rounded px-0.5"
              >
                {content}
              </button>
            ) : (
              content
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// The table twin
// ---------------------------------------------------------------------------

/**
 * Every chart ships a table view. It is the WCAG-clean equivalent and the
 * answer to "a tooltip is the only way to read this value".
 */
export function TableView({
  columns,
  rows,
  caption
}: {
  columns: string[]
  rows: (string | number)[][]
  caption?: string
}): ReactNode {
  return (
    <div className="max-h-[320px] overflow-auto" data-selectable>
      <table className="w-full border-collapse text-[11px]">
        {caption ? (
          <caption className="pb-2 text-left" style={{ color: 'var(--ink-muted)' }}>
            {caption}
          </caption>
        ) : null}
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={c}
                scope="col"
                className={`sticky top-0 border-b px-2 py-1.5 font-medium ${i === 0 ? 'text-left' : 'text-right'}`}
                style={{
                  background: 'var(--surface-1)',
                  borderColor: 'var(--hairline)',
                  color: 'var(--ink-secondary)'
                }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((cell, ci) => (
                <td
                  key={ci}
                  className={`border-b px-2 py-1 ${ci === 0 ? 'text-left' : 'tnum text-right'}`}
                  style={{ borderColor: 'var(--hairline)', color: 'var(--ink-primary)' }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Toggles a chart between its plot and its table twin. */
export function ChartCard({
  title,
  subtitle,
  actions,
  height,
  chart,
  table,
  legend
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
  /** Plot height in px. The x-axis band is inside this budget. */
  height: number
  chart: ReactNode
  table?: ReactNode
  legend?: ReactNode
}): ReactNode {
  const [showTable, setShowTable] = useState(false)
  return (
    <section className="card flex flex-col overflow-hidden">
      <header className="flex items-start justify-between gap-3 px-3.5 pt-3 pb-1.5">
        <div className="min-w-0">
          <h2 className="truncate text-[12px] font-medium" style={{ color: 'var(--ink-primary)' }}>
            {title}
          </h2>
          {subtitle ? (
            <p className="truncate text-[11px]" style={{ color: 'var(--ink-muted)' }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {table ? (
            <button
              type="button"
              onClick={() => setShowTable((v) => !v)}
              aria-pressed={showTable}
              title={showTable ? 'Show chart' : 'Show data table'}
              className="rounded px-1.5 py-0.5 text-[10px] transition-colors"
              style={{
                color: showTable ? 'var(--ink-primary)' : 'var(--ink-muted)',
                background: showTable ? 'var(--surface-3)' : 'transparent'
              }}
            >
              Table
            </button>
          ) : null}
        </div>
      </header>
      <div className="min-h-0 flex-1 px-3.5 pb-3">
        {showTable && table ? table : <div style={{ height }}>{chart}</div>}
        {!showTable ? legend : null}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Shared behaviour
// ---------------------------------------------------------------------------

/**
 * Tracks pointer position within an SVG plot and reports the nearest index.
 * Used for the crosshair on line and area charts, where landing on a 2px line
 * is not a reasonable thing to ask of anyone.
 */
export function useNearestIndex(
  plot: Plot,
  count: number
): {
  index: number | null
  handlers: {
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => void
    onPointerLeave: () => void
  }
  pointer: { x: number; y: number }
} {
  const [index, setIndex] = useState<number | null>(null)
  const [pointer, setPointer] = useState({ x: 0, y: 0 })

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const x = e.clientX - rect.left - plot.margins.left
      const y = e.clientY - rect.top - plot.margins.top
      setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      if (count <= 1 || plot.iw <= 0) {
        setIndex(count > 0 ? 0 : null)
        return
      }
      const t = Math.min(1, Math.max(0, x / plot.iw))
      setIndex(Math.round(t * (count - 1)))
      void y
    },
    [plot.iw, plot.margins.left, plot.margins.top, count]
  )

  const onPointerLeave = useCallback(() => setIndex(null), [])

  return { index, handlers: { onPointerMove, onPointerLeave }, pointer }
}

/** Nice round tick values covering [0, max]. */
export function niceTicks(max: number, target = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0]
  const raw = max / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  const out: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Number(v.toFixed(10)))
  return out
}

/** Holds the previous render at reduced opacity instead of flashing a skeleton. */
export function useHeldValue<T>(value: T, isLoading: boolean): { value: T; stale: boolean } {
  const held = useRef(value)
  useEffect(() => {
    if (!isLoading) held.current = value
  }, [value, isLoading])
  return isLoading && held.current !== undefined
    ? { value: held.current, stale: true }
    : { value, stale: false }
}
