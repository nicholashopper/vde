import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

export interface TooltipProps {
  /** Short. A tooltip that needs a paragraph is a popover. */
  content: ReactNode
  side?: TooltipSide
  /** ms before a hover opens it. Keyboard focus always opens immediately. */
  delay?: number
  disabled?: boolean
  /** A single element that can receive `aria-describedby`. */
  children: ReactElement<{ 'aria-describedby'?: string }>
}

const GAP = 6
const EDGE = 8

/**
 * A tooltip for UI chrome — buttons, icon controls, truncated metadata.
 *
 * Charts do NOT use this: they share one tooltip surface per card from
 * charts/primitives.tsx, because a chart with thousands of marks cannot afford
 * a listener per mark.
 *
 * It opens on hover *and* on focus, is portalled to the body so no overflow
 * container can clip it, and never carries information that is not also
 * available some other way.
 */
export function Tooltip({
  content,
  side = 'top',
  delay = 250,
  disabled = false,
  children
}: TooltipProps): ReactNode {
  const id = useId()
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const open = anchor !== null && !disabled

  const hide = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    setAnchor(null)
    setPos(null)
  }, [])

  const show = useCallback(
    (immediate: boolean) => {
      if (disabled) return
      const measure = (): void => {
        const el = wrapperRef.current
        if (el) setAnchor(el.getBoundingClientRect())
      }
      if (immediate || delay <= 0) {
        measure()
        return
      }
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(measure, delay)
    },
    [delay, disabled]
  )

  useEffect(() => hide, [hide])

  // Position after the bubble exists so its real box drives the flip.
  useLayoutEffect(() => {
    if (!anchor) return
    const el = bubbleRef.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = 0
    let top = 0
    if (side === 'top' || side === 'bottom') {
      left = anchor.left + anchor.width / 2 - w / 2
      top = side === 'top' ? anchor.top - h - GAP : anchor.bottom + GAP
      if (side === 'top' && top < EDGE) top = anchor.bottom + GAP
      if (side === 'bottom' && top + h > window.innerHeight - EDGE) top = anchor.top - h - GAP
    } else {
      top = anchor.top + anchor.height / 2 - h / 2
      left = side === 'left' ? anchor.left - w - GAP : anchor.right + GAP
      if (side === 'left' && left < EDGE) left = anchor.right + GAP
      if (side === 'right' && left + w > window.innerWidth - EDGE) left = anchor.left - w - GAP
    }
    setPos({
      left: Math.min(Math.max(EDGE, left), Math.max(EDGE, window.innerWidth - w - EDGE)),
      top: Math.min(Math.max(EDGE, top), Math.max(EDGE, window.innerHeight - h - EDGE))
    })
  }, [anchor, side, content])

  // A stale position is worse than no tooltip, so movement dismisses.
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
    }
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [open, hide])

  if (disabled || content === null || content === undefined || content === '') return children

  return (
    <>
      <span
        ref={wrapperRef}
        className="inline-flex"
        onPointerEnter={() => show(false)}
        onPointerLeave={hide}
        onPointerDown={hide}
        onFocus={() => show(true)}
        onBlur={hide}
      >
        {cloneElement(children, { 'aria-describedby': open ? id : undefined })}
      </span>

      {open
        ? createPortal(
            <div
              ref={bubbleRef}
              id={id}
              role="tooltip"
              className="pointer-events-none fixed z-[100] max-w-[240px] rounded-sm px-2 py-1 text-[11px] leading-snug shadow-lg"
              style={{
                left: pos?.left ?? 0,
                top: pos?.top ?? 0,
                visibility: pos ? 'visible' : 'hidden',
                background: 'var(--surface-3)',
                border: '1px solid var(--hairline-strong)',
                color: 'var(--ink-primary)'
              }}
            >
              {content}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
