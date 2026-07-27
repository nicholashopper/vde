import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Conditional class names with conflict resolution.
 *
 * `clsx` flattens the conditional forms; `twMerge` makes the LAST utility win
 * when two of the same family collide, so a caller's `className` can always
 * override a component's default without specificity games.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
