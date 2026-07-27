import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { ChevronDown, ListFilter, Search, Sparkles, X } from 'lucide-react'
import type { Finding, HealthStatus, RepoReport, SignalId } from '../../shared/types'
import { SIGNALS, SIGNAL_ORDER } from '../../shared/signals'
import { STATUS_LABEL, STATUS_VAR } from '../lib/colors'
import { plain } from '../lib/format'
import { useHeldValue } from '../components/charts/primitives'
import { FindingCard } from '../components/FindingCard'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { StatusPip } from '../components/ui/StatusPip'
import { useStore } from '../store'

/**
 * Findings — the triage screen.
 *
 * Everything scopes downward. The severity summary describes the whole report,
 * the single filter row scopes the list beneath it, and the footer acts on the
 * selection made in that list. Nothing scopes upward, so there is never a
 * question about what a control affects.
 *
 * App.tsx owns the scroll container, the route padding, and the empty/loading/
 * error states, so this file assumes a report and lays out as flow content.
 */

// ---------------------------------------------------------------------------
// The Findings → Brief handoff
// ---------------------------------------------------------------------------

interface BriefSelectionState {
  /** Repo the committed selection belongs to; guards against a stale handoff. */
  repoId: string | null
  /** Finding ids committed by "Build brief". null means "not chosen yet". */
  ids: string[] | null
  commit(repoId: string, ids: string[]): void
  clear(): void
}

/**
 * A module-level store rather than a prop drill, because Findings and Brief are
 * sibling routes with no common ancestor this module owns. It lives here rather
 * than in the app store because it is plumbing between two screens, not
 * application state.
 *
 * Brief.tsx treats `ids === null`, or a repo mismatch, as "every finding".
 */
export const useBriefSelection = create<BriefSelectionState>((set) => ({
  repoId: null,
  ids: null,
  commit: (repoId, ids) => set({ repoId, ids }),
  clear: () => set({ repoId: null, ids: null })
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_FINDINGS: readonly Finding[] = []

/** Worst first — the reading order for triage. */
const SEVERITY_DESC: readonly HealthStatus[] = ['critical', 'serious', 'warning', 'good'] as const

function severityRank(s: HealthStatus): number {
  const i = SEVERITY_DESC.indexOf(s)
  return i === -1 ? SEVERITY_DESC.length : i
}

/**
 * Ranking weight inside a severity band. Raw metric values are not comparable
 * across signals — 3,200 lines would outrank 88% every time — so each is
 * normalised by its signal's displayMax before being compared.
 */
function magnitude(f: Finding): number {
  const max = SIGNALS[f.signalId].displayMax
  const v = Math.abs(f.metric.value)
  return Number.isFinite(v) ? v / (max > 0 ? max : 1) : 0
}

function countBySeverity(findings: readonly Finding[]): Record<HealthStatus, number> {
  const out: Record<HealthStatus, number> = { good: 0, warning: 0, serious: 0, critical: 0 }
  for (const f of findings) out[f.severity] += 1
  return out
}

interface SignalOption {
  id: SignalId
  label: string
  count: number
}

// ---------------------------------------------------------------------------
// Severity summary
// ---------------------------------------------------------------------------

function SeverityBar({
  counts,
  total
}: {
  counts: Record<HealthStatus, number>
  total: number
}): ReactNode {
  const present = SEVERITY_DESC.filter((s) => counts[s] > 0)
  const description = present.map((s) => `${counts[s]} ${STATUS_LABEL[s].toLowerCase()}`).join(', ')

  return (
    <div className="min-w-0">
      {/* The bar carries proportion; the labelled row beneath carries the
          numbers. Status colour never stands on its own. */}
      <div
        role="img"
        aria-label={total === 0 ? 'No findings' : `${total} findings by severity: ${description}`}
        className="flex h-2 w-full gap-[2px] overflow-hidden rounded-[3px]"
        style={{ background: 'var(--surface-3)' }}
      >
        {present.map((s) => (
          <div
            key={s}
            className="h-full"
            style={{ flexGrow: counts[s], flexBasis: 0, background: STATUS_VAR[s] }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {SEVERITY_DESC.map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <StatusPip status={s} className={counts[s] === 0 ? 'opacity-45' : undefined} />
            <span
              className="tnum text-[11px]"
              style={{ color: counts[s] > 0 ? 'var(--ink-primary)' : 'var(--ink-faint)' }}
            >
              {counts[s]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filter controls
// ---------------------------------------------------------------------------

function SeverityToggles({
  counts,
  active,
  onToggle
}: {
  counts: Record<HealthStatus, number>
  active: ReadonlySet<HealthStatus>
  onToggle(s: HealthStatus): void
}): ReactNode {
  return (
    <div role="group" aria-label="Filter by severity" className="flex items-center gap-1">
      {SEVERITY_DESC.map((s) => {
        const on = active.has(s)
        return (
          <button
            key={s}
            type="button"
            onClick={() => onToggle(s)}
            aria-pressed={on}
            disabled={counts[s] === 0}
            title={`${STATUS_LABEL[s]} — ${counts[s]} findings`}
            className="inline-flex min-h-7 items-center gap-1.5 rounded-sm px-2 text-[11px] transition-colors disabled:opacity-40"
            style={{
              background: on ? 'var(--surface-3)' : 'transparent',
              border: `1px solid ${on ? 'var(--hairline-strong)' : 'var(--hairline)'}`
            }}
          >
            <StatusPip status={s} className={on ? undefined : 'opacity-60'} />
            <span className="tnum" style={{ color: 'var(--ink-muted)' }}>
              {counts[s]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function SignalFilter({
  options,
  active,
  onChange
}: {
  options: readonly SignalOption[]
  active: ReadonlySet<SignalId>
  onChange(next: Set<SignalId>): void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const el = root.current
      if (el && e.target instanceof Node && !el.contains(e.target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const all = active.size === options.length
  const label = all ? 'All signals' : `${active.size} of ${options.length} signals`

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className="inline-flex min-h-7 items-center gap-1.5 rounded-sm px-2 text-[11px]"
        style={{
          background: all ? 'transparent' : 'var(--surface-3)',
          border: '1px solid var(--hairline)',
          color: all ? 'var(--ink-muted)' : 'var(--ink-primary)'
        }}
      >
        <ListFilter size={12} strokeWidth={1.75} aria-hidden="true" />
        {label}
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>

      {open ? (
        <div
          className="absolute top-[calc(100%+4px)] left-0 z-40 w-72 overflow-hidden rounded-md shadow-lg"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline-strong)' }}
        >
          <div
            className="flex items-center justify-between border-b px-2.5 py-1.5"
            style={{ borderColor: 'var(--hairline)' }}
          >
            <span
              className="text-[10px] tracking-[0.06em] uppercase"
              style={{ color: 'var(--ink-faint)' }}
            >
              Signal
            </span>
            <span className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="border-transparent px-1.5"
                onClick={() => onChange(new Set(options.map((o) => o.id)))}
              >
                All
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="border-transparent px-1.5"
                onClick={() => onChange(new Set<SignalId>())}
              >
                None
              </Button>
            </span>
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {options.map((o) => {
              const checked = active.has(o.id)
              return (
                <li key={o.id}>
                  <label
                    className="flex min-h-7 cursor-pointer items-center gap-2 px-2.5 text-[11px] select-none"
                    style={{ color: 'var(--ink-secondary)' }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = new Set(active)
                        if (checked) next.delete(o.id)
                        else next.add(o.id)
                        onChange(next)
                      }}
                      className="size-3.5"
                      style={{ accentColor: 'var(--focus-ring)' }}
                    />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    <span className="tnum" style={{ color: 'var(--ink-faint)' }}>
                      {o.count}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

interface ViewState {
  /** Identity of the report this state belongs to. */
  key: string
  selected: Set<string>
  severities: Set<HealthStatus>
  signals: Set<SignalId>
}

export function Findings(): ReactNode {
  const report = useStore((s) => s.report)
  const loading = useStore((s) => s.loading)
  const setView = useStore((s) => s.setView)
  const commitSelection = useBriefSelection((s) => s.commit)

  // Hold the previous report's VALUE through a refetch. App.tsx already dims
  // the route while a scan is in flight; a second opacity layer here would
  // compound to an unreadable 0.3.
  const { value: held } = useHeldValue<RepoReport | null>(report, loading)
  const findings = held?.findings ?? NO_FINDINGS

  const [query, setQuery] = useState('')
  const [state, setState] = useState<ViewState>(() => ({
    key: '',
    selected: new Set<string>(),
    severities: new Set<HealthStatus>(SEVERITY_DESC),
    signals: new Set<SignalId>()
  }))

  const counts = useMemo(() => countBySeverity(findings), [findings])

  const signalOptions = useMemo<SignalOption[]>(() => {
    const seen = new Map<SignalId, number>()
    for (const f of findings) seen.set(f.signalId, (seen.get(f.signalId) ?? 0) + 1)
    return SIGNAL_ORDER.filter((id) => seen.has(id)).map((id) => ({
      id,
      label: SIGNALS[id].label,
      count: seen.get(id) ?? 0
    }))
  }, [findings])

  // A new report resets the filters and re-selects everything. Adjusting state
  // during render rather than in an effect avoids a frame of stale selection.
  const resetKey = `${held?.repo.id ?? ''}|${held?.generatedAt ?? ''}`
  let view = state
  if (state.key !== resetKey) {
    view = {
      key: resetKey,
      selected: new Set(findings.map((f) => f.id)),
      severities: new Set<HealthStatus>(SEVERITY_DESC),
      signals: new Set<SignalId>(signalOptions.map((o) => o.id))
    }
    setState(view)
  }
  const { selected, severities, signals } = view

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return findings
      .filter((f) => severities.has(f.severity))
      .filter((f) => signals.has(f.signalId))
      .filter(
        (f) =>
          q === '' ||
          f.title.toLowerCase().includes(q) ||
          f.detail.toLowerCase().includes(q) ||
          f.paths.some((p) => p.toLowerCase().includes(q))
      )
      .sort(
        (a, b) =>
          severityRank(a.severity) - severityRank(b.severity) ||
          magnitude(b) - magnitude(a) ||
          a.title.localeCompare(b.title)
      )
  }, [findings, severities, signals, query])

  const toggleFinding = useCallback((id: string, on: boolean) => {
    setState((prev) => {
      const next = new Set(prev.selected)
      if (on) next.add(id)
      else next.delete(id)
      return { ...prev, selected: next }
    })
  }, [])

  const setSelected = useCallback((ids: Set<string>) => {
    setState((prev) => ({ ...prev, selected: ids }))
  }, [])

  const toggleSeverity = useCallback((s: HealthStatus) => {
    setState((prev) => {
      const next = new Set(prev.severities)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return { ...prev, severities: next }
    })
  }, [])

  const setSignals = useCallback((ids: Set<SignalId>) => {
    setState((prev) => ({ ...prev, signals: ids }))
  }, [])

  const clearFilters = useCallback(() => {
    setQuery('')
    setState((prev) => ({
      ...prev,
      severities: new Set<HealthStatus>(SEVERITY_DESC),
      signals: new Set<SignalId>(signalOptions.map((o) => o.id))
    }))
  }, [signalOptions])

  const repoId = held?.repo.id ?? null
  const buildBrief = useCallback(() => {
    if (!repoId) return
    const ordered = findings.filter((f) => selected.has(f.id)).map((f) => f.id)
    if (ordered.length === 0) return
    commitSelection(repoId, ordered)
    setView('brief')
  }, [repoId, findings, selected, commitSelection, setView])

  // App.tsx owns the empty, loading and error states.
  if (!held) return null

  // -- good news ----------------------------------------------------------
  if (findings.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        headline={`Nothing above the warning threshold — ${SIGNAL_ORDER.length} signals checked`}
        body={`Every signal on ${held.repo.name} is sitting inside its healthy band, so there is nothing here to fix.`}
        action={
          <Button variant="ghost" onClick={() => setView('pulse')}>
            Review the signal panel
          </Button>
        }
        footnote="VDE raises a finding only once a measurement crosses into Watch or worse. A quiet Findings screen is the intended outcome, not a missing one."
      />
    )
  }

  const filtersActive =
    query.trim() !== '' ||
    signals.size !== signalOptions.length ||
    severities.size !== SEVERITY_DESC.length
  const selectedCount = selected.size
  const hiddenCount = findings.length - visible.length

  return (
    <div className="flex flex-col">
      {/* -- summary ------------------------------------------------------- */}
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 pb-3">
        <div className="min-w-0">
          <h2 className="text-[13px] font-medium" style={{ color: 'var(--ink-primary)' }}>
            Findings
          </h2>
          <p className="mt-0.5 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
            {plain(findings.length)} raised across {signalOptions.length} of {SIGNAL_ORDER.length}{' '}
            signals, worst first
          </p>
        </div>
        <div className="min-w-[280px] flex-1">
          <SeverityBar counts={counts} total={findings.length} />
        </div>
      </header>

      {/* -- filter row: ONE row, directly above everything it scopes ------ */}
      <div
        className="sticky top-0 z-20 -mx-5 flex flex-wrap items-center gap-2 border-b px-5 py-2.5"
        style={{ borderColor: 'var(--hairline)', background: 'var(--plane)' }}
      >
        <SeverityToggles counts={counts} active={severities} onToggle={toggleSeverity} />
        <SignalFilter options={signalOptions} active={signals} onChange={setSignals} />

        <div className="relative min-w-[180px] flex-1">
          <Search
            size={12}
            strokeWidth={1.75}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2"
            style={{ color: 'var(--ink-faint)' }}
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search title, evidence or path"
            aria-label="Search findings"
            className="h-7 w-full rounded-sm pr-2 pl-7 text-[11px] outline-none"
            style={{
              background: 'var(--surface-inset)',
              border: '1px solid var(--hairline)',
              color: 'var(--ink-primary)'
            }}
          />
        </div>

        {filtersActive ? (
          <Button size="sm" variant="ghost" icon={X} onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {/* -- the list ------------------------------------------------------ */}
      <div className="py-4">
        <p role="status" className="sr-only">
          {visible.length} of {findings.length} findings shown
        </p>

        {visible.length === 0 ? (
          <div className="card flex flex-col items-start gap-2 p-5">
            <p className="text-[12.5px]" style={{ color: 'var(--ink-primary)' }}>
              No findings match these filters.
            </p>
            <p className="text-[12px]" style={{ color: 'var(--ink-muted)' }}>
              All {plain(findings.length)} findings are hidden by the current severity, signal or
              search filter.
            </p>
            <Button size="sm" variant="ghost" icon={X} className="mt-1" onClick={clearFilters}>
              Clear filters
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {visible.map((f) => (
              <li key={f.id}>
                <FindingCard
                  finding={f}
                  repoId={held.repo.id}
                  selected={selected.has(f.id)}
                  onToggleSelected={toggleFinding}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* -- sticky footer ------------------------------------------------- */}
      <footer
        className="sticky bottom-0 z-20 -mx-5 flex flex-wrap items-center justify-between gap-3 border-t px-5 py-2.5"
        style={{ borderColor: 'var(--hairline)', background: 'var(--plane)' }}
      >
        <div className="flex min-w-0 items-baseline gap-3">
          <p className="text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
            <span className="tnum" style={{ color: 'var(--ink-primary)' }}>
              {selectedCount}
            </span>{' '}
            of{' '}
            <span className="tnum" style={{ color: 'var(--ink-primary)' }}>
              {findings.length}
            </span>{' '}
            findings selected
          </p>
          {hiddenCount > 0 ? (
            <p className="text-[11px]" style={{ color: 'var(--ink-faint)' }}>
              {hiddenCount} hidden by filters
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={selectedCount === findings.length}
            onClick={() => setSelected(new Set(findings.map((f) => f.id)))}
          >
            Select all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={selectedCount === 0}
            onClick={() => setSelected(new Set<string>())}
          >
            Clear
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={selectedCount === 0}
            title={
              selectedCount === 0
                ? 'Select at least one finding'
                : `Build a remediation brief from ${selectedCount} findings`
            }
            onClick={buildBrief}
          >
            Build brief
          </Button>
        </div>
      </footer>
    </div>
  )
}
