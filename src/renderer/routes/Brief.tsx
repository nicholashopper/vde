import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, Download, SlidersHorizontal } from 'lucide-react'
import { plain, relativeTime } from '../lib/format'
import { Markdown } from '../components/Markdown'
import { Button } from '../components/ui/Button'
import { Segmented, type SegmentedOption } from '../components/ui/Segmented'
import { Spinner } from '../components/ui/Spinner'
import { useStore } from '../store'
import { useBriefSelection } from './Findings'

/**
 * Brief — the exportable remediation document.
 *
 * The brief is not a report for a person to admire; it is an input to another
 * program. Two decisions follow from that. The raw markdown is always one click
 * away, because an engineer about to paste something wants to see the exact
 * bytes. And the size of the document is stated up front, because it has to fit
 * inside a context window.
 *
 * App.tsx owns the scroll container, the route padding and the empty/loading/
 * error states.
 */

type ViewMode = 'rendered' | 'source'

const MODES: readonly SegmentedOption<ViewMode>[] = [
  { value: 'rendered', label: 'Rendered', hint: 'formatted brief' },
  { value: 'source', label: 'Markdown', hint: 'raw markdown source' }
] as const

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function Brief(): ReactNode {
  const report = useStore((s) => s.report)
  const setView = useStore((s) => s.setView)
  const selectedIds = useBriefSelection((s) => s.ids)
  const selectedRepoId = useBriefSelection((s) => s.repoId)

  const [markdown, setMarkdown] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<ViewMode>('rendered')
  const [flash, setFlash] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const flashTimer = useRef<number | null>(null)

  const showFlash = useCallback((message: string, didCopy = false) => {
    setFlash(message)
    setCopied(didCopy)
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => {
      setFlash(null)
      setCopied(false)
    }, 2600)
  }, [])

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    },
    []
  )

  /**
   * The finding ids to generate from. `undefined` means "everything", which is
   * also the fallback when the committed selection belongs to a different repo
   * or has gone stale against the current report.
   */
  const selectionArg = useMemo<string[] | undefined>(() => {
    if (!report || selectedIds === null || selectedRepoId !== report.repo.id) return undefined
    const present = new Set(report.findings.map((f) => f.id))
    const kept = selectedIds.filter((id) => present.has(id))
    return kept.length > 0 ? kept : undefined
  }, [report, selectedIds, selectedRepoId])

  // Regenerates whenever the report or the selection changes. The cancelled
  // flag stops an older, slower response from overwriting a newer one.
  useEffect(() => {
    if (!report) {
      setMarkdown('')
      setGenerating(false)
      setError(null)
      return
    }
    let cancelled = false
    setGenerating(true)
    setError(null)
    window.vde.brief
      .generate(report.repo.id, selectionArg)
      .then((md) => {
        if (!cancelled) setMarkdown(md)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setMarkdown('')
          setError(errorMessage(e))
        }
      })
      .finally(() => {
        if (!cancelled) setGenerating(false)
      })
    return () => {
      cancelled = true
    }
  }, [report, selectionArg])

  const repoId = report?.repo.id ?? null

  const copy = useCallback((): void => {
    if (markdown === '') return
    window.vde.brief
      .copy(markdown)
      .then(() => showFlash('Copied to clipboard', true))
      .catch((e: unknown) => showFlash(`Copy failed — ${errorMessage(e)}`))
  }, [markdown, showFlash])

  const save = useCallback(() => {
    if (markdown === '' || !repoId) return
    window.vde.brief
      .save(repoId, markdown)
      .then((path) => {
        // null means the save dialog was dismissed — not an event worth a toast.
        if (path) showFlash(`Saved to ${path}`)
      })
      .catch((e: unknown) => showFlash(`Save failed — ${errorMessage(e)}`))
  }, [markdown, repoId, showFlash])

  // The "Copy Remediation Brief" menu item (⇧⌘C) only switches the view in
  // App.tsx, which is all it can do from there — the brief text lives here. When
  // this screen is already open the shortcut copies for real.
  useEffect(() => window.vdeMenu.onAction((a) => {
    if (a === 'copy-brief') copy()
  }), [copy])

  // App.tsx owns the empty, loading and error states.
  if (!report) return null

  const total = report.findings.length
  const included = selectionArg?.length ?? total
  const lineCount = markdown === '' ? 0 : markdown.split('\n').length
  const ready = markdown !== '' && !generating

  return (
    <div className="flex flex-col">
      <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3 pb-4">
        <div className="min-w-0">
          <h2 className="text-[13px] font-medium" style={{ color: 'var(--ink-primary)' }}>
            Remediation brief
          </h2>
          <p className="mt-1 max-w-[74ch] text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
            Paste this into your coding agent — it names the files, quotes the evidence, and states
            the change to make.
          </p>
          <p
            className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]"
            style={{ color: 'var(--ink-muted)' }}
          >
            <span>
              {total === 0
                ? 'No findings to include — every signal is inside its threshold'
                : `Includes ${included} of ${total} findings`}
            </span>
            <Dot />
            <span>analysed {relativeTime(report.generatedAt)}</span>
            {ready ? (
              <>
                <Dot />
                <span className="tnum">
                  {plain(lineCount)} lines, {plain(markdown.length)} characters
                </span>
              </>
            ) : null}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            {total > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                icon={SlidersHorizontal}
                onClick={() => setView('findings')}
              >
                Change selection
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" icon={Download} disabled={!ready} onClick={save}>
              Save as .md
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={copied ? Check : Copy}
              disabled={!ready}
              onClick={copy}
            >
              Copy to clipboard
            </Button>
          </div>

          {/* Engineers want to see the exact bytes they are copying. */}
          <Segmented label="Brief view" options={MODES} value={mode} onChange={setMode} />
        </div>
      </header>

      <p
        role="status"
        aria-live="polite"
        className="min-h-4 pb-2 text-[11px]"
        style={{ color: 'var(--ink-muted)' }}
      >
        {flash ?? ''}
      </p>

      {generating ? (
        <div className="flex items-center justify-center py-16">
          <span
            className="flex items-center gap-2 text-[12px]"
            style={{ color: 'var(--ink-muted)' }}
          >
            <Spinner size={14} />
            Generating brief…
          </span>
        </div>
      ) : error ? (
        <div
          role="alert"
          className="max-w-[72ch] rounded-lg border p-4"
          style={{
            borderColor: 'var(--status-critical)',
            background: 'var(--status-critical-wash)'
          }}
        >
          <p className="text-[12.5px] font-medium" style={{ color: 'var(--ink-primary)' }}>
            The brief could not be generated.
          </p>
          <p
            className="mt-1.5 font-mono text-[11.5px] leading-[1.6]"
            style={{ color: 'var(--ink-secondary)' }}
            data-selectable
          >
            {error}
          </p>
        </div>
      ) : markdown === '' ? (
        <p className="text-[12px]" style={{ color: 'var(--ink-muted)' }}>
          The brief came back empty.
        </p>
      ) : mode === 'rendered' ? (
        <div className="card max-w-[86ch] px-6 py-5">
          <Markdown source={markdown} />
        </div>
      ) : (
        <div
          className="max-w-[110ch] overflow-hidden rounded-lg"
          style={{ background: 'var(--surface-inset)', border: '1px solid var(--hairline)' }}
        >
          <div
            className="flex items-center justify-between border-b px-3 py-1.5"
            style={{ borderColor: 'var(--hairline)' }}
          >
            <span
              className="font-mono text-[10px] tracking-[0.06em] uppercase"
              style={{ color: 'var(--ink-faint)' }}
            >
              brief.md
            </span>
            <span className="tnum text-[10px]" style={{ color: 'var(--ink-faint)' }}>
              {plain(lineCount)} lines
            </span>
          </div>
          <pre
            className="overflow-x-auto px-3 py-3 font-mono text-[11.5px] leading-[1.65] break-words whitespace-pre-wrap"
            style={{ color: 'var(--ink-secondary)' }}
            data-selectable
          >
            {markdown}
          </pre>
        </div>
      )}
    </div>
  )
}

function Dot(): ReactNode {
  return (
    <span aria-hidden="true" style={{ color: 'var(--ink-faint)' }}>
      ·
    </span>
  )
}
