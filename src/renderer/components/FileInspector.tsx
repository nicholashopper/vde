import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { ExternalLink, File as FileIcon, Folder } from 'lucide-react'
import type { FileFlag, FileNode } from '../../shared/types'
import { foldToTopN, seriesScale, SERIES_VARS } from '../lib/colors'
import { bytes as fmtBytes, compact, percent, plain, relativeTime } from '../lib/format'
import { Legend, TableView, TooltipProvider, useTooltip } from './charts/primitives'
import { riskBinColor } from './charts/Treemap'

/**
 * The Map's right-hand panel: everything VDE knows about one node.
 *
 * A file gets its measurements, its flags with an explanation of what each one
 * actually means, and a decomposition of its risk score. A directory gets
 * aggregates instead, because "what is in here and what is it made of" is the
 * only useful question to ask of a folder.
 */

// ---------------------------------------------------------------------------
// Flag vocabulary
// ---------------------------------------------------------------------------

/**
 * One line per flag, matching the analyzer's thresholds exactly
 * (analyzer/signals/tree.ts). A badge that does not say what it means is
 * decoration.
 */
const FLAG_COPY: Record<FileFlag, { label: string; explain: string }> = {
  'god-file': {
    label: 'God file',
    explain: 'Over 800 lines — more than a reviewer, or a context window, holds in one pass.'
  },
  'write-once': {
    label: 'Write-once',
    explain: 'Committed exactly once, more than 14 days ago, and never revisited since.'
  },
  'high-rework': {
    label: 'High rework',
    explain: 'At least half as many lines deleted as added, over 200 added lines: rewritten, not improved.'
  },
  stale: {
    label: 'Stale',
    explain: 'No commit has touched this file in over 180 days.'
  },
  'sibling-sprawl': {
    label: 'Sibling sprawl',
    explain: 'One of three or more files whose names differ only by a version, date or qualifier.'
  },
  generated: {
    label: 'Generated',
    explain: 'Matches a generated-file pattern, so it is damped in scores and nobody should hand-edit it.'
  },
  binary: {
    label: 'Binary',
    explain: 'Not text. VDE can size it but cannot read inside it.'
  },
  vendored: {
    label: 'Vendored',
    explain: 'Third-party code committed into the tree. Not yours to fix.'
  }
}

// ---------------------------------------------------------------------------
// Risk decomposition
//
// Mirrors the analyzer's five-term risk model (analyzer/signals/tree.ts) so the
// panel can say *why* a score is what it is. The authoritative number is always
// `node.risk` from the report — what is modelled here is the SHARE each term
// contributes, which is invariant to the analyzer's damping factor and to
// rounding, so the two can never contradict each other.
// ---------------------------------------------------------------------------

const W_SIZE = 0.28
const W_REWORK = 0.22
const W_CHURN = 0.18
const W_COMPLEXITY = 0.17
const W_STALE = 0.15
const REWORK_MIN_ADDED = 200
const STALE_DAYS = 180

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function logNorm(x: number, scale: number, cap: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0
  return clamp01(Math.log2(1 + x / scale) / Math.log2(1 + cap / scale))
}

interface RiskTerm {
  key: string
  label: string
  /** 0–1 sub-score before weighting. */
  score: number
  weight: number
  /** What the number is, in words. */
  evidence: string
}

function riskTerms(node: FileNode): RiskTerm[] {
  const added = Math.max(0, node.addedLines)
  const deleted = Math.max(0, node.deletedLines)
  const rework = clamp01(added > 0 ? deleted / added : 0) * clamp01(added / REWORK_MIN_ADDED)
  // The analyzer weights the file's WORST function; the report carries the total
  // and the count, so the panel uses the mean per function as its stand-in.
  const meanComplexity =
    node.complexity !== null && node.functions !== null && node.functions > 0
      ? node.complexity / node.functions
      : 0

  return [
    {
      key: 'size',
      label: 'Size',
      score: logNorm(node.lines, 80, 1600),
      weight: W_SIZE,
      evidence: `${plain(node.lines)} lines`
    },
    {
      key: 'rework',
      label: 'Rework',
      score: rework,
      weight: W_REWORK,
      evidence: `${plain(added)} added / ${plain(deleted)} deleted`
    },
    {
      key: 'churn',
      label: 'Churn',
      score: logNorm(node.commits, 3, 60),
      weight: W_CHURN,
      evidence: `${plain(node.commits)} ${node.commits === 1 ? 'commit' : 'commits'}`
    },
    {
      key: 'complexity',
      label: 'Complexity',
      score: logNorm(meanComplexity, 5, 40),
      weight: W_COMPLEXITY,
      evidence:
        node.complexity === null
          ? 'not parsed'
          : `mean cc ${meanComplexity.toFixed(1)} over ${plain(node.functions ?? 0)} functions`
    },
    {
      key: 'stale',
      label: 'Staleness',
      score: clamp01(node.ageDays / STALE_DAYS),
      weight: W_STALE,
      evidence: `${plain(node.ageDays)} days since the last commit`
    }
  ]
}

function riskBand(risk: number): string {
  if (risk < 0.2) return 'quiet'
  if (risk < 0.4) return 'ordinary'
  if (risk < 0.6) return 'elevated'
  if (risk < 0.8) return 'high'
  return 'the top of the scale'
}

// ---------------------------------------------------------------------------
// Directory aggregates
// ---------------------------------------------------------------------------

interface DirAgg {
  files: number
  dirs: number
  lines: number
  bytes: number
  commits: number
  maxRisk: number
  meanRisk: number
  languages: Array<{ language: string; files: number; lines: number }>
  flags: Array<{ flag: FileFlag; count: number }>
  worst: FileNode | null
  lastModified: string | null
}

function aggregate(node: FileNode): DirAgg {
  const langs = new Map<string, { language: string; files: number; lines: number }>()
  const flags = new Map<FileFlag, number>()
  let files = 0
  let dirs = 0
  let lines = 0
  let byteTotal = 0
  let commits = 0
  let riskSum = 0
  let maxRisk = 0
  let worst: FileNode | null = null
  let lastMs = 0
  let lastIso: string | null = null

  const visit = (n: FileNode): void => {
    if (n.type === 'directory') {
      if (n !== node) dirs += 1
      for (const child of n.children ?? []) visit(child)
      return
    }
    const risk = Number.isFinite(n.risk) ? n.risk : 0
    files += 1
    lines += Math.max(0, n.lines)
    byteTotal += Math.max(0, n.bytes)
    commits += Math.max(0, n.commits)
    riskSum += risk
    if (risk > maxRisk) maxRisk = risk
    if (worst === null || risk > worst.risk) worst = n
    const key = n.language ?? 'Unknown'
    const row = langs.get(key)
    if (row) {
      row.files += 1
      row.lines += Math.max(0, n.lines)
    } else {
      langs.set(key, { language: key, files: 1, lines: Math.max(0, n.lines) })
    }
    for (const flag of n.flags) flags.set(flag, (flags.get(flag) ?? 0) + 1)
    const ms = Date.parse(n.lastModified)
    if (Number.isFinite(ms) && ms > lastMs) {
      lastMs = ms
      lastIso = n.lastModified
    }
  }
  visit(node)

  return {
    files,
    dirs,
    lines,
    bytes: byteTotal,
    commits,
    maxRisk,
    meanRisk: files > 0 ? riskSum / files : 0,
    languages: [...langs.values()].sort((a, b) => b.lines - a.lines || a.language.localeCompare(b.language)),
    flags: [...flags.entries()]
      .map(([flag, count]) => ({ flag, count }))
      .sort((a, b) => b.count - a.count || a.flag.localeCompare(b.flag)),
    worst,
    lastModified: lastIso
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface FileInspectorProps {
  /** The selected node, or null when nothing is selected. */
  node: FileNode | null
  /** Active repo id, needed for the Reveal action. Null disables it. */
  repoId: string | null
}

export function FileInspector({ node, repoId }: FileInspectorProps): ReactNode {
  const [revealError, setRevealError] = useState<string | null>(null)

  const reveal = useCallback(() => {
    if (!repoId || !node || node.path === '') return
    setRevealError(null)
    void window.vde.app.revealFile(repoId, node.path).catch((e: unknown) => {
      setRevealError(e instanceof Error ? e.message : String(e))
    })
  }, [node, repoId])

  if (!node) {
    return (
      <aside
        className="card flex h-full flex-col items-center justify-center px-6 text-center"
        aria-label="File inspector"
      >
        <p className="text-[12px]" style={{ color: 'var(--ink-muted)' }}>
          Select a tile to inspect it.
        </p>
        <p className="mt-1 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
          Click a file for its history and flags, a directory to zoom in.
        </p>
      </aside>
    )
  }

  const isDir = node.type === 'directory'
  const displayPath = node.path === '' ? '/' : node.path

  return (
    <aside className="card flex h-full min-h-0 flex-col" aria-label="File inspector">
      <header className="border-b px-3.5 pt-3 pb-2.5" style={{ borderColor: 'var(--hairline)' }}>
        <div className="flex items-start gap-2">
          {isDir ? (
            <Folder aria-hidden="true" size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
          ) : (
            <FileIcon aria-hidden="true" size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
          )}
          <div className="min-w-0 flex-1">
            <h2
              className="truncate text-[13px] font-medium"
              style={{ color: 'var(--ink-primary)' }}
              title={displayPath}
            >
              {node.name === '' ? '/' : node.name}
            </h2>
            <p
              data-selectable
              className="mt-0.5 font-mono text-[10px] leading-4 break-all"
              style={{ color: 'var(--ink-muted)' }}
            >
              {displayPath}
            </p>
          </div>
          {node.path !== '' ? (
            <button
              type="button"
              onClick={reveal}
              disabled={!repoId}
              title="Reveal in file manager"
              aria-label={`Reveal ${displayPath} in the file manager`}
              className="mt-0.5 flex min-h-6 shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] disabled:opacity-40"
              style={{ background: 'var(--surface-3)', color: 'var(--ink-secondary)' }}
            >
              <ExternalLink aria-hidden="true" size={11} />
              Reveal
            </button>
          ) : null}
        </div>
        {revealError ? (
          <p className="mt-1.5 text-[10px]" style={{ color: 'var(--status-serious)' }}>
            ⚠ Could not reveal this file: {revealError}
          </p>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-3 pb-4">
        {isDir ? <DirectoryBody node={node} /> : <FileBody node={node} />}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// File body
// ---------------------------------------------------------------------------

function FileBody({ node }: { node: FileNode }): ReactNode {
  const terms = useMemo(() => riskTerms(node), [node])
  const modelled = terms.reduce((sum, t) => sum + t.score * t.weight, 0)
  const ranked = [...terms].sort((a, b) => b.score * b.weight - a.score * a.weight)
  const lead = ranked.filter((t) => t.score * t.weight > 0.02).slice(0, 2)
  const damped = node.flags.some((f) => f === 'generated' || f === 'vendored' || f === 'binary')

  return (
    <>
      <Facts
        rows={[
          ['Language', node.language ?? 'Unknown'],
          ['Lines', plain(node.lines)],
          ['On disk', fmtBytes(node.bytes)],
          ['Commits', plain(node.commits)],
          ['Authors', plain(node.authors)],
          ['Last change', relativeTime(node.lastModified)],
          ['Age', `${plain(node.ageDays)} d`],
          ['Added', `+${compact(node.addedLines)}`],
          ['Deleted', `−${compact(node.deletedLines)}`],
          ['Rework', `${node.reworkRatio.toFixed(2)} del/add`],
          ...(node.complexity !== null ? [['Complexity', plain(node.complexity)] as [string, string]] : []),
          ...(node.functions !== null ? [['Functions', plain(node.functions)] as [string, string]] : [])
        ]}
      />

      <Section title="Risk">
        <div className="flex items-baseline gap-2">
          <span
            aria-hidden="true"
            className="inline-block size-3 shrink-0 translate-y-[1px] rounded-[3px]"
            style={{ background: riskBinColor(node.risk) }}
          />
          <span className="figure text-[26px] leading-none" style={{ color: 'var(--ink-primary)' }}>
            {node.risk.toFixed(2)}
          </span>
          <span className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
            of 1.00 · {riskBand(node.risk)}
          </span>
        </div>
        <p className="mt-2 text-[11px] leading-[1.55]" style={{ color: 'var(--ink-secondary)' }}>
          {lead.length === 0
            ? 'Nothing in this file registers on any of the five risk terms: it is small, unchurned, simple and recently touched.'
            : `Mostly ${lead.map((t) => t.label.toLowerCase()).join(' and ')} — ` +
              lead.map((t) => t.evidence).join(', ') +
              '.'}
          {damped
            ? ' The score is damped because this file is generated, vendored or binary: nobody wrote it by hand.'
            : ''}
        </p>
        <ul className="mt-2.5 space-y-1.5" role="list">
          {ranked.map((term) => {
            const share = modelled > 0 ? (term.score * term.weight) / modelled : 0
            return (
              <li key={term.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px]" style={{ color: 'var(--ink-secondary)' }}>
                    {term.label}
                  </span>
                  <span className="tnum text-[10px]" style={{ color: 'var(--ink-faint)' }}>
                    {term.evidence}
                  </span>
                </div>
                <div
                  className="mt-1 h-1.5 w-full overflow-hidden rounded-[2px]"
                  style={{ background: 'var(--surface-3)' }}
                  role="img"
                  aria-label={`${term.label}: ${percent(share * 100, 0)} of the modelled score`}
                >
                  <div
                    className="h-full rounded-[2px]"
                    style={{ width: `${Math.max(share * 100, share > 0 ? 1.5 : 0)}%`, background: SERIES_VARS[0] }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
        <p className="mt-2 text-[10px] leading-[1.5]" style={{ color: 'var(--ink-faint)' }}>
          Bars are each term’s share of the modelled score, using the analyzer’s weights (size 28%,
          rework 22%, churn 18%, complexity 17%, staleness 15%). The number above is the analyzer’s.
        </p>
      </Section>

      <Section title={`Flags (${node.flags.length})`}>
        {node.flags.length === 0 ? (
          <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
            No flags. Nothing about this file matched a known pathology.
          </p>
        ) : (
          <ul className="space-y-2" role="list">
            {node.flags.map((flag) => {
              const copy = FLAG_COPY[flag]
              return (
                <li key={flag}>
                  <span
                    className="inline-block rounded-[4px] px-1.5 py-0.5 text-[10px] font-medium"
                    style={{
                      background: 'var(--surface-3)',
                      color: 'var(--ink-primary)',
                      border: '1px solid var(--hairline-strong)'
                    }}
                  >
                    {copy.label}
                  </span>
                  <p className="mt-1 text-[11px] leading-[1.5]" style={{ color: 'var(--ink-muted)' }}>
                    {copy.explain}
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Directory body
// ---------------------------------------------------------------------------

function DirectoryBody({ node }: { node: FileNode }): ReactNode {
  const agg = useMemo(() => aggregate(node), [node])

  return (
    <>
      <Facts
        rows={[
          ['Files', plain(agg.files)],
          ['Subdirectories', plain(agg.dirs)],
          ['Lines', plain(agg.lines)],
          ['On disk', fmtBytes(agg.bytes)],
          ['Commits', plain(agg.commits)],
          ['Languages', plain(agg.languages.length)],
          ['Mean risk', agg.meanRisk.toFixed(2)],
          ['Highest risk', agg.maxRisk.toFixed(2)],
          ...(agg.lastModified !== null
            ? [['Last change', relativeTime(agg.lastModified)] as [string, string]]
            : [])
        ]}
      />

      {agg.worst ? (
        <Section title="Riskiest file here">
          <p className="font-mono text-[11px] break-all" style={{ color: 'var(--ink-secondary)' }}>
            {agg.worst.path}
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
            <span
              aria-hidden="true"
              className="inline-block size-2 shrink-0 rounded-[2px]"
              style={{ background: riskBinColor(agg.worst.risk) }}
            />
            risk {agg.worst.risk.toFixed(2)} · {plain(agg.worst.lines)} lines ·{' '}
            {plain(agg.worst.commits)} commits
          </p>
        </Section>
      ) : null}

      <Section title="Language mix">
        <LanguageMix languages={agg.languages} totalLines={agg.lines} />
      </Section>

      {agg.flags.length > 0 ? (
        <Section title="Flagged files inside">
          <ul className="flex flex-wrap gap-1.5" role="list">
            {agg.flags.map(({ flag, count }) => (
              <li key={flag}>
                <span
                  title={FLAG_COPY[flag].explain}
                  className="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px]"
                  style={{
                    background: 'var(--surface-3)',
                    color: 'var(--ink-secondary)',
                    border: '1px solid var(--hairline-strong)'
                  }}
                >
                  {FLAG_COPY[flag].label}
                  <span className="tnum" style={{ color: 'var(--ink-primary)' }}>
                    {compact(count)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  )
}

/**
 * The language mix as one stacked bar. Folded to the top seven plus a grey
 * "Other" — there is no eighth hue to reach for — with 2px surface gaps between
 * the fills rather than borders around them.
 */
function LanguageMix({
  languages,
  totalLines
}: {
  languages: Array<{ language: string; files: number; lines: number }>
  totalLines: number
}): ReactNode {
  const { top, scale } = useMemo(() => {
    const folded = foldToTopN(
      languages,
      (l) => l.language,
      (l) => l.lines
    )
    // The scale is built from the top names only, so every folded language — and
    // the "Other" bucket itself — resolves to the reserved grey. There is no
    // eighth hue to reach for.
    const names = folded.names.filter((n) => n !== 'Other')
    return { top: names, scale: seriesScale(names) }
  }, [languages])

  const segments = useMemo(() => {
    const byName = new Map<string, { name: string; lines: number; files: number }>()
    for (const name of top) byName.set(name, { name, lines: 0, files: 0 })
    for (const row of languages) {
      const key = top.includes(row.language) ? row.language : 'Other'
      const slot = byName.get(key) ?? { name: key, lines: 0, files: 0 }
      slot.lines += row.lines
      slot.files += row.files
      byName.set(key, slot)
    }
    return [...byName.values()].filter((s) => s.lines > 0 || s.files > 0)
  }, [languages, top])

  if (segments.length === 0 || totalLines <= 0) {
    return (
      <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
        No lines to break down here.
      </p>
    )
  }

  return (
    <TooltipProvider>
      <StackedLanguageBar segments={segments} scale={scale} totalLines={totalLines} />
    </TooltipProvider>
  )
}

function StackedLanguageBar({
  segments,
  scale,
  totalLines
}: {
  segments: Array<{ name: string; lines: number; files: number }>
  scale: (name: string) => string
  totalLines: number
}): ReactNode {
  const tooltip = useTooltip()
  const last = segments.length - 1

  return (
    <div className="relative">
      <div
        className="flex h-4 w-full gap-[2px]"
        role="img"
        aria-label={`Language mix by lines: ${segments
          .map((s) => `${s.name} ${percent((s.lines / totalLines) * 100, 0)}`)
          .join(', ')}`}
      >
        {segments.map((seg, i) => (
          <div
            key={seg.name}
            className="h-full min-w-[2px]"
            style={{
              flexGrow: Math.max(seg.lines, 1),
              flexBasis: 0,
              background: scale(seg.name),
              borderRadius:
                i === 0 && i === last ? '4px' : i === 0 ? '4px 0 0 4px' : i === last ? '0 4px 4px 0' : '0'
            }}
            title={`${seg.name}: ${plain(seg.lines)} lines`}
            onPointerEnter={(e) => {
              const host = e.currentTarget.parentElement?.parentElement
              const rect = host?.getBoundingClientRect()
              tooltip.show({
                x: rect ? e.clientX - rect.left : 0,
                y: rect ? e.clientY - rect.top : 0,
                title: seg.name,
                rows: [
                  { label: 'Lines', value: plain(seg.lines), color: scale(seg.name) },
                  { label: 'Share', value: percent((seg.lines / totalLines) * 100, 1) },
                  { label: 'Files', value: plain(seg.files) }
                ]
              })
            }}
            onPointerLeave={() => tooltip.hide()}
          />
        ))}
      </div>
      <Legend items={segments.map((s) => ({ name: s.name, color: scale(s.name) }))} />
      <div className="mt-1.5">
        <TableView
          columns={['Language', 'Files', 'Lines', 'Share']}
          rows={segments
            .slice()
            .sort((a, b) => b.lines - a.lines)
            .map((s) => [
              s.name,
              plain(s.files),
              plain(s.lines),
              percent((s.lines / totalLines) * 100, 1)
            ])}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="mt-4 border-t pt-3" style={{ borderColor: 'var(--hairline)' }}>
      <h3
        className="mb-1.5 text-[10px] tracking-[0.06em] uppercase"
        style={{ color: 'var(--ink-muted)' }}
      >
        {title}
      </h3>
      {children}
    </section>
  )
}

function Facts({ rows }: { rows: Array<[string, string]> }): ReactNode {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-2 border-b pb-1" style={{ borderColor: 'var(--hairline)' }}>
          <dt className="shrink-0 text-[10px]" style={{ color: 'var(--ink-muted)' }}>
            {label}
          </dt>
          <dd className="tnum truncate text-[11px]" style={{ color: 'var(--ink-primary)' }} title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export default FileInspector
