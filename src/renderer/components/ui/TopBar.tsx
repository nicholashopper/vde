import { useEffect, useState, type ReactNode } from 'react'
import { GitBranch, RefreshCw } from 'lucide-react'
import type { BaselineKind } from '../../../shared/types'
import { useActiveRepo, useStore } from '../../store'
import { compact, fullDate, relativeTime } from '../../lib/format'
import { Button } from './Button'
import { Segmented, type SegmentedOption } from './Segmented'
import { Tooltip } from './Tooltip'

/**
 * The baseline is a FILTER over everything below it, so it lives in one row
 * above the content and never inside a chart card. A per-card range control
 * lets two cards disagree about what period they are showing, which is how a
 * dashboard starts lying.
 */
const BASELINES: readonly SegmentedOption<BaselineKind>[] = [
  { value: '7d', label: '7d', hint: 'compare against 7 days ago' },
  { value: '30d', label: '30d', hint: 'compare against 30 days ago' },
  { value: '90d', label: '90d', hint: 'compare against 90 days ago' },
  { value: 'first', label: 'First', hint: 'compare against the first commit' }
] as const

export function TopBar(): ReactNode {
  const repo = useActiveRepo()
  const report = useStore((s) => s.report)
  const baseline = useStore((s) => s.baseline)
  const setBaseline = useStore((s) => s.setBaseline)
  const scan = useStore((s) => s.scan)
  const loading = useStore((s) => s.loading)
  const scanning = useStore((s) => s.progress) !== null

  // Keeps "4 minutes ago" honest without a render on every tick of the clock.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])

  if (!repo) return null

  const facts = report?.facts
  const files = facts ? `${compact(facts.fileCount)} files` : null
  const commits = `${compact(facts?.commitCount ?? repo.commitCount)} commits`

  return (
    <header
      className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-5 py-2.5"
      style={{ borderColor: 'var(--hairline)' }}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <h1 className="truncate text-[13px] font-medium" style={{ color: 'var(--ink-primary)' }}>
          {repo.name}
        </h1>
        <Dot />
        <span
          className="flex min-w-0 items-center gap-1 text-[11px]"
          style={{ color: 'var(--ink-muted)' }}
        >
          <GitBranch size={11} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{repo.branch ?? `detached · ${repo.head.slice(0, 7)}`}</span>
        </span>
        {files ? (
          <>
            <Dot />
            <span className="tnum text-[11px]" style={{ color: 'var(--ink-muted)' }}>
              {files}
            </span>
          </>
        ) : null}
        <Dot />
        <span className="tnum text-[11px]" style={{ color: 'var(--ink-muted)' }}>
          {commits}
        </span>
        {report ? (
          <>
            <Dot />
            <span className="truncate text-[11px]" style={{ color: 'var(--ink-faint)' }}>
              vs {report.baseline.label}
            </span>
          </>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
            Baseline
          </span>
          <Segmented
            label="Baseline period"
            options={BASELINES}
            value={baseline}
            onChange={(v) => void setBaseline(v)}
            disabled={scanning}
          />
        </div>

        <span aria-hidden="true" className="h-4 w-px" style={{ background: 'var(--hairline)' }} />

        {repo.lastScanAt ? (
          <Tooltip content={fullDate(repo.lastScanAt)} side="bottom">
            <time
              dateTime={repo.lastScanAt}
              tabIndex={0}
              className="rounded-sm text-[11px] whitespace-nowrap"
              style={{ color: 'var(--ink-faint)' }}
            >
              Scanned {relativeTime(repo.lastScanAt)}
            </time>
          </Tooltip>
        ) : (
          <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--ink-faint)' }}>
            Never scanned
          </span>
        )}

        <Button
          size="sm"
          variant="ghost"
          icon={RefreshCw}
          loading={loading || scanning}
          onClick={() => void scan(true)}
        >
          Rescan
        </Button>
      </div>
    </header>
  )
}

function Dot(): ReactNode {
  return (
    <span aria-hidden="true" className="text-[11px]" style={{ color: 'var(--ink-faint)' }}>
      ·
    </span>
  )
}
