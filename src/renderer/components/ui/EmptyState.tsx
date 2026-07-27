import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface EmptyStateProps {
  icon: LucideIcon
  headline: string
  /** One sentence. If it needs two, the state is doing too much. */
  body: string
  action?: ReactNode
  /** A quieter line under the action — a reassurance or a keyboard hint. */
  footnote?: string
  className?: string
}

/**
 * The state a screen shows when it has nothing to draw.
 *
 * Deliberately narrow (46ch) and centred: an empty screen is the one place a
 * long measure is tempting and least readable.
 */
export function EmptyState({
  icon: Icon,
  headline,
  body,
  action,
  footnote,
  className
}: EmptyStateProps): ReactNode {
  return (
    <div className={cn('flex flex-col items-center px-8 py-10 text-center', className)}>
      <span
        aria-hidden="true"
        className="mb-4 inline-flex size-11 items-center justify-center rounded-lg border border-hairline"
        style={{ background: 'var(--surface-2)', color: 'var(--ink-muted)' }}
      >
        <Icon size={20} strokeWidth={1.75} />
      </span>

      <h2 className="text-[15px] font-medium" style={{ color: 'var(--ink-primary)' }}>
        {headline}
      </h2>

      <p
        className="mt-1.5 max-w-[46ch] text-[12px] leading-relaxed text-balance"
        style={{ color: 'var(--ink-muted)' }}
      >
        {body}
      </p>

      {action ? <div className="mt-5 flex items-center gap-2">{action}</div> : null}

      {footnote ? (
        <p className="mt-4 max-w-[46ch] text-[11px]" style={{ color: 'var(--ink-faint)' }}>
          {footnote}
        </p>
      ) : null}
    </div>
  )
}
