import { useMemo, type ReactNode } from 'react'
import type { RepoReport, SnapshotPoint, TimelineBucket } from '../../shared/types'
import { CommitList, CommitListTable } from '../components/CommitList'
import {
  BAR_SERIES_POLES,
  BarSeries,
  BarSeriesTable,
  barSeriesHeight,
  type BarSeriesRow
} from '../components/charts/BarSeries'
import {
  CommitTimeline,
  CommitTimelineKey,
  CommitTimelineTable
} from '../components/charts/CommitTimeline'
import {
  StackedArea,
  StackedAreaTable,
  parseDayLocal,
  type StackedAreaPoint,
  type StackedAreaSeries
} from '../components/charts/StackedArea'
import { ChartCard, Legend, useHeldValue } from '../components/charts/primitives'
import { SERIES_OTHER, foldToTopN, seriesScale } from '../lib/colors'
import { compact, fullDate, plain } from '../lib/format'
import { useStore } from '../store'

/**
 * "What happened to this repo over time?"
 *
 * Every chart on this screen is drawn against ONE x-domain — the repository's
 * full history — so the four plots stack into a single instrument rather than
 * four unrelated pictures. There is no filter row here: the baseline control in
 * the TopBar scopes the whole screen, and per-chart filters are exactly the
 * thing that breaks a shared reading.
 */

const DAY_MS = 86_400_000
const OTHER = 'Other'
const COMPOSITION_OTHER = 'Config & other'
/** Keeps the diverging bar chart small enough to read in one glance. */
const MAX_PERIOD_ROWS = 6

const PERIOD_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

function periodLabel(startMs: number, endMs: number, single: boolean): string {
  if (single) return PERIOD_LABEL.format(startMs)
  return `${PERIOD_LABEL.format(startMs)}–${PERIOD_LABEL.format(endMs)}`
}

/** Inclusive local-midnight range covering everything the report knows about. */
function computeDomain(report: RepoReport): readonly [number, number] {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  const consider = (ms: number): void => {
    if (!Number.isFinite(ms)) return
    if (ms < lo) lo = ms
    if (ms > hi) hi = ms
  }
  for (const b of report.timeline) consider(parseDayLocal(b.date))
  for (const s of report.snapshots) consider(parseDayLocal(s.date))
  // Commit timestamps are full ISO strings; floor them to local midnight so the
  // domain is expressed in the same calendar-day units the buckets are.
  for (const iso of [report.repo.firstCommitAt, report.repo.lastCommitAt]) {
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) continue
    const d = new Date(t)
    consider(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime())
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    const today = new Date()
    const t = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    return [t, t + DAY_MS]
  }
  return [lo, hi > lo ? hi : lo + DAY_MS]
}

interface LanguageMix {
  points: StackedAreaPoint[]
  series: StackedAreaSeries[]
}

/**
 * Language mix by lines.
 *
 * The colour scale is built from the FULL ordered language list — ranked by
 * total lines across every snapshot, not by the current slice — so a language
 * keeps its hue as the mix shifts underneath it. Everything past the top seven
 * folds into one grey "Other"; there is no ninth categorical colour to spend.
 */
function buildLanguageMix(snapshots: readonly SnapshotPoint[]): LanguageMix {
  const flat = snapshots.flatMap((s) => s.languages)
  const folded = foldToTopN(flat, (l) => l.language, (l) => l.lines, 7)
  const named = folded.names.filter((n) => n !== OTHER)
  const scale = seriesScale(named)
  const keep = new Set(named)
  const hasOther = folded.names.includes(OTHER)

  const series: StackedAreaSeries[] = [
    ...named.map((name) => ({ name, color: scale(name) })),
    ...(hasOther ? [{ name: OTHER, color: SERIES_OTHER }] : [])
  ]

  const points: StackedAreaPoint[] = snapshots.map((s) => {
    const values: Record<string, number> = {}
    for (const def of series) values[def.name] = 0
    for (const l of s.languages) {
      const key = keep.has(l.language) ? l.language : OTHER
      if (!(key in values)) values[key] = 0
      values[key] = (values[key] ?? 0) + Math.max(0, l.lines)
    }
    return { date: s.date, values }
  })

  return { points, series }
}

/**
 * Code composition.
 *
 * SnapshotPoint carries source/doc/test line counts but not the config count
 * that SnapshotFacts has, so the fourth band is derived as the residual
 * (total − source − test − doc) and named for what it actually is. Being a
 * residual it takes the "Other" grey rather than a fourth categorical hue.
 */
function buildComposition(snapshots: readonly SnapshotPoint[]): LanguageMix {
  const named = ['Source', 'Tests', 'Docs']
  const scale = seriesScale(named)
  const series: StackedAreaSeries[] = [
    ...named.map((name) => ({ name, color: scale(name) })),
    { name: COMPOSITION_OTHER, color: SERIES_OTHER }
  ]
  const points: StackedAreaPoint[] = snapshots.map((s) => ({
    date: s.date,
    values: {
      Source: Math.max(0, s.sourceLines),
      Tests: Math.max(0, s.testLines),
      Docs: Math.max(0, s.docLines),
      [COMPOSITION_OTHER]: Math.max(0, s.totalLines - s.sourceLines - s.testLines - s.docLines)
    }
  }))
  return { points, series }
}

/**
 * Buckets the daily timeline into at most six equal periods spanning the whole
 * domain. Weekly where the history is short; coarser whole-week multiples once
 * it is long, so every row keeps a 24px hit target without the card growing
 * into a wall of hairlines.
 */
function buildPeriods(
  buckets: readonly TimelineBucket[],
  domain: readonly [number, number]
): BarSeriesRow[] {
  const [start, end] = domain
  const days = Math.max(1, Math.round((end - start) / DAY_MS) + 1)
  const weeks = Math.ceil(days / 7)
  const weeksPerRow = Math.max(1, Math.ceil(weeks / MAX_PERIOD_ROWS))
  const rowSpan = weeksPerRow * 7
  const rowCount = Math.max(1, Math.min(MAX_PERIOD_ROWS, Math.ceil(days / rowSpan)))

  const anchor = new Date(start)
  const rows: BarSeriesRow[] = []
  for (let i = 0; i < rowCount; i += 1) {
    const from = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + i * rowSpan)
    const lastDay = new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate() + (i + 1) * rowSpan - 1
    )
    rows.push({
      label: periodLabel(from.getTime(), lastDay.getTime(), rowSpan === 7),
      title:
        rowSpan === 7
          ? `Week of ${fullDate(new Date(from).toISOString())}`
          : `${fullDate(new Date(from).toISOString())} – ${fullDate(new Date(lastDay).toISOString())}`,
      positive: 0,
      negative: 0
    })
  }

  for (const b of buckets) {
    const ms = parseDayLocal(b.date)
    if (!Number.isFinite(ms)) continue
    const offsetDays = Math.round((ms - start) / DAY_MS)
    const idx = Math.min(rowCount - 1, Math.max(0, Math.floor(offsetDays / rowSpan)))
    const row = rows[idx]
    if (!row) continue
    row.positive += b.insertions
    row.negative += b.deletions
  }

  return rows
}

export function Timeline(): ReactNode {
  const report = useStore((s) => s.report)
  const loading = useStore((s) => s.loading)
  const error = useStore((s) => s.reportError)
  const held = useHeldValue(report, loading)
  const active = held.value

  const domain = useMemo(
    () => (active ? computeDomain(active) : ([0, DAY_MS] as const)),
    [active]
  )
  const mix = useMemo(
    () => (active ? buildLanguageMix(active.snapshots) : { points: [], series: [] }),
    [active]
  )
  const composition = useMemo(
    () => (active ? buildComposition(active.snapshots) : { points: [], series: [] }),
    [active]
  )
  const periods = useMemo(
    () => (active ? buildPeriods(active.timeline, domain) : []),
    [active, domain]
  )

  if (!active) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="max-w-sm text-center text-[12px]" style={{ color: 'var(--ink-muted)' }}>
          {error ?? (loading ? 'Reading history…' : 'Select a repository to see its timeline.')}
        </p>
      </div>
    )
  }

  const totals = summarise(active.timeline)
  const spanDays = Math.max(1, Math.round((domain[1] - domain[0]) / DAY_MS) + 1)
  const rangeLabel = `${fullDate(new Date(domain[0]).toISOString())} – ${fullDate(new Date(domain[1]).toISOString())}`

  return (
    <div className="h-full overflow-y-auto">
      <div
        className="flex flex-col gap-3 p-4 transition-opacity duration-150"
        style={{ opacity: held.stale ? 0.55 : 1 }}
        aria-busy={held.stale}
      >
        <ChartCard
          title="Commits per day"
          subtitle={`${rangeLabel} · ${plain(totals.commits)} commits, ${plain(totals.activeDays)} active days of ${plain(spanDays)}`}
          height={200}
          chart={<CommitTimeline buckets={active.timeline} domain={domain} />}
          legend={<CommitTimelineKey />}
          table={<CommitTimelineTable buckets={active.timeline} />}
        />

        <ChartCard
          title="Language mix"
          subtitle={
            mix.series.some((s) => s.name === OTHER)
              ? 'Lines by language at each snapshot · top 7, the rest folded into Other'
              : 'Lines by language at each snapshot'
          }
          height={160}
          chart={
            <StackedArea
              points={mix.points}
              series={mix.series}
              domain={domain}
              unitLabel="lines"
              ariaLabel={describeMix('Language mix', mix)}
            />
          }
          legend={<Legend items={mix.series.map((s) => ({ name: s.name, color: s.color }))} />}
          table={<StackedAreaTable points={mix.points} series={mix.series} format={compact} />}
        />

        <ChartCard
          title="Code composition"
          subtitle="Lines by role at each snapshot"
          height={160}
          chart={
            <StackedArea
              points={composition.points}
              series={composition.series}
              domain={domain}
              unitLabel="lines"
              ariaLabel={describeMix('Code composition', composition)}
            />
          }
          legend={
            <Legend items={composition.series.map((s) => ({ name: s.name, color: s.color }))} />
          }
          table={
            <StackedAreaTable
              points={composition.points}
              series={composition.series}
              format={compact}
            />
          }
        />

        <ChartCard
          title="Lines added and removed"
          subtitle="One shared scale, added right of zero and removed left — never two axes"
          height={barSeriesHeight(periods.length)}
          chart={
            <BarSeries
              rows={periods}
              positiveLabel="Added"
              negativeLabel="Removed"
              ariaLabel={describePeriods(periods)}
            />
          }
          legend={
            <Legend
              items={[
                { name: 'Added (right)', color: BAR_SERIES_POLES.positive },
                { name: 'Removed (left)', color: BAR_SERIES_POLES.negative }
              ]}
            />
          }
          table={
            <BarSeriesTable rows={periods} positiveLabel="Added" negativeLabel="Removed" />
          }
        />

        <ChartCard
          title="Commits"
          subtitle={`${plain(Math.min(500, active.commits.length))} most recent, newest first`}
          height={440}
          chart={<CommitList commits={active.commits} />}
          table={<CommitListTable commits={active.commits} />}
        />
      </div>
    </div>
  )
}

function summarise(buckets: readonly TimelineBucket[]): { commits: number; activeDays: number } {
  let commits = 0
  let activeDays = 0
  for (const b of buckets) {
    commits += b.commits
    if (b.commits > 0) activeDays += 1
  }
  return { commits, activeDays }
}

function describeMix(title: string, mix: LanguageMix): string {
  const last = mix.points[mix.points.length - 1]
  if (!last) return `${title}. No snapshots in range.`
  const parts = mix.series
    .map((s) => ({ name: s.name, value: last.values[s.name] ?? 0 }))
    .filter((p) => p.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((p) => `${p.name} ${compact(p.value)}`)
  return `${title} across ${plain(mix.points.length)} snapshots, stacked by lines. Latest: ${parts.join(', ')}.`
}

function describePeriods(rows: readonly BarSeriesRow[]): string {
  let added = 0
  let removed = 0
  for (const r of rows) {
    added += r.positive
    removed += r.negative
  }
  return `Lines added and removed per period, diverging about zero on one shared scale. ${compact(added)} added against ${compact(removed)} removed in total.`
}

export default Timeline
