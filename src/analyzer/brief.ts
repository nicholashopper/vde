/**
 * The remediation brief.
 *
 * Every other part of VDE answers "what is wrong". This answers "now what",
 * and it is the artefact the product actually delivers: the user copies it
 * into their coding agent and the repository gets better.
 *
 * That framing decides everything about the format. This is NOT a report to a
 * human — it is a work order to a machine that will do exactly what it is told
 * and nothing it is not. So:
 *
 *   · findings are ordered worst-first, because an agent works top-down;
 *   · every instruction is imperative and names concrete paths;
 *   · every claim carries the number that produced it, so the agent can check
 *     whether the finding still holds before acting on it;
 *   · the ground rules are explicit about what NOT to do, because the failure
 *     modes here are all failures of over-eagerness.
 *
 * One ground rule is pointed. "Do not create new files to describe the work"
 * is the pathology VDE exists to detect, and a brief that provokes a fresh
 * `remediation-summary-final-2.md` has made the repository worse. It is stated
 * as a rule rather than left to taste.
 *
 * Output is deterministic: `generatedAt` comes from the report, never from the
 * clock, so the same report always renders byte-identical markdown. That is
 * what makes the brief diffable and the tests meaningful.
 */

import { SIGNALS } from '../shared/signals'
import type { Finding, HealthStatus, RepoReport, SignalUnit } from '../shared/types'

/**
 * Hard ceiling on the rendered brief. Agent context windows are finite and a
 * 4,000-file repository can raise findings listing thousands of paths; past
 * this point the brief stops being actionable and starts being another dump.
 */
const MAX_BRIEF_BYTES = 40 * 1024

/** Paths shown per finding before the list is summarised. */
const MAX_PATHS_PER_FINDING = 25

/** Character caps on repo-derived prose, applied before markdown escaping. */
const MAX_DETAIL_CHARS = 1200
const MAX_REMEDIATION_CHARS = 1200
const MAX_TITLE_CHARS = 160

const SEVERITY_RANK: Record<HealthStatus, number> = {
  critical: 3,
  serious: 2,
  warning: 1,
  good: 0
}

// ---------------------------------------------------------------------------
// Markdown safety
// ---------------------------------------------------------------------------

/**
 * Characters that can change a markdown document's structure rather than its
 * text. Escaped in everything that came out of the analysed repository —
 * commit subjects and filenames are attacker-adjacent input as far as this
 * renderer is concerned, and a stray backtick or `<script` in a path must not
 * be able to reshape the brief the user is about to hand to an agent.
 */
const MARKDOWN_SPECIALS = /[\\`*_[\]<>|]/g

/** Line-leading constructs: headings, quotes, list bullets, ordered items. */
const LEADING_BLOCK = /^(\s*)([#>+*-]|\d+[.)])/

/**
 * Flattens repo-derived text to a single safe inline run. Newlines are folded
 * because a finding's detail is rendered inside a paragraph, and a raw newline
 * followed by `## ` would forge a section.
 */
function inline(text: string, max: number): string {
  const flat = text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  const clipped = flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat
  return clipped.replace(MARKDOWN_SPECIALS, '\\$&').replace(LEADING_BLOCK, '$1\\$2')
}

/**
 * Wraps text in a fence long enough to contain it. Computing the fence width
 * from the content is the only way to make this safe for arbitrary input: a
 * path containing three backticks would otherwise close the block early and
 * spill repository content into the document structure.
 */
function fence(body: string, info = 'text'): string {
  let longest = 0
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}${info}\n${body}\n${ticks}`
}

/** Neutralises anything in a path that could terminate a fenced block. */
function safePath(path: string): string {
  return path.replace(/[\r\n]+/g, ' ')
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

function utf8Bytes(text: string): number {
  return encoder.encode(text).length
}

/** Thousands separators without depending on the host's ICU data. */
function num(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value)
  const sign = rounded < 0 ? '-' : ''
  const digits = Math.abs(rounded).toString()
  let out = ''
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i] ?? ''
  }
  return sign + out
}

function round(value: number, places: number): string {
  return Number.isFinite(value) ? value.toFixed(places) : '0'
}

/**
 * Formats a finding's metric. The metric's own unit is used rather than the
 * signal's, because a signal reported in percent often raises findings counted
 * in files.
 */
function formatMetric(value: number, unit: SignalUnit): string {
  switch (unit) {
    case 'percent':
      return `${round(value, 1)}%`
    case 'ratio':
      return `${round(value, 2)}×`
    case 'days':
      return `${round(value, 1)} days`
    case 'lines':
      return `${num(value)} lines`
    case 'files':
      return `${num(value)} files`
    default:
      return num(value)
  }
}

/** YYYY-MM-DD in UTC, taken from the report so output stays deterministic. */
function isoDate(timestamp: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(timestamp)) return timestamp.slice(0, 10)
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return 'undated'
  return parsed.toISOString().slice(0, 10)
}

/** Full ISO-8601 instant, normalised. Falls back to the raw string. */
function isoInstant(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return inline(timestamp, 40)
  return parsed.toISOString()
}

function daysBetween(from: string, to: string): number | null {
  const a = new Date(from).getTime()
  const b = new Date(to).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderContext(report: RepoReport): string {
  const { facts, repo } = report
  const parts: string[] = []

  // Sentence 1 — the shape of the tree.
  const languages = [...facts.languages]
    .sort((a, b) => b.lines - a.lines || (a.language < b.language ? -1 : 1))
    .slice(0, 3)
  const languageTotal = facts.languages.reduce((sum, l) => sum + l.lines, 0)
  const languageText =
    languages.length === 0
      ? 'no language VDE recognises'
      : languages
          .map((l) => {
            const share = languageTotal > 0 ? Math.round((l.lines / languageTotal) * 100) : 0
            return `${inline(l.language, 40)} ${share}%`
          })
          .join(', ')
  parts.push(
    `\`${inline(repo.name, 80)}\` holds ${num(facts.fileCount)} ${plural(facts.fileCount, 'file')} ` +
      `and ${num(facts.totalLines)} ${plural(facts.totalLines, 'line')} across ` +
      `${num(facts.dirCount)} ${plural(facts.dirCount, 'directory', 'directories')} ` +
      `(max depth ${num(facts.maxDepth)}) — ${languageText}.`
  )

  // Sentence 2 — the shape of the history.
  const ageDays = daysBetween(repo.firstCommitAt, repo.lastCommitAt)
  const span =
    ageDays === null
      ? ''
      : ` over ${num(ageDays)} ${plural(ageDays, 'day')} (${isoDate(repo.firstCommitAt)} to ${isoDate(repo.lastCommitAt)})`
  parts.push(
    `Its history runs to ${num(facts.commitCount)} ${plural(facts.commitCount, 'commit')}${span}, ` +
      `by ${num(facts.contributors)} ${plural(facts.contributors, 'contributor')}.`
  )

  // Sentence 3 — the split between code, tests and prose, which is the single
  // most diagnostic ratio for an agent-written repository.
  parts.push(
    `Of those lines, ${num(facts.sourceLines)} are source, ${num(facts.testLines)} are tests ` +
      `and ${num(facts.docLines)} are documentation.`
  )

  return `## Context\n\n${parts.join(' ')}\n`
}

function renderFinding(finding: Finding, index: number): string {
  const signal = SIGNALS[finding.signalId]
  const lines: string[] = []

  lines.push(`### ${index}. ${inline(finding.title, MAX_TITLE_CHARS)}  \`${finding.severity}\``)
  lines.push('')

  // Naming the signal lets the agent cross-check against the dashboard tile,
  // and `measures` states in one clause what the number actually counts.
  const metric = `${inline(finding.metric.label, 80)} **${formatMetric(finding.metric.value, finding.metric.unit)}**`
  lines.push(`Signal: **${signal.label}** — ${signal.measures} · ${metric}`)
  lines.push('')

  const detail = inline(finding.detail, MAX_DETAIL_CHARS)
  if (detail.length > 0) {
    lines.push(detail)
    lines.push('')
  }

  if (finding.paths.length > 0) {
    const shown = finding.paths.slice(0, MAX_PATHS_PER_FINDING).map(safePath)
    const hidden = finding.paths.length - shown.length
    if (hidden > 0) shown.push(`…and ${num(hidden)} more`)
    lines.push(`**Files** (${num(finding.paths.length)}):`)
    lines.push('')
    lines.push(fence(shown.join('\n')))
    lines.push('')
  }

  const remediation = inline(finding.remediation, MAX_REMEDIATION_CHARS)
  lines.push(`**Do this:** ${remediation.length > 0 ? remediation : 'No remediation was recorded for this finding. Investigate before changing anything.'}`)
  lines.push('')

  return lines.join('\n')
}

/**
 * The fixed preamble. Every rule here exists because its absence produces a
 * specific, observed failure when a brief is handed to an agent.
 */
const GROUND_RULES = `## Ground rules for the fix

1. **Work one finding at a time, in the order above.** Finish and verify one before
   opening the next. Do not batch them, and do not start by "surveying" the whole
   list — the findings are ordered by severity for a reason.
2. **Run the project's test suite between findings.** If it does not pass before you
   start, stop and say so; do not fix findings on top of a red baseline.
3. **Do not delete anything under version control until you have confirmed it is
   unreferenced.** Search the repository for the filename, its import path, and its
   exported symbols, and check the build, CI and packaging configuration. If a file
   is referenced, or you cannot tell, leave it and say why.
4. **Prefer moving and merging over deleting.** Consolidating near-duplicate files
   into one canonical file is a fix; removing the extras and hoping is not. Preserve
   any content that exists only in the copy you are retiring.
5. **Do not create new files to describe the work.** No summary documents, no plan
   files, no \`notes-final.md\`. Explain what you did in the commit message and in your
   reply. Creating a document about the cleanup is the exact behaviour that produced
   several of the findings above.
6. **One commit per finding**, with a subject that names what changed and why.
7. **If a remediation is wrong for this codebase, skip it and say so.** Do not
   substitute a different change to fill the gap, and do not refactor anything the
   brief did not ask you to touch.
`

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Renders the markdown remediation brief.
 *
 * @param report      The report to render. `generatedAt` is the only clock.
 * @param findingIds  Optional allowlist; when given, only these findings are
 *                    rendered, in the report's own severity order.
 */
export function generateBrief(report: RepoReport, findingIds?: string[]): string {
  const requested = findingIds === undefined ? null : new Set(findingIds)
  const selected =
    requested === null ? [...report.findings] : report.findings.filter((f) => requested.has(f.id))

  // Stable sort by severity: ties keep the analyzer's own ranking, which is
  // already ordered by how much each finding contributed to its signal.
  selected.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])

  const repoName = inline(report.repo.name, 80)
  const head =
    `# VDE remediation brief — ${repoName}\n\n` +
    `Generated ${isoInstant(report.generatedAt)} · baseline ${inline(report.baseline.label, 120)} · ` +
    `${num(selected.length)} ${plural(selected.length, 'finding')}\n\n` +
    renderContext(report) +
    `\n## What is wrong, worst first\n\n`

  if (selected.length === 0) {
    const reason =
      requested !== null && report.findings.length > 0
        ? 'None of the selected findings are present in this report. Nothing to do.'
        : 'VDE raised no findings above its reporting threshold for this repository. Nothing to do.'
    return `${head}${reason}\n\n${GROUND_RULES}`
  }

  // Reserve room for the parts that must always survive truncation. A brief
  // without its ground rules is worse than a short one: the rules are what
  // stop the agent doing damage.
  const noticeTemplate = (n: number): string =>
    `> **${num(n)} further ${plural(n, 'finding')} omitted** to keep this brief inside ${MAX_BRIEF_BYTES / 1024} KB. ` +
    `Fix these first, re-run VDE, and export again.\n\n`
  const reserved = utf8Bytes(head) + utf8Bytes(GROUND_RULES) + utf8Bytes(noticeTemplate(9999))

  const body: string[] = []
  let used = reserved
  let rendered = 0
  for (const finding of selected) {
    const section = renderFinding(finding, rendered + 1)
    // +1 for the newline `join` will put between sections.
    const cost = utf8Bytes(section) + 1
    // Always emit the first finding, however large: a brief that lists nothing
    // has failed at its only job, and each section is independently capped.
    if (rendered > 0 && used + cost > MAX_BRIEF_BYTES) break
    body.push(section)
    used += cost
    rendered += 1
  }

  const omitted = selected.length - rendered
  const notice = omitted > 0 ? noticeTemplate(omitted) : ''
  return `${head}${body.join('\n')}\n${notice}${GROUND_RULES}`
}

/**
 * Filename for the exported brief, e.g. `vde-brief-apx-response-2026-07-26.md`.
 * Dated from the report, not the clock, so re-exporting the same report
 * overwrites rather than accumulating — the pathology, again.
 */
export function briefFilename(report: RepoReport): string {
  const slug =
    report.repo.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'repo'
  return `vde-brief-${slug}-${isoDate(report.generatedAt)}.md`
}

/** Exposed for tests. */
export const __testing = { inline, fence, num, formatMetric, MAX_BRIEF_BYTES, GROUND_RULES }
