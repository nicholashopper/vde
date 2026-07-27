import type { ReactNode } from 'react'
import type { HealthStatus } from '../../../shared/types'
import { STATUS_LABEL, STATUS_VAR, STATUS_WASH } from '../../lib/colors'
import { cn } from '../../lib/cn'

export interface StatusPipProps {
  status: HealthStatus
  /** Overrides the registry label. The label is ALWAYS rendered. */
  label?: string
  size?: 'sm' | 'md'
  /** Fills the pill with the status wash. Use sparingly — one per card. */
  wash?: boolean
  className?: string
}

/**
 * Status as a dot **plus a word**.
 *
 * The dot alone would be a colour-only encoding, which fails for roughly one in
 * twelve men and for anyone printing this. The word carries the meaning; the
 * dot only makes it findable at a glance. The text itself stays in ink — a
 * coloured swatch beside text carries identity, coloured text does not.
 */
export function StatusPip({
  status,
  label,
  size = 'sm',
  wash = false,
  className
}: StatusPipProps): ReactNode {
  const text = label ?? STATUS_LABEL[status]
  const dot = size === 'sm' ? 6 : 8

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-sm whitespace-nowrap',
        size === 'sm' ? 'gap-1.5 text-[11px]' : 'gap-2 text-[12px]',
        wash ? (size === 'sm' ? 'px-1.5 py-0.5' : 'px-2 py-1') : null,
        className
      )}
      style={wash ? { background: STATUS_WASH[status] } : undefined}
    >
      <span
        aria-hidden="true"
        className="shrink-0 rounded-full"
        style={{ width: dot, height: dot, background: STATUS_VAR[status] }}
      />
      <span style={{ color: 'var(--ink-secondary)' }}>{text}</span>
    </span>
  )
}
