import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  /**
   * Expands the terse visible label for assistive tech. It is APPENDED to the
   * label rather than replacing it, so the accessible name still contains the
   * visible text (WCAG 2.5.3) and voice control can say "click 7d".
   */
  hint?: string
}

export interface SegmentedProps<T extends string> {
  /** Two to five options. Beyond five this should be a select. */
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Accessible group name. Render a visible label beside it too. */
  label: string
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
}

/**
 * A real radiogroup: one tab stop for the whole control, arrows to move between
 * options, Home/End for the ends. A row of independently tabbable buttons is
 * the usual mistake and makes a keyboard user press Tab four times to cross a
 * filter.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'sm',
  disabled = false,
  className
}: SegmentedProps<T>): ReactNode {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const selected = options.findIndex((o) => o.value === value)

  function move(to: number): void {
    const next = options[to]
    if (!next) return
    onChange(next.value)
    refs.current[to]?.focus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const n = options.length
    if (n === 0) return
    const from = selected < 0 ? 0 : selected
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault()
        move((from + 1) % n)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault()
        move((from - 1 + n) % n)
        break
      case 'Home':
        e.preventDefault()
        move(0)
        break
      case 'End':
        e.preventDefault()
        move(n - 1)
        break
      default:
        break
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        'no-drag inline-flex items-center gap-0.5 rounded-sm border border-hairline bg-surface-1 p-0.5',
        disabled ? 'pointer-events-none opacity-45' : null,
        className
      )}
    >
      {options.map((opt, i) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.hint ? `${opt.label}: ${opt.hint}` : undefined}
            tabIndex={active || (selected < 0 && i === 0) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex select-none items-center justify-center rounded-sm font-medium whitespace-nowrap',
              'transition-colors duration-150',
              size === 'sm' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-[12px]',
              active ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:text-ink-secondary'
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
