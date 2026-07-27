import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  Check,
  ChevronsUpDown,
  ClipboardList,
  GitBranch,
  GitCommitHorizontal,
  LayoutGrid,
  Plus,
  Settings as SettingsIcon,
  TriangleAlert,
  X,
  type LucideIcon
} from 'lucide-react'
import { useActiveRepo, useStore, type ViewId } from '../../store'
import { ellipsisPath } from '../../lib/format'
import { cn } from '../../lib/cn'
import { Button } from './Button'
import { Tooltip } from './Tooltip'

interface NavEntry {
  id: ViewId
  label: string
  icon: LucideIcon
}

/** Order is the reading order of the app: state, shape, change, verdict, action. */
const NAV: readonly NavEntry[] = [
  { id: 'pulse', label: 'Pulse', icon: Activity },
  { id: 'map', label: 'Map', icon: LayoutGrid },
  { id: 'timeline', label: 'Timeline', icon: GitCommitHorizontal },
  { id: 'findings', label: 'Findings', icon: TriangleAlert },
  { id: 'brief', label: 'Brief', icon: ClipboardList }
] as const

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * The left navigation.
 *
 * Holds the two things that are true no matter which screen you are on: which
 * repository you are looking at, and which view you are in.
 */
export function Rail(): ReactNode {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const appVersion = useStore((s) => s.appVersion)

  return (
    <nav
      aria-label="Views"
      className="relative z-20 flex shrink-0 flex-col border-r"
      style={{
        width: 'var(--rail-width)',
        background: 'var(--surface-1)',
        borderColor: 'var(--hairline)'
      }}
    >
      <RepoSwitcher />

      <ul className="flex flex-col gap-0.5 px-2 py-1">
        {NAV.map((entry) => (
          <NavItem key={entry.id} entry={entry} active={view === entry.id} onSelect={setView} />
        ))}
      </ul>

      <div className="mt-auto px-2 pb-2">
        <ul className="flex flex-col gap-0.5">
          <NavItem
            entry={{ id: 'settings', label: 'Settings', icon: SettingsIcon }}
            active={view === 'settings'}
            onSelect={setView}
          />
        </ul>
        <p className="px-2 pt-2 text-[10px] tabular-nums" style={{ color: 'var(--ink-faint)' }}>
          VDE {appVersion ? `v${appVersion}` : ''}
        </p>
      </div>
    </nav>
  )
}

function NavItem({
  entry,
  active,
  onSelect
}: {
  entry: NavEntry
  active: boolean
  onSelect: (id: ViewId) => void
}): ReactNode {
  const Icon = entry.icon
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(entry.id)}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex min-h-8 w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-[12px] transition-colors duration-150',
          active
            ? 'bg-surface-2 font-medium text-ink'
            : 'text-ink-muted hover:bg-surface-2/60 hover:text-ink-secondary'
        )}
      >
        <Icon size={15} strokeWidth={active ? 2 : 1.75} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{entry.label}</span>
      </button>
    </li>
  )
}

/**
 * Repo switcher + popover.
 *
 * Hand-built rather than pulled from a library: it needs exactly three
 * behaviours — Escape closes, an outside click closes, and focus stays inside
 * while open — and those are cheaper to write than to configure.
 */
function RepoSwitcher(): ReactNode {
  const repos = useStore((s) => s.repos)
  const activeRepoId = useStore((s) => s.activeRepoId)
  const selectRepo = useStore((s) => s.selectRepo)
  const removeRepo = useStore((s) => s.removeRepo)
  const pickRepo = useStore((s) => s.pickRepo)
  const active = useActiveRepo()

  const [open, setOpen] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    setConfirmId(null)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  /**
   * Keeps focus inside the popover. Re-runs when the confirm row swaps in or
   * out, because the element that had focus is gone by then and a trap with
   * focus on <body> is not a trap.
   */
  useEffect(() => {
    if (!open) return
    const node = popRef.current
    if (!node || node.contains(document.activeElement)) return
    node.querySelector<HTMLElement>(FOCUSABLE)?.focus()
  }, [open, confirmId])

  useEffect(() => {
    if (!open) return

    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation()
        // Escape peels one layer at a time: the confirm row, then the popover.
        if (confirmId) setConfirmId(null)
        else close(true)
        return
      }
      if (e.key !== 'Tab') return
      const node = popRef.current
      if (!node) return
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE))
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    function onPointerDown(e: PointerEvent): void {
      const target = e.target
      if (!(target instanceof Node)) return
      if (popRef.current?.contains(target)) return
      // The trigger owns its own toggle; closing here would fight its onClick.
      if (triggerRef.current?.contains(target)) return
      close()
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open, close, confirmId])

  const branchLabel = active
    ? (active.branch ?? `detached · ${active.head.slice(0, 7)}`)
    : 'Open one to begin'

  return (
    <div className="relative border-b px-2 py-2" style={{ borderColor: 'var(--hairline)' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'flex min-h-11 w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors duration-150',
          open ? 'bg-surface-2' : 'hover:bg-surface-2'
        )}
        style={{ borderColor: 'var(--hairline)' }}
      >
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-[12.5px] font-medium"
            style={{ color: active ? 'var(--ink-primary)' : 'var(--ink-muted)' }}
          >
            {active?.name ?? 'No repository'}
          </span>
          <span className="flex items-center gap-1" style={{ color: 'var(--ink-muted)' }}>
            {active ? (
              <GitBranch size={10} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
            ) : null}
            <span className="truncate text-[10.5px]">{branchLabel}</span>
          </span>
        </span>
        <ChevronsUpDown
          size={13}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0"
          style={{ color: 'var(--ink-faint)' }}
        />
      </button>

      {open ? (
        <div
          ref={popRef}
          role="dialog"
          aria-modal="true"
          aria-label="Repositories"
          className="absolute top-full left-2 z-50 mt-1 w-[288px] rounded-md border p-1 shadow-xl"
          style={{ background: 'var(--surface-2)', borderColor: 'var(--hairline-strong)' }}
        >
          <p
            className="px-2 pt-1 pb-1.5 text-[10px] font-medium tracking-wider uppercase"
            style={{ color: 'var(--ink-faint)' }}
          >
            Repositories
          </p>

          {repos.length === 0 ? (
            <p className="px-2 pb-2 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
              None yet. VDE reads a repository's git history — it never writes to it.
            </p>
          ) : (
            <ul className="flex max-h-[280px] flex-col gap-0.5 overflow-y-auto">
              {repos.map((repo) =>
                confirmId === repo.id ? (
                  <li key={repo.id}>
                    <div
                      className="rounded-sm px-2 py-2"
                      style={{ background: 'var(--surface-3)' }}
                    >
                      <p className="text-[11px]" style={{ color: 'var(--ink-secondary)' }}>
                        Remove <span style={{ color: 'var(--ink-primary)' }}>{repo.name}</span> from
                        VDE?
                      </p>
                      <p className="mt-0.5 text-[10px]" style={{ color: 'var(--ink-faint)' }}>
                        Only VDE forgets it. Nothing on disk changes.
                      </p>
                      <div className="mt-2 flex gap-1.5">
                        <Button
                          size="sm"
                          variant="danger"
                          autoFocus
                          onClick={() => {
                            setConfirmId(null)
                            void removeRepo(repo.id)
                          }}
                        >
                          Remove
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </li>
                ) : (
                  <li key={repo.id} className="flex items-stretch gap-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        close()
                        if (repo.id !== activeRepoId) void selectRepo(repo.id)
                      }}
                      aria-current={repo.id === activeRepoId ? 'true' : undefined}
                      className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors duration-150 hover:bg-surface-3"
                    >
                      <span className="flex w-3.5 shrink-0 justify-center">
                        {repo.id === activeRepoId ? (
                          <Check
                            size={13}
                            strokeWidth={2}
                            aria-hidden="true"
                            style={{ color: 'var(--ink-primary)' }}
                          />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className="block truncate text-[12px]"
                          style={{ color: 'var(--ink-primary)' }}
                        >
                          {repo.name}
                        </span>
                        <span
                          className="block truncate font-mono text-[10px]"
                          style={{ color: 'var(--ink-faint)' }}
                        >
                          {ellipsisPath(repo.path, 34)}
                        </span>
                      </span>
                    </button>
                    <Tooltip content="Remove from VDE" side="right">
                      <button
                        type="button"
                        aria-label={`Remove ${repo.name} from VDE`}
                        onClick={() => setConfirmId(repo.id)}
                        className="flex w-7 shrink-0 items-center justify-center rounded-sm transition-colors duration-150 hover:bg-surface-3 hover:text-critical"
                        style={{ color: 'var(--ink-faint)' }}
                      >
                        <X size={13} strokeWidth={2} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  </li>
                )
              )}
            </ul>
          )}

          <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--hairline)' }}>
            <button
              type="button"
              onClick={() => {
                close()
                void pickRepo()
              }}
              className="flex min-h-9 w-full items-center gap-2 rounded-sm px-2 text-[12px] transition-colors duration-150 hover:bg-surface-3"
              style={{ color: 'var(--ink-secondary)' }}
            >
              <Plus size={13} strokeWidth={2} aria-hidden="true" className="shrink-0" />
              Add a repository…
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
