import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

/**
 * Keyframes for the indeterminate sweep.
 *
 * React 19 hoists and de-duplicates a `<style href precedence>` into the head,
 * so this ships with the component instead of leaking into the global sheet.
 * The reduced-motion branch replaces the sweep with a dimmed full-width bar —
 * "something is happening, we cannot say how much" — rather than freezing a
 * sliding block mid-track.
 */
const SWEEP_CSS = `
@keyframes vde-progress-sweep {
  0%   { transform: translateX(-110%); }
  100% { transform: translateX(260%); }
}
.vde-progress-sweep {
  width: 42%;
  animation: vde-progress-sweep 1.5s cubic-bezier(0.45, 0, 0.25, 1) infinite;
}
@media (prefers-reduced-motion: reduce) {
  .vde-progress-sweep {
    animation: none;
    width: 100%;
    opacity: 0.5;
  }
}
`

export interface ProgressBarProps {
  /** Units completed. Ignored when `total` is 0. */
  value: number
  /** Total units. 0 (or less) renders an indeterminate bar. */
  total: number
  /** Accessible name, e.g. "Scan progress". */
  label: string
  className?: string
}

/**
 * A 4px determinate/indeterminate bar.
 *
 * The fill is the sequential ramp's mid step, never a status colour: progress
 * is not a health state, and painting it green would put a "good" reading on a
 * screen whose entire job is reporting how good things are.
 */
export function ProgressBar({ value, total, label, className }: ProgressBarProps): ReactNode {
  const determinate = total > 0
  const ratio = determinate ? Math.min(1, Math.max(0, value / total)) : 0
  const pct = Math.round(ratio * 100)

  return (
    <>
      <style href="vde-progressbar" precedence="default">
        {SWEEP_CSS}
      </style>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? 100 : undefined}
        aria-valuenow={determinate ? pct : undefined}
        aria-valuetext={determinate ? `${pct}%` : 'Working'}
        className={cn('h-1 w-full overflow-hidden rounded-full', className)}
        style={{ background: 'var(--surface-3)' }}
      >
        <div
          className={cn('h-full rounded-full', determinate ? null : 'vde-progress-sweep')}
          style={{
            background: 'var(--seq-400)',
            width: determinate ? `${ratio * 100}%` : undefined,
            transition: determinate ? 'width 240ms cubic-bezier(0.4, 0, 0.2, 1)' : undefined
          }}
        />
      </div>
    </>
  )
}
