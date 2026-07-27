import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface SpinnerProps {
  /** Diameter in px. */
  size?: number
  /**
   * Accessible name. Omit when the spinner sits beside its own text label —
   * two announcements of the same fact is worse than one.
   */
  label?: string
  className?: string
}

/**
 * A 14px indeterminate spinner.
 *
 * Under `prefers-reduced-motion` the rotation is dropped rather than sped up:
 * the arc still reads as "busy" standing still, which is the whole point of
 * drawing a gap in the ring instead of a plain circle.
 */
export function Spinner({ size = 14, label, className }: SpinnerProps): ReactNode {
  const stroke = size <= 16 ? 2 : 2.5
  const r = Math.max(1, (size - stroke) / 2)
  const circumference = 2 * Math.PI * r

  return (
    <svg
      className={cn('shrink-0 animate-spin motion-reduce:animate-none', className)}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="currentColor"
        strokeWidth={stroke}
        opacity={0.22}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${circumference * 0.3} ${circumference}`}
      />
    </svg>
  )
}
