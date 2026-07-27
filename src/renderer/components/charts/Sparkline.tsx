import { useMemo, type ReactNode } from 'react'
import { useMeasure } from './primitives'

/**
 * A small-multiple trend line: no axes, no labels, no legend.
 *
 * Every sparkline in VDE is a SINGLE series, so its colour carries no identity —
 * which is exactly why all fourteen tiles draw the same hue. In a small-multiple
 * grid the differences must live in the data, not in the palette. Status is
 * carried elsewhere on the tile (the pip and the threshold bar), never here.
 *
 * The root element is a <span class="block"> so a sparkline is valid phrasing
 * content inside a <button> — the tiles and mover cards are buttons.
 */

export interface SparklineProps {
  /** Oldest → newest. Non-finite values must be filtered by the caller. */
  values: readonly number[]
  /** Index of the baseline point; a vertical hairline marks it. */
  baselineIndex?: number | null
  /** Reserved height in px, held even when there is nothing to draw. */
  height?: number
  /** Stroke and area hue. */
  color?: string
  /** Ring around the endpoint marker — set to the surface it sits on. */
  ringColor?: string
  /** Names the series in the accessible summary. */
  label: string
  /** Formats a value for the accessible summary. */
  format?: (v: number) => string
  className?: string
}

const PAD_Y = 6
const PAD_L = 1
const PAD_R = 6

interface Point {
  x: number
  y: number
}

interface Geometry {
  points: Point[]
  line: string
  area: string
  last: Point
  baselineX: number | null
}

function defaultFormat(v: number): string {
  return String(Math.round(v * 10) / 10)
}

export function Sparkline({
  values,
  baselineIndex = null,
  height = 40,
  color = 'var(--series-1)',
  ringColor = 'var(--surface-1)',
  label,
  format = defaultFormat,
  className
}: SparklineProps): ReactNode {
  const [ref, size] = useMeasure<HTMLSpanElement>()
  const width = size.width
  const count = values.length

  const geom = useMemo<Geometry | null>(() => {
    if (count === 0 || width <= 0) return null

    const innerW = Math.max(1, width - PAD_L - PAD_R)
    const innerH = Math.max(1, height - PAD_Y * 2)

    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const v of values) {
      if (v < min) min = v
      if (v > max) max = v
    }
    // All-equal (or single-point) series draw a flat centre line rather than
    // dividing by a zero span.
    const span = max - min
    const flat = !(span > 1e-9)

    const xAt = (i: number): number =>
      count === 1 ? PAD_L + innerW / 2 : PAD_L + (i / (count - 1)) * innerW
    const yAt = (v: number): number =>
      flat ? PAD_Y + innerH / 2 : PAD_Y + (1 - (v - min) / span) * innerH

    const points = values.map((v, i) => ({ x: xAt(i), y: yAt(v) }))
    const first = points[0]
    const last = points[points.length - 1]
    if (!first || !last) return null

    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
    const area =
      count < 2
        ? ''
        : `${line} L${last.x.toFixed(2)},${height} L${first.x.toFixed(2)},${height} Z`

    const bi =
      baselineIndex != null && baselineIndex >= 0 && baselineIndex < count ? xAt(baselineIndex) : null

    return { points, line, area, last, baselineX: bi }
  }, [values, width, height, count, baselineIndex])

  const summary = useMemo(() => {
    if (count === 0) return `${label}: no history yet`
    const first = values[0]
    const last = values[count - 1]
    if (first === undefined || last === undefined) return `${label}: no history yet`
    if (count === 1) return `${label}: a single snapshot at ${format(first)}`
    const a = format(first)
    const b = format(last)
    const trend = a === b ? 'flat' : last > first ? 'rising' : 'falling'
    return `${label} over ${count} snapshots, ${a} to ${b}, ${trend}`
  }, [values, count, label, format])

  // Zero points: reserve the height and draw nothing.
  if (count === 0) {
    return <span ref={ref} aria-hidden="true" className={`block w-full ${className ?? ''}`} style={{ height }} />
  }

  return (
    <span ref={ref} className={`block w-full ${className ?? ''}`} style={{ height }}>
      {geom ? (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={summary}
          className="block"
        >
          {geom.baselineX != null ? (
            <line
              x1={geom.baselineX}
              x2={geom.baselineX}
              y1={0}
              y2={height}
              stroke="var(--axis)"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ) : null}
          {geom.area ? <path d={geom.area} fill={color} opacity={0.1} /> : null}
          {count > 1 ? (
            <path
              d={geom.line}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
          <circle
            cx={geom.last.x}
            cy={geom.last.y}
            r={4}
            fill={color}
            stroke={ringColor}
            strokeWidth={2}
          />
        </svg>
      ) : null}
    </span>
  )
}

export default Sparkline
