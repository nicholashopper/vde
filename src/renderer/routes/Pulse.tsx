import { useCallback, useMemo, useState, type ReactNode } from 'react'
import type { RepoReport, SignalDelta, SignalId, SignalValue } from '../../shared/types'
import { HEALTH_STATUS_ORDER } from '../../shared/types'
import { SIGNALS, SIGNAL_ORDER } from '../../shared/signals'
import { useStore } from '../store'
import { useHeldValue } from '../components/charts/primitives'
import { MoversStrip } from '../components/MoversStrip'
import { SignalDrawer } from '../components/SignalDrawer'
import { SignalTile, EMPTY_SERIES, type SignalSeries } from '../components/SignalTile'

/**
 * Pulse — the 30,000ft view.
 *
 * VDE deliberately has no composite health score, because averaging fourteen
 * incommensurable measurements produces a number that is precise, confident and
 * meaningless. The cost of that decision is paid here: this layout has to make
 * fourteen tiles readable in about two seconds. Three things do that work.
 *
 *   1. One orientation. Every signal is scaled so higher is worse, stated once
 *      as a caption. Learn the rule once, then read every tile the same way.
 *   2. Change first. The movers strip is pinned above the grid, because the
 *      question people actually arrive with is "what changed?", not "what is".
 *   3. Rank by movement by default. The default sort puts the tiles that moved
 *      at the top-left, so the grid itself is the answer to "look at what?".
 */

export type PulseSort = 'movement' | 'severity' | 'panel'

const SORTS: readonly { id: PulseSort; label: string; hint: string }[] = [
  { id: 'movement', label: 'Movement', hint: 'Sort by how much each signal moved since the baseline' },
  { id: 'severity', label: 'Severity', hint: 'Sort by status band, worst first' },
  { id: 'panel', label: 'Panel', hint: 'Sort by the registry order: history first, then tree shape' }
]

// ---------------------------------------------------------------------------
// Series extraction
// ---------------------------------------------------------------------------

function emptyRecord(): Record<SignalId, SignalSeries> {
  const out = {} as Record<SignalId, SignalSeries>
  for (const id of SIGNAL_ORDER) out[id] = { values: [], dates: [], baselineIndex: null }
  return out
}

/**
 * Turns report.snapshots into one series per signal.
 *
 * Snapshots carry a Partial map, so a signal can be missing from any point.
 * Each series therefore keeps its own dates and computes its own baseline
 * index — sharing one index across signals would silently mis-place the
 * baseline hairline on any signal with a gap.
 */
function buildSeries(report: RepoReport | null): Record<SignalId, SignalSeries> {
  const out = emptyRecord()
  if (!report) return out

  for (const point of report.snapshots) {
    for (const id of SIGNAL_ORDER) {
      const v = point.signals[id]
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      const series = out[id]
      series.values.push(v)
      series.dates.push(point.date)
    }
  }

  const { commitSha, date } = report.baseline
  for (const id of SIGNAL_ORDER) {
    const series = out[id]
    if (series.values.length === 0) continue
    let idx: number | null = null
    if (commitSha) {
      // Snapshots are ordered oldest → newest, so the sha's position in the
      // full snapshot list maps to this signal's list by date.
      const snap = report.snapshots.find((s) => s.commitSha === commitSha)
      if (snap) {
        const at = series.dates.indexOf(snap.date)
        if (at !== -1) idx = at
      }
    }
    if (idx === null && date) {
      // Fall back to the last point at or before the baseline date.
      for (let i = 0; i < series.dates.length; i += 1) {
        const d = series.dates[i]
        if (d !== undefined && d <= date) idx = i
        else break
      }
    }
    series.baselineIndex = idx
  }

  return out
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function Pulse(): ReactNode {
  const report = useStore((s) => s.report)
  const loading = useStore((s) => s.loading)
  const setOpenSignal = useStore((s) => s.setOpenSignal)
  const [sort, setSort] = useState<PulseSort>('movement')

  // Hold the previous report through a refetch rather than flashing a skeleton
  // — changing the baseline must not blank the screen. App.tsx already dims the
  // route while a scan is in flight, so this only supplies the held VALUE; a
  // second opacity layer here would compound to an unreadable 0.3.
  const { value: held } = useHeldValue(report, loading)

  const series = useMemo(() => buildSeries(held), [held])

  const signalById = useMemo(() => {
    const m = new Map<SignalId, SignalValue>()
    for (const s of held?.signals ?? []) m.set(s.id, s)
    return m
  }, [held])

  const deltaById = useMemo(() => {
    const m = new Map<SignalId, SignalDelta>()
    for (const d of held?.deltas ?? []) m.set(d.id, d)
    return m
  }, [held])

  const ordered = useMemo(() => {
    const present = SIGNAL_ORDER.filter((id) => signalById.has(id))
    const canonical = new Map(SIGNAL_ORDER.map((id, i) => [id, i]))
    const rank = (id: SignalId): number => canonical.get(id) ?? 0
    const severity = (id: SignalId): number =>
      HEALTH_STATUS_ORDER.indexOf(signalById.get(id)?.status ?? 'good')
    const magnitude = (id: SignalId): number => Math.abs(deltaById.get(id)?.magnitude ?? 0)
    const level = (id: SignalId): number => {
      const v = signalById.get(id)?.value ?? 0
      const max = SIGNALS[id].displayMax || 1
      return v / max
    }

    if (sort === 'panel') return present
    const sorted = [...present]
    if (sort === 'severity') {
      sorted.sort(
        (a, b) => severity(b) - severity(a) || level(b) - level(a) || rank(a) - rank(b)
      )
    } else {
      sorted.sort(
        (a, b) => magnitude(b) - magnitude(a) || severity(b) - severity(a) || rank(a) - rank(b)
      )
    }
    return sorted
  }, [sort, signalById, deltaById])

  const onOpen = useCallback((id: SignalId) => setOpenSignal(id), [setOpenSignal])

  // App.tsx owns the empty, loading and error states.
  if (!held) return null

  // App.tsx owns the scroll container and the route padding.
  return (
    <>
      <div className="flex flex-col gap-4">
        <MoversStrip
          movers={held.topMovers}
          baselineLabel={held.baseline.label}
          series={series}
          snapshotCount={held.snapshots.length}
          onOpen={onOpen}
        />

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
            Every signal is scaled so{' '}
            <span style={{ color: 'var(--ink-secondary)' }}>higher is worse</span> — no tile needs a
            different reading.
          </p>

          <div
            role="group"
            aria-label="Sort signals"
            className="flex items-center gap-1 rounded-[4px] p-0.5"
            style={{ background: 'var(--surface-2)' }}
          >
            <span className="px-1 text-[10px]" style={{ color: 'var(--ink-faint)' }}>
              Sort
            </span>
            {SORTS.map((s) => {
              const on = s.id === sort
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSort(s.id)}
                  aria-pressed={on}
                  title={s.hint}
                  className="min-h-6 rounded-[4px] px-2 text-[11px] transition-colors"
                  style={{
                    background: on ? 'var(--surface-3)' : 'transparent',
                    color: on ? 'var(--ink-primary)' : 'var(--ink-muted)'
                  }}
                >
                  {s.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-4">
          {ordered.map((id) => {
            const signal = signalById.get(id)
            if (!signal) return null
            return (
              <SignalTile
                key={id}
                signal={signal}
                delta={deltaById.get(id)}
                series={series[id] ?? EMPTY_SERIES}
                onOpen={onOpen}
              />
            )
          })}
        </div>
      </div>

      <SignalDrawer report={held} series={series} />
    </>
  )
}

export default Pulse
