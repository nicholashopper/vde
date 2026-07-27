import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, ChevronDown, FolderOpen } from 'lucide-react'
import type { Finding, SignalUnit } from '../../shared/types'
import { SIGNALS } from '../../shared/signals'
import { STATUS_VAR } from '../lib/colors'
import { compact, ellipsisPath } from '../lib/format'
import { useStore } from '../store'
import { Button } from './ui/Button'
import { StatusPip } from './ui/StatusPip'

/**
 * One finding, rendered as a unit of work.
 *
 * The order is the order a reader needs it in: what is wrong (severity and
 * title), how bad (the metric), why we say so (the evidence), where (the
 * paths), and what to do about it (the remediation). The remediation is
 * deliberately NOT styled as prose — it is an instruction destined for a coding
 * agent, so it wears a quiet inset monospace panel that reads as payload rather
 * than opinion.
 *
 * Severity is carried by StatusPip, which always prints the word beside the
 * dot. Status colour never carries the meaning on its own.
 */

/** Paths shown before the disclosure takes over. */
const VISIBLE_PATHS = 8

/**
 * Unit-aware value formatting.
 *
 * format.ts has percent()/compact() but nothing that switches on SignalUnit,
 * and formatSignal() in signals.ts keys off the SIGNAL's unit rather than the
 * finding's own metric unit — a finding may legitimately report a count for a
 * percent-scaled signal. Kept local rather than editing a frozen contract.
 */
function formatMetric(value: number, unit: SignalUnit): string {
  if (!Number.isFinite(value)) return '—'
  switch (unit) {
    case 'percent':
      return `${value.toFixed(1)}%`
    case 'ratio':
      return `${value.toFixed(2)}×`
    case 'days':
      return `${Math.round(value)}d`
    default:
      return compact(value)
  }
}

export interface FindingCardProps {
  finding: Finding
  /** Reveal is scoped to a repository, so the card needs its id. */
  repoId: string
  /** Whether this finding is included in the brief. Owned by the parent. */
  selected: boolean
  onToggleSelected(id: string, next: boolean): void
}

export function FindingCard({
  finding,
  repoId,
  selected,
  onToggleSelected
}: FindingCardProps): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [revealError, setRevealError] = useState<string | null>(null)
  const errorTimer = useRef<number | null>(null)
  const setView = useStore((s) => s.setView)
  const setOpenSignal = useStore((s) => s.setOpenSignal)

  useEffect(
    () => () => {
      if (errorTimer.current !== null) window.clearTimeout(errorTimer.current)
    },
    []
  )

  const reveal = useCallback(
    (path: string) => {
      window.vde.app.revealFile(repoId, path).catch(() => {
        setRevealError(`Could not reveal ${path} — it may have been removed since the last scan.`)
        if (errorTimer.current !== null) window.clearTimeout(errorTimer.current)
        errorTimer.current = window.setTimeout(() => setRevealError(null), 5000)
      })
    },
    [repoId]
  )

  const signal = SIGNALS[finding.signalId]
  const shown = expanded ? finding.paths : finding.paths.slice(0, VISIBLE_PATHS)
  const hidden = finding.paths.length - shown.length
  const checkboxId = `finding-select-${finding.id}`

  return (
    <article className="card flex flex-col gap-3 p-3.5" aria-labelledby={`finding-title-${finding.id}`}>
      {/* -- header -------------------------------------------------------- */}
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusPip status={finding.severity} wash />
            <button
              type="button"
              onClick={() => {
                setOpenSignal(finding.signalId)
                setView('pulse')
              }}
              title={`Open ${signal.label} in the signal panel`}
              className="inline-flex min-h-6 items-center gap-0.5 rounded-sm px-1 text-[11px] hover:underline"
              style={{ color: 'var(--ink-muted)' }}
            >
              {signal.label}
              <ArrowUpRight size={11} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
          <h3
            id={`finding-title-${finding.id}`}
            className="mt-1.5 text-[13px] leading-snug font-medium"
            style={{ color: 'var(--ink-primary)' }}
          >
            {finding.title}
          </h3>
        </div>

        {/* A standalone figure: proportional, never tabular. */}
        <div className="shrink-0 text-right">
          <div className="figure text-[18px] leading-none" style={{ color: 'var(--ink-primary)' }}>
            {formatMetric(finding.metric.value, finding.metric.unit)}
          </div>
          <div
            className="mt-1 max-w-[150px] text-[10px] leading-tight"
            style={{ color: 'var(--ink-muted)' }}
          >
            {finding.metric.label}
          </div>
        </div>

        <label
          htmlFor={checkboxId}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 py-0.5 text-[10px] select-none"
          style={{ color: selected ? 'var(--ink-secondary)' : 'var(--ink-faint)' }}
        >
          <input
            id={checkboxId}
            type="checkbox"
            checked={selected}
            onChange={(e) => onToggleSelected(finding.id, e.currentTarget.checked)}
            className="size-4"
            style={{ accentColor: 'var(--focus-ring)' }}
          />
          In brief
        </label>
      </header>

      {/* -- evidence ------------------------------------------------------ */}
      <p
        className="text-[12px] leading-[1.6]"
        style={{ color: 'var(--ink-secondary)' }}
        data-selectable
      >
        {finding.detail}
      </p>

      {/* -- affected paths ------------------------------------------------ */}
      {finding.paths.length > 0 ? (
        <div>
          <div
            className="mb-1 text-[10px] tracking-[0.06em] uppercase"
            style={{ color: 'var(--ink-faint)' }}
          >
            {finding.paths.length === 1
              ? '1 affected path'
              : `${finding.paths.length} affected paths`}
          </div>
          <ul className="flex flex-col">
            {shown.map((path) => (
              <li
                key={path}
                className="flex min-h-7 items-center gap-2 border-b py-0.5 last:border-b-0"
                style={{ borderColor: 'var(--hairline)' }}
              >
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[11px]"
                  style={{ color: 'var(--ink-secondary)' }}
                  title={path}
                  data-selectable
                >
                  {ellipsisPath(path, 72)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={FolderOpen}
                  className="border-transparent"
                  aria-label={`Reveal ${path} in the file manager`}
                  title="Reveal in file manager"
                  onClick={() => reveal(path)}
                />
              </li>
            ))}
          </ul>

          {hidden > 0 || expanded ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="mt-1.5 inline-flex min-h-6 items-center gap-1 rounded-sm text-[11px]"
              style={{ color: 'var(--ink-muted)' }}
            >
              <ChevronDown
                size={12}
                strokeWidth={1.75}
                aria-hidden="true"
                style={{ transform: expanded ? 'rotate(180deg)' : 'none' }}
              />
              {expanded ? 'Show fewer' : `Show ${hidden} more`}
            </button>
          ) : null}

          {revealError ? (
            <p role="status" className="mt-1.5 text-[11px]" style={{ color: 'var(--ink-secondary)' }}>
              {revealError}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* -- remediation: an instruction, not prose ------------------------ */}
      <div
        className="rounded-md p-2.5"
        style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}
      >
        <div
          className="mb-1.5 flex items-center gap-1.5 text-[10px] tracking-[0.06em] uppercase"
          style={{ color: 'var(--ink-faint)' }}
        >
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-[3px] rounded-[1px]"
            style={{ background: STATUS_VAR[finding.severity] }}
          />
          Instruction for your coding agent
        </div>
        <p
          className="font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap"
          style={{ color: 'var(--ink-primary)' }}
          data-selectable
        >
          {finding.remediation}
        </p>
      </div>
    </article>
  )
}
