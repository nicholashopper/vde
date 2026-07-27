import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type {
  Finding,
  HealthStatus,
  RepoReport,
  SignalDelta,
  SignalDriver,
  SignalId,
  SignalUnit,
  SignalValue
} from '../../shared/types'
import { HEALTH_STATUS_ORDER } from '../../shared/types'
import { SIGNALS, formatSignal, statusFor } from '../../shared/signals'
import { STATUS_LABEL, STATUS_VAR, STATUS_WASH, deltaColor, deltaGlyph } from '../lib/colors'
import { ellipsisPath, plain, shortDate } from '../lib/format'
import { useStore } from '../store'
import {
  AxisX,
  AxisY,
  ChartCard,
  GridLines,
  Legend,
  TableView,
  TooltipProvider,
  niceTicks,
  useMeasure,
  useNearestIndex,
  usePlot,
  useTooltip,
  type LegendItem,
  type Margins
} from './charts/primitives'
import { EMPTY_SERIES, formatDelta, splitValue, tightSuffix, type SignalSeries } from './SignalTile'
import { StatusPip } from './ui/StatusPip'

/**
 * The drill-down for one signal.
 *
 * The tile answers "how bad and which way"; this answers "why does that matter
 * and what is causing it". The `why` text is the education layer — without it a
 * number like "45.8%" is trivia rather than a diagnosis.
 */

const PANEL_MARGINS: Margins = { top: 10, right: 16, bottom: 22, left: 46 }
const LINE = 'var(--series-1)'
const MAX_DRIVERS = 50
const MAX_CLUSTER_MEMBERS = 40
const MAX_FINDING_PATHS = 8

// ---------------------------------------------------------------------------
// Small helpers, local to the drawer
// ---------------------------------------------------------------------------

function formatMetric(value: number, unit: SignalUnit): string {
  const v = Number.isFinite(value) ? value : 0
  switch (unit) {
    case 'percent':
      return `${v.toFixed(1)}%`
    case 'ratio':
      return `${v.toFixed(2)}×`
    case 'days':
      return `${plain(v)} days`
    case 'lines':
      return `${plain(v)} lines`
    case 'files':
      return `${plain(v)} files`
    default:
      return plain(v)
  }
}

/** Driver values arrive unitless — show integers whole and fractions to 1dp. */
function formatDriverValue(v: number): string {
  if (!Number.isFinite(v)) return '—'
  return Number.isInteger(v) ? plain(v) : v.toFixed(1)
}

const KIND_LABEL: Record<SignalDriver['kind'], string> = {
  file: 'file',
  directory: 'directory',
  commit: 'commit',
  cluster: 'cluster',
  author: 'author'
}

function evenIndices(count: number, target = 4): number[] {
  if (count <= 0) return []
  if (count <= target) return Array.from({ length: count }, (_, i) => i)
  const step = (count - 1) / (target - 1)
  const out: number[] = []
  for (let k = 0; k < target; k += 1) out.push(Math.round(k * step))
  return [...new Set(out)]
}

// ---------------------------------------------------------------------------
// The trend plot
// ---------------------------------------------------------------------------

interface Band {
  status: HealthStatus
  lo: number
  hi: number
}

function TrendPlot({
  id,
  series,
  yMax,
  ticks,
  bands
}: {
  id: SignalId
  series: SignalSeries
  yMax: number
  ticks: number[]
  bands: Band[]
}): ReactNode {
  const [ref, size] = useMeasure<HTMLDivElement>()
  const plot = usePlot(size, PANEL_MARGINS)
  const count = series.values.length
  const { index, handlers, pointer } = useNearestIndex(plot, count)
  const { show, hide } = useTooltip()

  const xAt = useCallback(
    (i: number): number => (count <= 1 ? plot.iw / 2 : (i / (count - 1)) * plot.iw),
    [count, plot.iw]
  )
  const yAt = useCallback(
    (v: number): number => plot.ih - (Math.max(0, Math.min(yMax, v)) / yMax) * plot.ih,
    [plot.ih, yMax]
  )

  const path = useMemo(() => {
    if (plot.iw <= 0 || plot.ih <= 0) return ''
    return series.values
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`)
      .join(' ')
  }, [series.values, xAt, yAt, plot.iw, plot.ih])

  const hoveredValue = index != null ? series.values[index] : undefined
  const hoveredDate = index != null ? series.dates[index] : undefined

  useEffect(() => {
    if (hoveredValue === undefined) {
      hide()
      return
    }
    show({
      x: pointer.x,
      y: pointer.y,
      title: hoveredDate ? shortDate(hoveredDate) : 'Snapshot',
      rows: [
        { label: SIGNALS[id].label, value: formatSignal(id, hoveredValue), color: LINE },
        { label: 'Band', value: STATUS_LABEL[statusFor(id, hoveredValue)] }
      ]
    })
  }, [hoveredValue, hoveredDate, pointer.x, pointer.y, id, show, hide])

  useEffect(() => () => hide(), [hide])

  const first = series.values[0]
  const last = series.values[count - 1]
  const summary =
    first === undefined || last === undefined
      ? `${SIGNALS[id].label}: no history yet`
      : `${SIGNALS[id].label} over ${count} snapshots, from ${formatSignal(id, first)} to ${formatSignal(
          id,
          last
        )}. Currently in the ${STATUS_LABEL[statusFor(id, last)]} band.`

  const xTicks = evenIndices(count)
  const ready = plot.iw > 0 && plot.ih > 0

  return (
    <div ref={ref} className="h-full w-full">
      {ready ? (
        <svg
          width={plot.width}
          height={plot.height}
          role="img"
          aria-label={summary}
          className="block touch-none"
          {...handlers}
        >
          <g transform={`translate(${plot.margins.left},${plot.margins.top})`}>
            {/* Status bands: very faint zones so the reader can see which band
                the line has been in over time. Never the only cue — the pip and
                the tooltip both name the band in words. */}
            <g aria-hidden="true">
              {bands.map((b) => {
                const top = yAt(b.hi)
                const h = yAt(b.lo) - top
                if (h <= 0) return null
                return (
                  <rect
                    key={b.status}
                    x={0}
                    y={top}
                    width={plot.iw}
                    height={h}
                    fill={STATUS_WASH[b.status]}
                    opacity={0.6}
                  />
                )
              })}
              {/* Each threshold gets a solid hairline in the colour of the band
                  it opens, so the crossing point is exact rather than inferred
                  from two very faint washes meeting. */}
              {bands.map((b) =>
                b.lo > 0 && b.lo < yMax ? (
                  <line
                    key={`edge-${b.status}`}
                    x1={0}
                    x2={plot.iw}
                    y1={yAt(b.lo)}
                    y2={yAt(b.lo)}
                    stroke={STATUS_VAR[b.status]}
                    strokeWidth={1}
                    opacity={0.45}
                    shapeRendering="crispEdges"
                  />
                ) : null
              )}
            </g>

            <GridLines plot={plot} ticks={ticks} scale={yAt} />

            {series.baselineIndex != null && count > 1 ? (
              <line
                x1={xAt(series.baselineIndex)}
                x2={xAt(series.baselineIndex)}
                y1={0}
                y2={plot.ih}
                stroke="var(--axis)"
                strokeWidth={1}
                shapeRendering="crispEdges"
                aria-hidden="true"
              />
            ) : null}

            {count > 1 ? (
              <path
                d={path}
                fill="none"
                stroke={LINE}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}

            {last !== undefined ? (
              <circle
                cx={xAt(count - 1)}
                cy={yAt(last)}
                r={4}
                fill={LINE}
                stroke="var(--surface-1)"
                strokeWidth={2}
              />
            ) : null}

            {index != null && hoveredValue !== undefined ? (
              <g aria-hidden="true">
                <line
                  x1={xAt(index)}
                  x2={xAt(index)}
                  y1={0}
                  y2={plot.ih}
                  stroke="var(--ink-faint)"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <circle
                  cx={xAt(index)}
                  cy={yAt(hoveredValue)}
                  r={4}
                  fill={LINE}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              </g>
            ) : null}

            <AxisY
              plot={plot}
              ticks={ticks}
              scale={yAt}
              format={(v) => `${Number.isInteger(v) ? v : Number(v.toFixed(1))}${tightSuffix(id)}`}
            />
            <AxisX
              plot={plot}
              ticks={xTicks}
              scale={xAt}
              format={(i) => shortDate(series.dates[i] ?? '')}
            />
          </g>
        </svg>
      ) : null}
    </div>
  )
}

function TrendCard({ id, series }: { id: SignalId; series: SignalSeries }): ReactNode {
  const def = SIGNALS[id]
  const count = series.values.length

  const { yMax, ticks, bands } = useMemo(() => {
    const t = def.thresholds
    const dataMax = count > 0 ? Math.max(...series.values) : 0
    const raw = Math.max(dataMax * 1.08, t.serious * 1.12, 1)
    const tk = niceTicks(raw, 4)
    const topTick = tk[tk.length - 1] ?? raw
    const top = Math.max(raw, topTick)
    const b: Band[] = [
      { status: 'good', lo: 0, hi: Math.min(t.good, top) },
      { status: 'warning', lo: Math.min(t.good, top), hi: Math.min(t.warning, top) },
      { status: 'serious', lo: Math.min(t.warning, top), hi: Math.min(t.serious, top) },
      { status: 'critical', lo: Math.min(t.serious, top), hi: top }
    ]
    return { yMax: top, ticks: tk, bands: b }
  }, [def.thresholds, series.values, count])

  const rows = useMemo(
    () =>
      series.values
        .map((v, i) => [
          shortDate(series.dates[i] ?? ''),
          formatSignal(id, v),
          STATUS_LABEL[statusFor(id, v)]
        ])
        .reverse(),
    [series.values, series.dates, id]
  )

  const bandCaption = `Bands: healthy up to ${formatSignal(id, def.thresholds.good)}, watch to ${formatSignal(
    id,
    def.thresholds.warning
  )}, serious to ${formatSignal(id, def.thresholds.serious)}, critical above.`

  // The bands are a colour encoding, so they get a key with words beside the
  // swatches. Solid status colours read at 8px where the band wash would not.
  const bandKey: LegendItem[] = [
    { name: `Healthy ≤ ${formatSignal(id, def.thresholds.good)}`, color: STATUS_VAR.good },
    { name: `Watch ≤ ${formatSignal(id, def.thresholds.warning)}`, color: STATUS_VAR.warning },
    { name: `Serious ≤ ${formatSignal(id, def.thresholds.serious)}`, color: STATUS_VAR.serious },
    { name: `Critical > ${formatSignal(id, def.thresholds.serious)}`, color: STATUS_VAR.critical }
  ]

  if (count === 0) {
    return (
      <section className="card px-3.5 py-3">
        <h3 className="text-[12px] font-medium" style={{ color: 'var(--ink-primary)' }}>
          Trend
        </h3>
        <p className="mt-1 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
          No snapshots carry this signal yet. A history appears after the next scan.
        </p>
      </section>
    )
  }

  return (
    <ChartCard
      title={`${def.label} over time`}
      subtitle={
        series.baselineIndex != null
          ? `${count} snapshots · the vertical rule marks the baseline`
          : `${count} snapshots`
      }
      height={210}
      chart={
        <TooltipProvider>
          <TrendPlot id={id} series={series} yMax={yMax} ticks={ticks} bands={bands} />
        </TooltipProvider>
      }
      legend={<Legend items={bandKey} />}
      table={
        <TableView
          columns={['Snapshot', def.label, 'Band']}
          rows={rows}
          caption={`${count} snapshots, newest first. ${bandCaption}`}
        />
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

function DriverRow({
  driver,
  rank,
  repoId
}: {
  driver: SignalDriver
  rank: number
  repoId: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef<number | null>(null)
  const path = driver.path
  const members = driver.members ?? []
  const expandable = driver.kind === 'cluster' && members.length > 0

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  // A driver can name a file that no longer exists — high File Thrash is
  // exactly the case where that happens — so a failed reveal has to say so
  // rather than looking like a dead button.
  const reveal = useCallback(() => {
    if (!path) return
    window.vde.app.revealFile(repoId, path).catch(() => {
      setFailed(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setFailed(false), 5000)
    })
  }, [repoId, path])

  return (
    <li className="border-b last:border-b-0" style={{ borderColor: 'var(--hairline)' }}>
      <div className="flex items-start gap-2 py-1.5">
        <span
          className="tnum w-5 shrink-0 pt-px text-right text-[10px]"
          style={{ color: 'var(--ink-faint)' }}
        >
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className="min-w-0 flex-1 truncate text-[12px]"
              style={{ color: 'var(--ink-primary)' }}
              title={path ?? driver.label}
            >
              {driver.kind === 'file' || driver.kind === 'directory'
                ? ellipsisPath(driver.label, 52)
                : driver.label}
            </span>
            <span
              className="tnum shrink-0 text-[12px]"
              style={{ color: 'var(--ink-secondary)' }}
            >
              {formatDriverValue(driver.value)}
            </span>
          </div>
          {driver.detail ? (
            <p className="truncate text-[11px]" style={{ color: 'var(--ink-muted)' }}>
              {driver.detail}
            </p>
          ) : null}
          {failed ? (
            <p role="status" className="text-[11px]" style={{ color: 'var(--status-warning)' }}>
              Could not reveal this path — it may have been deleted since the last scan.
            </p>
          ) : null}
          {expandable && open ? (
            <ul className="mt-1 mb-1 list-none space-y-0.5" data-selectable>
              {members.slice(0, MAX_CLUSTER_MEMBERS).map((m) => (
                <li
                  key={m}
                  className="truncate font-mono text-[10.5px]"
                  style={{ color: 'var(--ink-secondary)' }}
                  title={m}
                >
                  {ellipsisPath(m, 60)}
                </li>
              ))}
              {members.length > MAX_CLUSTER_MEMBERS ? (
                <li className="text-[10.5px]" style={{ color: 'var(--ink-faint)' }}>
                  +{members.length - MAX_CLUSTER_MEMBERS} more
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {expandable ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="min-h-6 rounded-[4px] px-1.5 text-[10px] transition-colors hover:bg-surface-3"
              style={{ color: 'var(--ink-muted)' }}
            >
              {open ? 'Hide' : `${members.length} files`}
            </button>
          ) : null}
          {driver.kind === 'file' && path ? (
            <button
              type="button"
              onClick={reveal}
              aria-label={`Reveal ${path} in the file manager`}
              className="min-h-6 rounded-[4px] px-1.5 text-[10px] transition-colors hover:bg-surface-3"
              style={{ color: 'var(--ink-muted)' }}
            >
              Reveal
            </button>
          ) : (
            <span className="px-1.5 text-[10px]" style={{ color: 'var(--ink-faint)' }}>
              {KIND_LABEL[driver.kind]}
            </span>
          )}
        </div>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * A finding, at drawer density.
 *
 * Deliberately NOT the shared components/FindingCard: that one is the Findings
 * screen's unit of work and carries brief-selection state ("In brief") which is
 * meaningless here, plus a much wider layout than a 600px panel. Same content,
 * different context, so a different rendering.
 */
function SignalFinding({ finding }: { finding: Finding }): ReactNode {
  return (
    <article
      className="rounded-[8px] border border-hairline p-3"
      style={{ background: 'var(--surface-2)' }}
    >
      <header className="flex items-start justify-between gap-2">
        <h4 className="text-[12px] font-medium" style={{ color: 'var(--ink-primary)' }}>
          {finding.title}
        </h4>
        <StatusPip status={finding.severity} />
      </header>
      <p
        className="mt-1.5 text-[11.5px] leading-relaxed"
        style={{ color: 'var(--ink-secondary)' }}
        data-selectable
      >
        {finding.detail}
      </p>
      <p className="tnum mt-1.5 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
        {finding.metric.label}: {formatMetric(finding.metric.value, finding.metric.unit)}
      </p>
      {finding.paths.length > 0 ? (
        <ul className="mt-1.5 list-none space-y-0.5" data-selectable>
          {finding.paths.slice(0, MAX_FINDING_PATHS).map((p) => (
            <li
              key={p}
              className="truncate font-mono text-[10.5px]"
              style={{ color: 'var(--ink-muted)' }}
              title={p}
            >
              {ellipsisPath(p, 60)}
            </li>
          ))}
          {finding.paths.length > MAX_FINDING_PATHS ? (
            <li className="text-[10.5px]" style={{ color: 'var(--ink-faint)' }}>
              +{finding.paths.length - MAX_FINDING_PATHS} more
            </li>
          ) : null}
        </ul>
      ) : null}
      <div
        className="mt-2.5 border-l-2 pl-2.5"
        style={{ borderColor: 'var(--hairline-strong)' }}
        data-selectable
      >
        <p
          className="text-[10px] tracking-wide uppercase"
          style={{ color: 'var(--ink-faint)' }}
        >
          Remediation
        </p>
        <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
          {finding.remediation}
        </p>
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function DrawerPanel({
  signal,
  delta,
  series,
  findings,
  repoId,
  baselineLabel,
  onClose
}: {
  signal: SignalValue
  delta: SignalDelta | undefined
  series: SignalSeries
  findings: Finding[]
  repoId: string
  baselineLabel: string
  onClose(): void
}): ReactNode {
  const def = SIGNALS[signal.id]
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const [entered, setEntered] = useState(false)

  // Escape closes, Tab is trapped, and focus returns to whatever opened the
  // drawer — which is the tile, because clicking it focused it.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const raf = requestAnimationFrame(() => {
      setEntered(true)
      closeRef.current?.focus()
    })

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) {
        e.preventDefault()
        return
      }
      const active = document.activeElement
      const inside = active instanceof Node && panel.contains(active)
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown, true)
      previous?.focus()
    }
  }, [onClose])

  const { body, unit } = splitValue(signal.id, signal.value)
  const drivers = signal.drivers.slice(0, MAX_DRIVERS)

  return createPortal(
    <div className="fixed inset-0 z-50">
      {/* Scrim. Click-to-close only — keyboard users get Escape and the close
          button, so this stays out of the tab order and out of the a11y tree
          rather than duplicating the close button's name. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0"
        style={{ background: 'color-mix(in srgb, var(--plane) 72%, transparent)' }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-y-0 right-0 flex w-full max-w-[600px] flex-col"
        style={{
          background: 'var(--surface-1)',
          borderLeft: '1px solid var(--hairline-strong)',
          transform: entered ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 160ms ease-out'
        }}
      >
        <header
          className="flex shrink-0 items-start justify-between gap-3 border-b px-4 pt-4 pb-3"
          style={{ borderColor: 'var(--hairline)' }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2
                id={titleId}
                className="truncate text-[14px] font-medium"
                style={{ color: 'var(--ink-primary)' }}
              >
                {def.label}
              </h2>
              <StatusPip status={signal.status} size="md" wash />
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span
                className="figure text-[30px] leading-none"
                style={{ color: 'var(--ink-primary)' }}
              >
                {body}
              </span>
              {unit ? (
                <span className="text-[13px]" style={{ color: 'var(--ink-muted)' }}>
                  {unit}
                </span>
              ) : null}
              {delta ? (
                <span
                  className="tnum flex items-baseline gap-1 text-[13px]"
                  style={{ color: deltaColor(delta.direction) }}
                >
                  <span aria-hidden="true" className="text-[10px]">
                    {deltaGlyph(delta.direction)}
                  </span>
                  <span>{formatDelta(signal.id, delta.absolute)}</span>
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
              {signal.headline}
              {delta ? ` · vs ${baselineLabel}` : null}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close signal details"
            className="-mt-1 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-[4px] text-[14px] transition-colors hover:bg-surface-3"
            style={{ color: 'var(--ink-muted)' }}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <section>
            <h3
              className="mb-1 text-[10px] tracking-wide uppercase"
              style={{ color: 'var(--ink-faint)' }}
            >
              Why this matters
            </h3>
            <p
              className="text-[12px] leading-relaxed"
              style={{ color: 'var(--ink-secondary)' }}
              data-selectable
            >
              {def.why}
            </p>
            <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
              Measures {def.measures}. Higher is worse.
            </p>
          </section>

          <TrendCard id={signal.id} series={series} />

          <section>
            <h3
              className="mb-1 text-[10px] tracking-wide uppercase"
              style={{ color: 'var(--ink-faint)' }}
            >
              Top {def.driverNoun === 'day' ? 'days' : `${def.driverNoun}s`}
              {signal.drivers.length > 0 ? ` (${drivers.length})` : ''}
            </h3>
            {drivers.length === 0 ? (
              <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                Nothing is driving this signal — it has no ranked contributors.
              </p>
            ) : (
              <ul className="list-none">
                {drivers.map((d, i) => (
                  <DriverRow
                    key={`${d.kind}-${d.path ?? d.sha ?? d.label}-${i}`}
                    driver={d}
                    rank={i + 1}
                    repoId={repoId}
                  />
                ))}
              </ul>
            )}
            {signal.drivers.length > MAX_DRIVERS ? (
              <p className="mt-1.5 text-[10.5px]" style={{ color: 'var(--ink-faint)' }}>
                Showing the worst {MAX_DRIVERS} of {signal.drivers.length}.
              </p>
            ) : null}
          </section>

          {findings.length > 0 ? (
            <section>
              <h3
                className="mb-1.5 text-[10px] tracking-wide uppercase"
                style={{ color: 'var(--ink-faint)' }}
              >
                Findings ({findings.length})
              </h3>
              <div className="space-y-2">
                {findings.map((f) => (
                  <SignalFinding key={f.id} finding={f} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  )
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface SignalDrawerProps {
  report: RepoReport
  series: Record<SignalId, SignalSeries>
}

export function SignalDrawer({ report, series }: SignalDrawerProps): ReactNode {
  const openSignal = useStore((s) => s.openSignal)
  const setOpenSignal = useStore((s) => s.setOpenSignal)
  const close = useCallback(() => setOpenSignal(null), [setOpenSignal])

  const signal = openSignal ? report.signals.find((s) => s.id === openSignal) : undefined
  if (!openSignal || !signal) return null

  const delta = report.deltas.find((d) => d.id === openSignal)
  const findings = report.findings
    .filter((f) => f.signalId === openSignal)
    .slice()
    .sort(
      (a, b) =>
        HEALTH_STATUS_ORDER.indexOf(b.severity) - HEALTH_STATUS_ORDER.indexOf(a.severity)
    )

  return (
    <DrawerPanel
      key={openSignal}
      signal={signal}
      delta={delta}
      series={series[openSignal] ?? EMPTY_SERIES}
      findings={findings}
      repoId={report.repo.id}
      baselineLabel={report.baseline.label}
      onClose={close}
    />
  )
}

export default SignalDrawer
