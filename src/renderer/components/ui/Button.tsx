import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Leading icon, sized by the button. Pass the component, not an element. */
  icon?: LucideIcon
  /** Swaps the icon for a spinner and blocks interaction. */
  loading?: boolean
  /** Square control with no label. `aria-label` is then mandatory. */
  iconOnly?: boolean
  children?: ReactNode
}

/**
 * The one button.
 *
 * `primary` is an ink fill rather than a hue: this app spends its colour budget
 * on data, so the loudest chrome element is still achromatic. `danger` borrows
 * the critical status colour, which is legitimate only because it always ships
 * beside a word ("Remove") — status colour never carries the meaning alone.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-plane hover:opacity-90 active:opacity-80',
  ghost:
    'border border-hairline bg-transparent text-ink-secondary hover:border-hairline-strong hover:bg-surface-2 hover:text-ink',
  danger:
    'border border-hairline bg-transparent text-critical hover:border-hairline-strong hover:bg-critical/10'
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 min-h-7 gap-1.5 px-2.5 text-[11px]',
  md: 'h-8 min-h-8 gap-2 px-3 text-[12px]'
}

const ICON_ONLY_SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 min-h-7 w-7 gap-0 px-0 text-[11px]',
  md: 'h-8 min-h-8 w-8 gap-0 px-0 text-[12px]'
}

const ICON_PX: Record<ButtonSize, number> = { sm: 13, md: 14 }

export function Button({
  variant = 'ghost',
  size = 'md',
  icon: Icon,
  loading = false,
  iconOnly = false,
  disabled,
  className,
  children,
  type,
  ...rest
}: ButtonProps): ReactNode {
  const px = ICON_PX[size]
  return (
    <button
      {...rest}
      type={type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'no-drag inline-flex shrink-0 select-none items-center justify-center rounded-sm font-medium whitespace-nowrap',
        'transition-colors duration-150',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANT[variant],
        iconOnly ? ICON_ONLY_SIZE[size] : SIZE[size],
        className
      )}
    >
      {loading ? (
        <Spinner size={px} />
      ) : Icon ? (
        <Icon size={px} strokeWidth={2} aria-hidden="true" />
      ) : null}
      {iconOnly ? null : children}
    </button>
  )
}
