import { useEffect, useState, type ReactNode } from 'react'
import {
  FolderOpen,
  Lock,
  Radar,
  RotateCw,
  ShieldAlert,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react'
import type { AnalysisPhase, AnalysisProgress, Settings } from '../shared/types'
import { useActiveRepo, useStore, type ViewId } from './store'
import { useHeldValue } from './components/charts/primitives'
import { ellipsisPath, plain } from './lib/format'
import { Rail } from './components/ui/Rail'
import { TopBar } from './components/ui/TopBar'
import { EmptyState } from './components/ui/EmptyState'
import { Button } from './components/ui/Button'
import { ProgressBar } from './components/ui/ProgressBar'
import { Spinner } from './components/ui/Spinner'

// The five data views plus Settings. Each is owned by another module and
// exported by name — there are no default exports anywhere in this codebase.
import { Pulse } from './routes/Pulse'
import { Map as MapRoute } from './routes/Map'
import { Timeline } from './routes/Timeline'
import { Findings } from './routes/Findings'
import { Brief } from './routes/Brief'
import { Settings as SettingsRoute } from './routes/Settings'

/**
 * Friendly names for the analyzer's phases. The raw phase ids are a protocol
 * detail; a person waiting on a progress bar wants to know what is being read.
 */
const PHASE_LABEL: Record<AnalysisPhase, string> = {
  queued: 'Queued',
  validating: 'Checking the repository',
  'reading-history': 'Reading commit history',
  'scanning-tree': 'Scanning the working tree',
  'parsing-content': 'Parsing source files',
  backfilling: 'Rebuilding historical snapshots',
  'computing-signals': 'Computing signals',
  done: 'Finished',
  cancelled: 'Cancelled',
  error: 'Analysis failed'
}

/**
 * The repository-integrity tripwire. VDE's one hard promise is that it never
 * writes to an analyzed repo; if the analyzer reports that promise was tested,
 * that message outranks whatever else is on screen.
 */
const TRIPWIRE = /read-only|read only|VDE detected a change/i

export function App(): ReactNode {
  const view = useStore((s) => s.view)
  const repos = useStore((s) => s.repos)
  const report = useStore((s) => s.report)
  const reportError = useStore((s) => s.reportError)
  const loading = useStore((s) => s.loading)
  const progress = useStore((s) => s.progress)
  const repo = useActiveRepo()

  const [isMac, setIsMac] = useState(true)

  // Traffic lights only need clearing on macOS; everywhere else that gap is
  // just dead chrome.
  useEffect(() => {
    let alive = true
    void (async () => {
      const platform: unknown = await window.vde.app.platform()
      if (alive) setIsMac(platform === 'darwin')
    })()
    return () => {
      alive = false
    }
  }, [])

  // Menu → store. Read state lazily so this subscribes exactly once and never
  // fires with a stale closure.
  useEffect(
    () =>
      window.vdeMenu.onAction((action) => {
        const s = useStore.getState()
        switch (action) {
          case 'open-repo':
            void s.pickRepo()
            break
          case 'rescan':
            void s.scan(true)
            break
          case 'go-pulse':
            s.setView('pulse')
            break
          case 'go-map':
            s.setView('map')
            break
          case 'go-timeline':
            s.setView('timeline')
            break
          case 'go-findings':
            s.setView('findings')
            break
          case 'go-brief':
            s.setView('brief')
            break
          case 'copy-brief':
            // The Brief view owns the clipboard; this only puts it on screen.
            s.setView('brief')
            break
          case 'settings':
            s.setView('settings')
            break
          case 'toggle-theme':
            s.applyTheme(resolvedTheme(s.settings.theme) === 'dark' ? 'light' : 'dark')
            break
          default:
            break
        }
      }),
    []
  )

  // A refetch holds the previous render at reduced opacity. A skeleton here
  // would throw away a screen the user is still reading.
  const { stale } = useHeldValue(report, loading)
  const holding = stale && report !== null

  /**
   * Every global state is resolved here, in priority order, so that no route
   * has to know how to draw "no repo", "never scanned", "scanning" or "failed".
   */
  function body(): ReactNode {
    // Settings needs no repository, so it stays reachable from every state.
    if (view === 'settings') {
      return (
        <Scroll>
          <SettingsRoute />
        </Scroll>
      )
    }

    // A startup or analysis failure outranks the empty state — an error the
    // user cannot see is an app that just looks broken.
    if (reportError && !report && (!repo || repo.lastScanAt !== null)) {
      return (
        <Centered>
          <ErrorReport message={reportError} layout="panel" hasRepo={repo !== null} />
        </Centered>
      )
    }

    if (!repo) {
      return (
        <Centered>
          <EmptyState
            icon={FolderOpen}
            headline={repos.length === 0 ? 'Open a repository' : 'Choose a repository'}
            body="VDE reads a git repository's history and file tree to show where an agent-written codebase is drifting. It only ever reads — nothing is written to your repository."
            action={
              <Button
                variant="primary"
                icon={FolderOpen}
                onClick={() => void useStore.getState().pickRepo()}
              >
                Open a repository
              </Button>
            }
            footnote="Your repository never leaves this machine."
          />
        </Centered>
      )
    }

    if (progress && !report) {
      return (
        <Centered>
          <ScanProgress progress={progress} repoId={repo.id} layout="panel" />
        </Centered>
      )
    }

    if (!report && loading) {
      return (
        <Centered>
          <span
            className="flex items-center gap-2 text-[12px]"
            style={{ color: 'var(--ink-muted)' }}
          >
            <Spinner size={14} />
            {repo.lastScanAt ? 'Loading report…' : 'Starting scan…'}
          </span>
        </Centered>
      )
    }

    if (!report) {
      return (
        <Centered>
          <EmptyState
            icon={Radar}
            headline={`Scan ${repo.name}`}
            body="VDE has not analysed this repository yet. The first scan walks the full commit history and rebuilds historical snapshots, so it is the slow one."
            action={
              <Button variant="primary" icon={Radar} onClick={() => void useStore.getState().scan()}>
                Scan now
              </Button>
            }
            footnote="VDE reads your repository. It never writes to it."
          />
        </Centered>
      )
    }

    return (
      <>
        <TopBar />
        {progress ? <ScanProgress progress={progress} repoId={repo.id} layout="strip" /> : null}
        {reportError ? <ErrorReport message={reportError} layout="banner" hasRepo /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            className="px-5 py-4"
            style={{ opacity: holding ? 0.55 : 1, transition: 'opacity 160ms ease-out' }}
          >
            {routeFor(view)}
          </div>
        </div>
      </>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <TitleStrip path={repo?.path ?? null} isMac={isMac} />
      <div className="flex min-h-0 flex-1">
        <Rail />
        <main
          className="flex min-w-0 flex-1 flex-col"
          style={{ background: 'var(--plane)' }}
          aria-busy={holding || undefined}
        >
          {body()}
        </main>
      </div>
    </div>
  )
}

function routeFor(view: ViewId): ReactNode {
  switch (view) {
    case 'pulse':
      return <Pulse />
    case 'map':
      return <MapRoute />
    case 'timeline':
      return <Timeline />
    case 'findings':
      return <Findings />
    case 'brief':
      return <Brief />
    case 'settings':
      return <SettingsRoute />
    default:
      return null
  }
}

/** 'system' has to be resolved before it can be flipped. */
function resolvedTheme(theme: Settings['theme']): 'dark' | 'light' {
  if (theme !== 'system') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/**
 * The draggable title strip. Nothing in it is interactive, so the whole strip
 * stays a drag handle — and the otherwise-dead space carries the one claim the
 * user is trusting: VDE reads, it does not write.
 */
function TitleStrip({ path, isMac }: { path: string | null; isMac: boolean }): ReactNode {
  return (
    <header
      className="drag-region flex shrink-0 items-center gap-3 border-b pr-4"
      style={{
        height: 'var(--chrome-height)',
        paddingLeft: isMac ? 80 : 14,
        background: 'var(--surface-1)',
        borderColor: 'var(--hairline)'
      }}
    >
      <span
        className="shrink-0 text-[11px] font-semibold tracking-[0.16em] uppercase"
        style={{ color: 'var(--ink-secondary)' }}
      >
        VDE
      </span>
      {path ? (
        <>
          <span aria-hidden="true" className="h-3 w-px" style={{ background: 'var(--hairline)' }} />
          <span
            className="truncate font-mono text-[10.5px]"
            style={{ color: 'var(--ink-faint)' }}
            title={path}
          >
            {ellipsisPath(path, 64)}
          </span>
        </>
      ) : null}
      <span
        className="ml-auto flex shrink-0 items-center gap-1.5 text-[10.5px]"
        style={{ color: 'var(--ink-faint)' }}
      >
        <Lock size={11} strokeWidth={1.75} aria-hidden="true" />
        Read-only
      </span>
    </header>
  )
}

function Centered({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
      {children}
    </div>
  )
}

function Scroll({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-5 py-4">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Global states
// ---------------------------------------------------------------------------

function ScanProgress({
  progress,
  repoId,
  layout
}: {
  progress: AnalysisProgress
  repoId: string
  layout: 'panel' | 'strip'
}): ReactNode {
  const [cancelling, setCancelling] = useState(false)

  // The phase reports its own countability; `overall` is what we draw, because
  // a bar that restarts every phase reads as a bar that is going backwards.
  const determinate = progress.total > 0 || progress.overall > 0
  const pct = Math.round(Math.min(1, Math.max(0, progress.overall)) * 100)
  const phase = PHASE_LABEL[progress.phase]

  function cancel(): void {
    setCancelling(true)
    void window.vde.analysis.cancel(repoId)
  }

  if (layout === 'strip') {
    return (
      <div
        className="flex shrink-0 items-center gap-3 border-b px-5 py-2"
        style={{ borderColor: 'var(--hairline)' }}
      >
        <span className="shrink-0 text-[11px]" style={{ color: 'var(--ink-secondary)' }}>
          {phase}
        </span>
        <ProgressBar
          className="max-w-[240px] min-w-[80px] flex-1"
          value={progress.overall}
          total={determinate ? 1 : 0}
          label={`Scan progress — ${phase}`}
        />
        {determinate ? (
          <span className="tnum shrink-0 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
            {pct}%
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: 'var(--ink-faint)' }}>
          {progress.message}
        </span>
        <Button size="sm" variant="ghost" disabled={cancelling} onClick={cancel}>
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </Button>
      </div>
    )
  }

  return (
    <div className="w-full max-w-[440px]">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-medium" style={{ color: 'var(--ink-primary)' }}>
          {phase}
        </h2>
        {determinate ? (
          <span className="tnum text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
            {pct}%
          </span>
        ) : (
          <Spinner size={13} label="Working" />
        )}
      </div>

      <ProgressBar
        className="mt-2.5"
        value={progress.overall}
        total={determinate ? 1 : 0}
        label={`Scan progress — ${phase}`}
      />

      <p className="mt-2.5 truncate text-[11.5px]" style={{ color: 'var(--ink-muted)' }}>
        {progress.message}
      </p>
      {progress.total > 0 ? (
        <p className="tnum mt-0.5 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
          {plain(progress.current)} / {plain(progress.total)}
        </p>
      ) : null}

      <div className="mt-5 flex items-center gap-3">
        <Button size="sm" variant="ghost" disabled={cancelling} onClick={cancel}>
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </Button>
        <span className="text-[11px]" style={{ color: 'var(--ink-faint)' }}>
          VDE reads your repository. It never writes to it.
        </span>
      </div>
    </div>
  )
}

/**
 * Analysis errors. The integrity tripwire gets the critical treatment — status
 * colour, a shield glyph AND the words, never colour alone — because it is the
 * one error that says something about the user's repository rather than about
 * VDE.
 */
function ErrorReport({
  message,
  layout,
  hasRepo
}: {
  message: string
  layout: 'panel' | 'banner'
  hasRepo: boolean
}): ReactNode {
  const critical = TRIPWIRE.test(message)
  const Icon: LucideIcon = critical ? ShieldAlert : TriangleAlert
  const title = critical ? 'Repository integrity' : 'Analysis failed'
  const accent = critical ? 'var(--status-critical)' : 'var(--hairline-strong)'

  const actions = hasRepo ? (
    <>
      <Button
        size="sm"
        variant={critical ? 'primary' : 'ghost'}
        icon={RotateCw}
        onClick={() => void useStore.getState().loadReport()}
      >
        Retry
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void useStore.getState().scan(true)}>
        Rescan from scratch
      </Button>
    </>
  ) : (
    <Button
      size="sm"
      variant="primary"
      icon={FolderOpen}
      onClick={() => void useStore.getState().pickRepo()}
    >
      Open a repository
    </Button>
  )

  if (layout === 'banner') {
    return (
      <div
        role="alert"
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-2.5"
        style={{
          borderColor: accent,
          background: critical ? 'var(--status-critical-wash)' : 'var(--surface-1)'
        }}
      >
        <Icon
          size={14}
          strokeWidth={2}
          aria-hidden="true"
          className="shrink-0"
          style={{ color: critical ? 'var(--status-critical)' : 'var(--ink-muted)' }}
        />
        <span className="shrink-0 text-[12px] font-medium" style={{ color: 'var(--ink-primary)' }}>
          {title}
        </span>
        <span
          className="min-w-0 flex-1 text-[11.5px]"
          style={{ color: 'var(--ink-secondary)' }}
          data-selectable
        >
          {message}
        </span>
        <span className="flex shrink-0 items-center gap-2">{actions}</span>
      </div>
    )
  }

  return (
    <div
      role="alert"
      className="w-full max-w-[520px] rounded-lg border p-5"
      style={{
        borderColor: accent,
        background: critical ? 'var(--status-critical-wash)' : 'var(--surface-1)'
      }}
    >
      <div className="flex items-center gap-2">
        <Icon
          size={16}
          strokeWidth={2}
          aria-hidden="true"
          style={{ color: critical ? 'var(--status-critical)' : 'var(--ink-muted)' }}
        />
        <h2 className="text-[13px] font-medium" style={{ color: 'var(--ink-primary)' }}>
          {title}
        </h2>
      </div>

      <p
        className="mt-2 text-[12px] leading-relaxed"
        style={{ color: 'var(--ink-secondary)' }}
        data-selectable
      >
        {message}
      </p>

      {critical ? (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
          Analysis stopped. Nothing was written to your repository.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  )
}
