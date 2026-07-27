import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { RotateCcw, ShieldCheck } from 'lucide-react'
import type { BaselineKind, Settings as SettingsShape } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { Button } from '../components/ui/Button'
import { Segmented, type SegmentedOption } from '../components/ui/Segmented'
import { useStore } from '../store'

/**
 * Settings.
 *
 * Two things earn real estate here beyond the controls themselves. The first is
 * the cost of each choice — a number input with no explanation of what it buys
 * is a guess. The second is the read-only guarantee: VDE points at other
 * people's repositories, so the promise that it cannot write to one is a
 * product feature rather than a footnote, and it is stated in enough detail to
 * be checked instead of trusted.
 *
 * Every mutation goes through store.updateSettings, which persists to disk and
 * re-stamps the theme and texture attributes on the document root.
 *
 * App.tsx owns the scroll container and the route padding.
 */

// ---------------------------------------------------------------------------
// A switch. The kit has no toggle, so this is local rather than reaching into
// another module's files.
// ---------------------------------------------------------------------------

function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange(next: boolean): void
  label: string
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150"
      style={{
        background: checked ? 'var(--focus-ring)' : 'var(--surface-3)',
        border: '1px solid var(--hairline-strong)'
      }}
    >
      <span
        aria-hidden="true"
        className="absolute size-3.5 rounded-full transition-transform duration-150"
        style={{
          left: 2,
          background: checked ? 'var(--plane)' : 'var(--ink-muted)',
          transform: checked ? 'translateX(16px)' : 'none'
        }}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="card px-5 py-1">
      <h2
        className="border-b py-3 text-[10px] tracking-[0.08em] uppercase"
        style={{ borderColor: 'var(--hairline)', color: 'var(--ink-faint)' }}
      >
        {title}
      </h2>
      {children}
    </section>
  )
}

function Field({
  title,
  description,
  control,
  children
}: {
  title: string
  description: string
  control?: ReactNode
  children?: ReactNode
}): ReactNode {
  return (
    <div
      className="flex flex-col gap-3 border-b py-4 last:border-b-0"
      style={{ borderColor: 'var(--hairline)' }}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 max-w-[64ch]">
          <h3 className="text-[12.5px] font-medium" style={{ color: 'var(--ink-primary)' }}>
            {title}
          </h3>
          <p className="mt-1 text-[11.5px] leading-[1.6]" style={{ color: 'var(--ink-muted)' }}>
            {description}
          </p>
        </div>
        {control ? <div className="shrink-0 pt-0.5">{control}</div> : null}
      </div>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Glob editor
// ---------------------------------------------------------------------------

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function parseGlobs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

function GlobEditor({
  label,
  value,
  defaults,
  onCommit
}: {
  label: string
  value: readonly string[]
  defaults: readonly string[]
  onCommit(next: string[]): void
}): ReactNode {
  const [draft, setDraft] = useState(() => value.join('\n'))
  const [sync, setSync] = useState(() => value.join('\n'))
  const [saved, setSaved] = useState(false)
  const timer = useRef<number | null>(null)

  // Re-sync when the stored value changes underneath the textarea. Compared by
  // CONTENT, not identity: updateSettings returns a fresh Settings object for
  // every change, so an identity check would wipe an in-progress edit whenever
  // an unrelated switch was flipped.
  const incoming = value.join('\n')
  if (sync !== incoming) {
    setSync(incoming)
    setDraft(incoming)
  }

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  // Committing on blur rather than behind an Apply button: this is a settings
  // pane, and an edit the user tabs away from should not be silently discarded.
  function commit(): void {
    const next = parseGlobs(draft)
    if (sameList(next, value)) return
    onCommit(next)
    setSaved(true)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setSaved(false), 1800)
  }

  const isDefault = sameList(value, defaults)
  const count = parseGlobs(draft).length

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="tnum text-[11px]" style={{ color: 'var(--ink-faint)' }}>
          {count} {count === 1 ? 'pattern' : 'patterns'}, one per line
        </span>
        <span className="flex items-center gap-2">
          <span
            role="status"
            aria-live="polite"
            className="text-[11px]"
            style={{ color: 'var(--ink-muted)' }}
          >
            {saved ? 'Saved' : ''}
          </span>
          <Button
            size="sm"
            variant="ghost"
            icon={RotateCcw}
            disabled={isDefault}
            onClick={() => onCommit([...defaults])}
          >
            Restore defaults
          </Button>
        </span>
      </div>
      <textarea
        value={draft}
        aria-label={label}
        spellCheck={false}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            commit()
          }
        }}
        rows={Math.min(14, Math.max(5, count + 1))}
        className="w-full resize-y rounded-md p-2.5 font-mono text-[11.5px] leading-[1.7] outline-none"
        style={{
          background: 'var(--surface-inset)',
          border: '1px solid var(--hairline)',
          color: 'var(--ink-primary)'
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// The read-only guarantee
// ---------------------------------------------------------------------------

/** Mirrors the allowlist enforced in analyzer/git/exec.ts. */
const READ_ONLY_COMMANDS = [
  'rev-parse',
  'rev-list',
  'log',
  'show',
  'ls-tree',
  'ls-files',
  'cat-file',
  'diff-tree',
  'diff',
  'shortlog',
  'for-each-ref',
  'symbolic-ref',
  'name-rev',
  'describe',
  'merge-base',
  'blame',
  'count-objects',
  'var',
  'config --get'
] as const

function Mono({ children }: { children: string }): ReactNode {
  return (
    <span className="font-mono" style={{ color: 'var(--ink-secondary)' }}>
      {children}
    </span>
  )
}

function ReadOnlyGuarantee(): ReactNode {
  return (
    <section className="card overflow-hidden" style={{ borderColor: 'var(--hairline-strong)' }}>
      <div className="flex items-start gap-3 px-5 pt-5">
        <ShieldCheck
          size={18}
          strokeWidth={1.75}
          aria-hidden="true"
          className="mt-0.5 shrink-0"
          style={{ color: 'var(--status-good)' }}
        />
        <div className="min-w-0">
          <h2 className="text-[13.5px] font-medium" style={{ color: 'var(--ink-primary)' }}>
            VDE cannot write to a repository it analyses
          </h2>
          <p
            className="mt-1.5 max-w-[78ch] text-[12px] leading-[1.7]"
            style={{ color: 'var(--ink-secondary)' }}
          >
            Not &ldquo;does not&rdquo; — <em>cannot</em>. Every git invocation in the entire
            application passes through one gateway that rejects anything outside the allowlist below
            before a process is spawned, and the repository&rsquo;s state is fingerprinted before and
            after every scan so the promise is checked rather than asserted.
          </p>
        </div>
      </div>

      <dl className="grid gap-x-8 gap-y-5 px-5 py-5 md:grid-cols-2">
        <div>
          <dt className="text-[11px] font-medium" style={{ color: 'var(--ink-primary)' }}>
            An allowlist of read-only subcommands
          </dt>
          <dd className="mt-2">
            <ul className="flex flex-wrap gap-1">
              {READ_ONLY_COMMANDS.map((c) => (
                <li
                  key={c}
                  className="rounded-sm px-1.5 py-0.5 font-mono text-[10.5px]"
                  style={{ background: 'var(--surface-2)', color: 'var(--ink-secondary)' }}
                >
                  git {c}
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-[11.5px] leading-[1.65]" style={{ color: 'var(--ink-muted)' }}>
              Nothing else is reachable — no <Mono>commit</Mono>, no <Mono>checkout</Mono>, no{' '}
              <Mono>fetch</Mono>, no <Mono>gc</Mono>. Argument forms that could turn a read into a
              write or an escape are rejected too: <Mono>-c</Mono>, <Mono>-C</Mono>,{' '}
              <Mono>--git-dir</Mono>, <Mono>--work-tree</Mono>, <Mono>--exec-path</Mono> and{' '}
              <Mono>-w</Mono>.
            </p>
          </dd>
        </div>

        <div>
          <dt className="text-[11px] font-medium" style={{ color: 'var(--ink-primary)' }}>
            A fingerprint before and after every scan
          </dt>
          <dd className="mt-2 text-[11.5px] leading-[1.7]" style={{ color: 'var(--ink-muted)' }}>
            <p>
              VDE records HEAD, a hash of every ref, and the size and modification time of{' '}
              <Mono>.git/index</Mono> before it starts, then verifies all four when it finishes. A
              mismatch aborts the scan and surfaces an error instead of a result.
            </p>
            <p className="mt-2">
              Reads run with <Mono>GIT_OPTIONAL_LOCKS=0</Mono>, so git will not so much as take{' '}
              <Mono>index.lock</Mono> to refresh the index as a side effect, and with the pager,
              fsmonitor, <Mono>diff.external</Mono> and hooks paths neutralised — the routes by which
              a hostile repository could otherwise run code during a read.
            </p>
          </dd>
        </div>
      </dl>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const THEME_OPTIONS: readonly SegmentedOption<SettingsShape['theme']>[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System', hint: 'follow the operating system' }
] as const

const BASELINE_OPTIONS: readonly SegmentedOption<BaselineKind>[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'first', label: 'First commit' },
  { value: 'commit', label: 'Pinned', hint: 'a commit you choose per report' }
] as const

const BASELINE_NOTE: Record<BaselineKind, string> = {
  '7d': 'Compares against the snapshot nearest a week ago — roughly the last few agent sessions, which is where a regression is still cheap to undo.',
  '30d': 'Compares against the snapshot nearest a month ago. Slow-moving signals like directory sprawl need this much distance before a trend is visible.',
  '90d': 'Compares against the snapshot nearest a quarter ago. Best for a project you check in on occasionally.',
  first:
    'Compares against the repository’s first snapshot — the whole story since the beginning. Every delta will look large, because every delta is.',
  commit:
    'Compares against a specific commit you pick per report, e.g. the last one a human actually reviewed.'
}

function userDataNote(platform: string): string {
  if (platform === 'darwin') return '~/Library/Application Support/VDE'
  if (platform === 'win32') return '%APPDATA%\\VDE'
  return '~/.config/VDE'
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function Settings(): ReactNode {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const appVersion = useStore((s) => s.appVersion)

  const [platform, setPlatform] = useState('')
  const [snapshotDraft, setSnapshotDraft] = useState(() => String(settings.maxSnapshots))
  const [snapshotSync, setSnapshotSync] = useState(settings.maxSnapshots)

  // Keep the draft honest when the stored value changes elsewhere.
  if (snapshotSync !== settings.maxSnapshots) {
    setSnapshotSync(settings.maxSnapshots)
    setSnapshotDraft(String(settings.maxSnapshots))
  }

  useEffect(() => {
    let alive = true
    window.vde.app
      .platform()
      .then((p) => {
        if (alive) setPlatform(String(p))
      })
      .catch(() => {
        // The location note falls back to the generic path.
      })
    return () => {
      alive = false
    }
  }, [])

  const patch = useCallback(
    (next: Partial<SettingsShape>) => {
      void updateSettings(next)
    },
    [updateSettings]
  )

  const commitSnapshots = useCallback(() => {
    const parsed = Number.parseInt(snapshotDraft, 10)
    // The main process clamps to the same range; matching it here means the
    // input never shows a number that was silently rewritten on the way to disk.
    const clamped = Number.isFinite(parsed)
      ? Math.max(10, Math.min(1000, parsed))
      : settings.maxSnapshots
    setSnapshotDraft(String(clamped))
    if (clamped !== settings.maxSnapshots) patch({ maxSnapshots: clamped })
  }, [snapshotDraft, settings.maxSnapshots, patch])

  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-4">
      {/* Settings renders without the TopBar, so it owns the page's h1. */}
      <header>
        <h1 className="text-[13px] font-medium" style={{ color: 'var(--ink-primary)' }}>
          Settings
        </h1>
        <p className="mt-0.5 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
          Applied immediately and stored beside VDE&rsquo;s own database. Changing an analysis
          setting takes effect on the next scan.
        </p>
      </header>

      <ReadOnlyGuarantee />

      {/* -- appearance ----------------------------------------------------- */}
      <Section title="Appearance">
        <Field
          title="Theme"
          description="System follows the operating system’s light and dark setting. The chart palette is not one theme flipped — each uses colours validated against its own surface."
          control={
            <Segmented
              label="Theme"
              options={THEME_OPTIONS}
              value={settings.theme}
              onChange={(theme) => patch({ theme })}
            />
          }
        />
        <Field
          title="Texture fills"
          description="Adds a hatched texture to filled marks so series can be told apart without relying on hue. This is the accessibility channel for colour-blind readers, greyscale print and forced-colors mode; it stays off by default because texture is noise for anyone who does not need it."
          control={
            <Switch
              label="Texture fills"
              checked={settings.textureFills}
              onChange={(textureFills) => patch({ textureFills })}
            />
          }
        />
      </Section>

      {/* -- analysis -------------------------------------------------------- */}
      <Section title="Analysis">
        <Field
          title="Default baseline"
          description={BASELINE_NOTE[settings.defaultBaseline]}
          control={
            <Segmented
              label="Default baseline"
              options={BASELINE_OPTIONS}
              value={settings.defaultBaseline}
              onChange={(defaultBaseline) => patch({ defaultBaseline })}
            />
          }
        />

        <Field
          title="Maximum snapshots"
          description="A snapshot is a full reconstruction of the tree at a past commit, and it is the expensive part of a scan. More snapshots buy denser, more truthful trend lines and a baseline that lands closer to the date you asked for. Fewer make the first scan of a large repository dramatically faster and keep the cache small. VDE spends the budget adaptively — daily for recent history, then weekly, then monthly — so raising this mostly sharpens the recent end of every chart."
          control={
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={10}
                max={1000}
                step={10}
                value={snapshotDraft}
                aria-label="Maximum snapshots"
                onChange={(e) => setSnapshotDraft(e.currentTarget.value)}
                onBlur={commitSnapshots}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitSnapshots()
                  }
                }}
                className="tnum h-8 w-24 rounded-sm px-2 text-right text-[12px] outline-none"
                style={{
                  background: 'var(--surface-inset)',
                  border: '1px solid var(--hairline)',
                  color: 'var(--ink-primary)'
                }}
              />
              <span className="tnum text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                10–1000
              </span>
            </div>
          }
        />

        <Field
          title="Watch HEAD"
          description="Re-scans the active repository when its HEAD changes on disk, so the dashboard keeps up while an agent is committing. Turn it off if you would rather scan deliberately — the scan is read-only either way."
          control={
            <Switch
              label="Watch HEAD"
              checked={settings.watchHead}
              onChange={(watchHead) => patch({ watchHead })}
            />
          }
        />
      </Section>

      {/* -- file selection --------------------------------------------------- */}
      <Section title="File selection">
        <Field
          title="Excluded paths"
          description="Files matching these globs are invisible to every signal. Dependencies, build output and minified bundles belong here — counting them would drown the measurements that describe code somebody actually wrote."
        >
          <GlobEditor
            label="Excluded globs, one per line"
            value={settings.excludeGlobs}
            defaults={DEFAULT_SETTINGS.excludeGlobs}
            onCommit={(excludeGlobs) => patch({ excludeGlobs })}
          />
        </Field>

        <Field
          title="Generated paths"
          description="Files matching these globs are still shown — they are part of the repository — but they are flagged as generated and kept out of the scores. A 6,000-line lockfile is not a god file, and a schema emitted by a code generator is not write-once code."
        >
          <GlobEditor
            label="Generated globs, one per line"
            value={settings.generatedGlobs}
            defaults={DEFAULT_SETTINGS.generatedGlobs}
            onCommit={(generatedGlobs) => patch({ generatedGlobs })}
          />
        </Field>
      </Section>

      {/* -- about ------------------------------------------------------------ */}
      <Section title="About">
        <Field
          title="Version and storage"
          description="Snapshots, cached blobs and this settings file live in VDE’s own application-support directory. Removing a repository from VDE deletes its cached analysis and nothing else — the repository itself is never touched."
          control={
            <span className="tnum text-[12px]" style={{ color: 'var(--ink-primary)' }}>
              {appVersion === '' ? '—' : `v${appVersion}`}
            </span>
          }
        >
          <p className="font-mono text-[11px]" style={{ color: 'var(--ink-faint)' }} data-selectable>
            {userDataNote(platform)}
          </p>
        </Field>
      </Section>
    </div>
  )
}
