/**
 * The report — everything the renderer draws, assembled once.
 *
 * `RepoReport` is a single structured-clone payload crossing two process
 * boundaries, so this module has two obligations beyond correctness: it must
 * emit plain data only, and it must keep that data *small*. A 4,000-file
 * repository is comfortable; a 200,000-file monorepo would produce a file tree
 * of hundreds of megabytes, so the tree is pruned against an explicit budget and
 * the report says so in `warnings` rather than quietly lying about the shape of
 * the repository.
 *
 * The other judgement call here is the baseline. VDE's central claim is "here is
 * what changed", and a fabricated baseline would make that claim a lie. So a
 * baseline is only ever a snapshot that was actually computed and stored: when
 * nothing old enough exists, the report falls back to the earliest real snapshot
 * and says so in the label, and when no snapshot exists at all it reports no
 * deltas rather than differencing the current values against themselves.
 *
 * Time is anchored on HEAD's author timestamp rather than the wall clock, the
 * same anchor `pickSnapshotRevisions` uses. A repository whose last commit was a
 * year ago still has a meaningful "7 days before that", whereas wall-clock
 * arithmetic would resolve every window to HEAD and report that nothing ever
 * changes.
 */

import { basename } from 'node:path'

import { SIGNALS, SIGNAL_ORDER } from '../shared/signals'
import type {
  AnalysisPhase,
  BaselineKind,
  BaselineRef,
  CommitSummary,
  FileNode,
  LanguageStat,
  RepoRef,
  RepoReport,
  Settings,
  SignalDelta,
  SignalId,
  SignalValue,
  SnapshotFacts,
  SnapshotPoint,
  TimelineBucket
} from '../shared/types'
import { takeWarnings } from './content/parse'
import type { Db, SnapshotRow } from './db'
import { run } from './git/exec'
import { readHistory } from './git/log'
import { utcDate } from './git/tree'
import type { AnalysisContext, CommitRecord, History } from './model'
import { Cancelled } from './model'
import { runSignals } from './signals'
import { computeFileFlags, computeRisk } from './signals/tree'
import { buildContext, computeFacts, topLanguages } from './snapshots/compute'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

/** Contractual cap — see `RepoReport.commits`. */
const MAX_COMMITS = 500

/**
 * Ceiling on file nodes in the transferred tree. Beyond this the payload stops
 * being something a renderer can lay out and starts being a memory problem in
 * three processes at once.
 */
const MAX_TREE_FILES = 20_000

/** Ceiling on a single directory's children, so one flat dump cannot dominate. */
const MAX_DIR_CHILDREN = 1_500

/** Days a timeline may span before it degrades to commit-bearing days only. */
const MAX_TIMELINE_DAYS = 20_000

/** Distinct paths counted per day before `filesTouched` stops growing. */
const MAX_DAY_PATHS = 20_000

/**
 * Deadband on `SignalDelta.direction`, as a fraction of the signal's
 * displayMax. Snapshot values carry real jitter — a single commit lands, one
 * file is reclassified — and a strip that flags every 0.1% wobble as movement
 * teaches the user to ignore it.
 */
const DIRECTION_DEADBAND = 0.005

/** Language slices carried on each snapshot point. */
const SNAPSHOT_LANGUAGES = 8

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function baseOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

function isoAt(epochMs: number): string {
  const ms = Number.isFinite(epochMs) && epochMs > 0 ? epochMs : 0
  return new Date(ms).toISOString()
}

function round(value: number, places: number): number {
  if (!Number.isFinite(value)) return 0
  const f = 10 ** places
  return Math.round(value * f) / f
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Cancelled()
}

/**
 * Conventional-commit grammar, with the same closed type set that
 * signals/history.ts scores against.
 *
 * Deliberately duplicated rather than imported: the signal owns its definition
 * of hygiene and must be free to evolve it, whereas `CommitSummary.conventional`
 * is a display flag on a commit row. Keeping them textually identical today and
 * independent tomorrow is the right coupling; if they ever disagree, the tile is
 * the authority.
 */
const CONVENTIONAL =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\(([^()\r\n]{1,64})\))?(!)?: (.+)$/

// ---------------------------------------------------------------------------
// Repository identity
// ---------------------------------------------------------------------------

/**
 * Describes the repository from the history already in hand.
 *
 * `validateRepo` would recompute the commit count and extent with a second full
 * `git log` walk; on a large repository that is minutes of duplicated work for
 * numbers this function already has. The stored row supplies the two facts
 * history cannot know — when the user added the repo, and when it was last
 * scanned.
 */
async function resolveRepoRef(
  repoId: string,
  repoPath: string,
  history: History,
  db: Db,
  signal: AbortSignal | undefined,
  warn: (message: string) => void
): Promise<RepoRef> {
  const stored = db.getRepo(repoId)
  const head = history.commits[0]?.sha ?? ''

  let branch: string | null = null
  try {
    const raw = (await run(repoPath, ['symbolic-ref', '--short', 'HEAD'], { signal, timeoutMs: 30_000 })).trim()
    branch = raw.length > 0 ? raw : null
  } catch {
    // Detached HEAD. Not an error; the contract models it as a null branch.
    branch = stored?.branch ?? null
  }

  try {
    const shallow = (
      await run(repoPath, ['rev-parse', '--is-shallow-repository'], { signal, timeoutMs: 30_000 })
    ).trim()
    if (shallow === 'true') {
      warn(
        `${basename(repoPath)} is a shallow clone, so VDE can only see part of its history. ` +
          `Every history-derived signal reads better than the repository really is. ` +
          `Run "git fetch --unshallow" for a complete picture.`
      )
    }
  } catch {
    // Predates git 2.15, or the probe failed. Absence of proof, not proof of absence.
  }

  return {
    id: repoId,
    path: repoPath,
    name: stored?.name ?? basename(repoPath),
    head,
    branch,
    firstCommitAt: isoAt(history.firstAt),
    lastCommitAt: isoAt(history.lastAt),
    commitCount: history.commits.length,
    addedAt: stored?.addedAt ?? new Date().toISOString(),
    lastScanAt: stored?.lastScanAt ?? null
  }
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

interface ResolvedBaseline {
  ref: BaselineRef
  snapshot: SnapshotRow | null
}

const BASELINE_DAYS: Partial<Record<BaselineKind, number>> = { '7d': 7, '30d': 30, '90d': 90 }

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/**
 * Picks the stored snapshot a report is differenced against.
 *
 * Every branch here either returns a snapshot that genuinely exists or returns
 * none. There is no path that invents one, and no path that silently
 * substitutes a different kind of baseline without saying so in the label the
 * user reads at the top of the movers strip.
 */
function resolveBaseline(
  repoId: string,
  kind: BaselineKind,
  ref: string | undefined,
  headSha: string,
  anchorMs: number,
  db: Db,
  snapshots: readonly SnapshotRow[],
  warn: (message: string) => void
): ResolvedBaseline {
  // The HEAD snapshot is the report's own subject; differencing it against
  // itself would report zero movement for every signal.
  const usable = snapshots.filter((s) => s.commitSha !== headSha)
  const earliest = usable[0] ?? null

  const none = (label: string): ResolvedBaseline => ({
    ref: { kind, commitSha: null, date: null, label },
    snapshot: null
  })

  const found = (snapshot: SnapshotRow, label: string): ResolvedBaseline => ({
    ref: { kind, commitSha: snapshot.commitSha, date: snapshot.date, label },
    snapshot
  })

  if (kind === 'commit') {
    if (ref === undefined || ref.length === 0) {
      return none('no commit given')
    }
    const exact = db.getSnapshotByCommit(repoId, ref)
    if (exact === null) {
      warn(
        `No snapshot exists for commit ${shortSha(ref)}, so this report has no baseline. ` +
          `Snapshots are taken at the revisions VDE samples; pick one from the timeline, or re-scan.`
      )
      return none(`no snapshot at ${shortSha(ref)}`)
    }
    if (exact.commitSha === headSha) {
      return none(`${shortSha(ref)} is the current revision`)
    }
    return found(exact, `commit ${shortSha(exact.commitSha)} (${exact.date})`)
  }

  if (kind === 'first') {
    if (earliest === null) return none('no earlier snapshot yet')
    return found(earliest, `first snapshot (${earliest.date})`)
  }

  const days = BASELINE_DAYS[kind]
  if (days === undefined) {
    if (earliest === null) return none('no earlier snapshot yet')
    return found(earliest, `first snapshot (${earliest.date})`)
  }

  const cutoff = anchorMs - days * DAY_MS
  const atOrBefore = db.getSnapshotAtOrBefore(repoId, cutoff)
  if (atOrBefore !== null && atOrBefore.commitSha !== headSha) {
    return found(atOrBefore, `${days} days ago (${shortSha(atOrBefore.commitSha)})`)
  }

  // Nothing that old exists. Fall back to the oldest snapshot there is and say
  // so — an honest "as far back as we can see" beats a silent no-op.
  if (earliest === null) return none(`nothing older than ${days} days`)
  return found(
    earliest,
    `${earliest.date} — the earliest snapshot, less than ${days} days back`
  )
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

/**
 * Differences the current values against the baseline snapshot.
 *
 * A signal missing from the baseline's stored map (added to VDE after that
 * snapshot was taken) yields no delta at all. Treating an absent value as zero
 * would render every such signal as a dramatic regression on the first scan
 * after an upgrade.
 */
function computeDeltas(
  values: readonly SignalValue[],
  baseline: SnapshotRow | null
): SignalDelta[] {
  if (baseline === null) return []

  const deltas: SignalDelta[] = []
  const byId = new Map<SignalId, SignalValue>(values.map((v) => [v.id, v]))

  for (const id of SIGNAL_ORDER) {
    const current = byId.get(id)
    if (current === undefined) continue
    const before = baseline.signals[id]
    if (before === undefined || !Number.isFinite(before)) continue

    const def = SIGNALS[id]
    const absolute = current.value - before
    const deadband = def.displayMax * DIRECTION_DEADBAND

    deltas.push({
      id,
      current: current.value,
      baseline: before,
      absolute: round(absolute, 4),
      relative: before === 0 ? null : round(absolute / before, 4),
      direction: absolute > deadband ? 'worse' : absolute < -deadband ? 'better' : 'flat',
      magnitude: round(Math.abs(absolute) / (def.displayMax > 0 ? def.displayMax : 1), 6)
    })
  }

  return deltas
}

/** Worst-first by |magnitude|; the renderer decides how many to show. */
function rankMovers(deltas: readonly SignalDelta[]): SignalDelta[] {
  const panelRank = new Map<SignalId, number>(SIGNAL_ORDER.map((id, i) => [id, i]))
  return [...deltas].sort(
    (a, b) =>
      b.magnitude - a.magnitude ||
      Math.abs(b.absolute) - Math.abs(a.absolute) ||
      (panelRank.get(a.id) ?? 0) - (panelRank.get(b.id) ?? 0)
  )
}

// ---------------------------------------------------------------------------
// Snapshot points
// ---------------------------------------------------------------------------

function toSnapshotPoint(row: SnapshotRow): SnapshotPoint {
  const facts: SnapshotFacts = row.facts
  const languages: LanguageStat[] = Array.isArray(facts.languages)
    ? topLanguages(facts.languages, SNAPSHOT_LANGUAGES)
    : []
  return {
    date: row.date,
    commitSha: row.commitSha,
    signals: { ...row.signals },
    fileCount: facts.fileCount ?? 0,
    totalLines: facts.totalLines ?? 0,
    sourceLines: facts.sourceLines ?? 0,
    docLines: facts.docLines ?? 0,
    testLines: facts.testLines ?? 0,
    languages
  }
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

interface DayAccum {
  bucket: TimelineBucket
  authors: Set<string>
  paths: Set<string>
}

/**
 * Daily activity across the whole history.
 *
 * Emitted as a continuous run of days — including the empty ones — because a
 * gap is the interesting part: a chart drawn only from days that have commits
 * hides exactly the stalls `cadence` exists to detect.
 *
 * `History.commits` is sorted strictly by descending author time, so every
 * commit for a given day is contiguous. That lets each day's author and path
 * sets be released as soon as the day closes, which keeps memory flat on a
 * hundred-thousand-commit history instead of holding a set per day.
 */
function buildTimeline(history: History, megaThreshold: number): TimelineBucket[] {
  const byDay = new Map<string, TimelineBucket>()

  let open: DayAccum | null = null
  let openKey = ''

  const close = (): void => {
    if (open === null) return
    open.bucket.authors = open.authors.size
    open.bucket.filesTouched = open.paths.size
    byDay.set(openKey, open.bucket)
    open = null
  }

  for (const commit of history.commits) {
    const key = utcDate(commit.authoredAt)
    if (open === null || key !== openKey) {
      close()
      openKey = key
      const existing = byDay.get(key)
      open = {
        // A day can legitimately reopen if the history's ordering ever breaks
        // contiguity; merging into the existing bucket keeps the count right.
        bucket: existing ?? {
          date: key,
          commits: 0,
          insertions: 0,
          deletions: 0,
          filesTouched: 0,
          megaCommits: 0,
          authors: 0
        },
        authors: new Set<string>(),
        paths: new Set<string>()
      }
    }

    const day = open
    day.bucket.commits++
    day.authors.add(commit.authorEmail)
    if (!commit.isMerge && commit.files.length > megaThreshold) day.bucket.megaCommits++
    for (const change of commit.files) {
      day.bucket.insertions += change.insertions
      day.bucket.deletions += change.deletions
      if (day.paths.size < MAX_DAY_PATHS) day.paths.add(change.path)
    }
  }
  close()

  if (byDay.size === 0) return []

  const firstDay = Math.floor(history.firstAt / DAY_MS)
  const lastDay = Math.floor(history.lastAt / DAY_MS)
  const span = lastDay - firstDay + 1

  // A history spanning more days than this is either ancient or has a bogus
  // timestamp; emitting only populated days keeps the payload finite.
  if (!Number.isFinite(span) || span <= 0 || span > MAX_TIMELINE_DAYS) {
    return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  }

  const out: TimelineBucket[] = []
  for (let day = firstDay; day <= lastDay; day++) {
    const key = utcDate(day * DAY_MS)
    out.push(
      byDay.get(key) ?? {
        date: key,
        commits: 0,
        insertions: 0,
        deletions: 0,
        filesTouched: 0,
        megaCommits: 0,
        authors: 0
      }
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

function toCommitSummary(commit: CommitRecord, megaThreshold: number): CommitSummary {
  let insertions = 0
  let deletions = 0
  for (const change of commit.files) {
    insertions += change.insertions
    deletions += change.deletions
  }
  const subject = commit.subject.trim()
  return {
    sha: commit.sha,
    shortSha: shortSha(commit.sha),
    authoredAt: isoAt(commit.authoredAt),
    author: commit.authorName,
    subject,
    filesChanged: commit.files.length,
    insertions,
    deletions,
    isMega: !commit.isMerge && commit.files.length > megaThreshold,
    conventional: CONVENTIONAL.test(subject)
  }
}

// ---------------------------------------------------------------------------
// The file tree
// ---------------------------------------------------------------------------

function makeDirectory(path: string, name: string): FileNode {
  return {
    path,
    name,
    type: 'directory',
    children: [],
    lines: 0,
    bytes: 0,
    language: null,
    commits: 0,
    authors: 0,
    lastModified: '',
    ageDays: 0,
    addedLines: 0,
    deletedLines: 0,
    reworkRatio: 0,
    complexity: null,
    functions: null,
    risk: 0,
    flags: []
  }
}

interface Aggregate {
  files: number
  /** Read-only so a caller cannot mutate a leaf's own FileStats author set. */
  authors: ReadonlySet<string>
  lastAt: number
  /** Line-weighted risk, so a directory's colour reflects where its mass is. */
  riskWeight: number
  riskSum: number
}

const NO_AUTHORS: ReadonlySet<string> = new Set<string>()

/**
 * Builds the nested `FileNode` tree.
 *
 * Leaves carry real per-file measurements — the flags and the risk score come
 * from signals/tree.ts, so a badge on the Map can never disagree with the tile
 * that raised it. Directories carry rolled-up totals: sums for the additive
 * quantities, a union for authors, the newest child timestamp for age, and a
 * line-weighted mean for risk so a directory's colour follows the code that
 * actually sits in it rather than its emptiest corner.
 */
function buildFileTree(ctx: AnalysisContext, repoName: string): FileNode {
  const root = makeDirectory('', repoName)
  const directories = new Map<string, FileNode>([['', root]])

  const ensureDirectory = (path: string): FileNode => {
    const existing = directories.get(path)
    if (existing !== undefined) return existing
    const node = makeDirectory(path, baseOf(path))
    directories.set(path, node)
    const parent = ensureDirectory(dirOf(path))
    parent.children?.push(node)
    return node
  }

  for (const entry of ctx.tree) {
    if (entry.mode === '120000' || entry.mode === '160000') continue

    const blob = ctx.blobs.get(entry.sha)
    const stats = ctx.fileStats.get(entry.path)
    const added = stats?.added ?? 0
    const deleted = stats?.deleted ?? 0
    const lastAt = stats !== undefined && stats.lastAt > 0 ? stats.lastAt : ctx.now

    const node: FileNode = {
      path: entry.path,
      name: baseOf(entry.path),
      type: 'file',
      lines: blob?.lines ?? 0,
      bytes: blob?.bytes ?? (entry.size > 0 ? entry.size : 0),
      language: blob?.language ?? null,
      commits: stats?.commits ?? 0,
      authors: stats?.authors.size ?? 0,
      lastModified: isoAt(lastAt),
      ageDays: round(Math.max(0, (ctx.now - lastAt) / DAY_MS), 1),
      addedLines: added,
      deletedLines: deleted,
      reworkRatio: added > 0 ? round(deleted / added, 3) : 0,
      complexity: blob?.totalComplexity ?? null,
      functions: blob?.functions ?? null,
      risk: computeRisk(entry.path, ctx),
      flags: computeFileFlags(entry.path, ctx)
    }

    ensureDirectory(dirOf(entry.path)).children?.push(node)
  }

  aggregate(root, ctx)
  sortChildren(root)
  return root
}

function aggregate(node: FileNode, ctx: AnalysisContext): Aggregate {
  if (node.type === 'file') {
    const stats = ctx.fileStats.get(node.path)
    const weight = Math.max(1, node.lines)
    return {
      files: 1,
      authors: stats?.authors ?? NO_AUTHORS,
      lastAt: Date.parse(node.lastModified) || ctx.now,
      riskWeight: weight,
      riskSum: node.risk * weight
    }
  }

  const children = node.children ?? []
  // Always a fresh set: returning a child's own author set would let a
  // grandparent mutate a leaf's history aggregate.
  const authors = new Set<string>()
  let files = 0
  let lastAt = 0
  let riskWeight = 0
  let riskSum = 0
  let complexity: number | null = null
  let functions: number | null = null

  for (const child of children) {
    const sub = aggregate(child, ctx)
    files += sub.files
    for (const author of sub.authors) authors.add(author)
    if (sub.lastAt > lastAt) lastAt = sub.lastAt
    riskWeight += sub.riskWeight
    riskSum += sub.riskSum

    node.lines += child.lines
    node.bytes += child.bytes
    node.commits += child.commits
    node.addedLines += child.addedLines
    node.deletedLines += child.deletedLines
    if (child.complexity !== null) complexity = (complexity ?? 0) + child.complexity
    if (child.functions !== null) functions = (functions ?? 0) + child.functions
  }

  const at = lastAt > 0 ? lastAt : ctx.now
  node.authors = authors.size
  node.lastModified = isoAt(at)
  node.ageDays = round(Math.max(0, (ctx.now - at) / DAY_MS), 1)
  node.reworkRatio = node.addedLines > 0 ? round(node.deletedLines / node.addedLines, 3) : 0
  node.complexity = complexity
  node.functions = functions
  node.risk = riskWeight > 0 ? round(riskSum / riskWeight, 3) : 0

  return { files, authors, lastAt: at, riskWeight, riskSum }
}

/**
 * Directories first, then by line count descending, then by name.
 *
 * Size-descending rather than alphabetical because the primary consumer is a
 * treemap, and because it makes the pruning below keep the parts of the
 * repository that carry the most code.
 */
function sortChildren(node: FileNode): void {
  const children = node.children
  if (children === undefined) return
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return b.lines - a.lines || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  })
  for (const child of children) sortChildren(child)
}

function countFileNodes(node: FileNode): number {
  if (node.type === 'file') return 1
  let n = 0
  for (const child of node.children ?? []) n += countFileNodes(child)
  return n
}

function collapsedNode(parent: FileNode, files: number, lines: number, bytes: number): FileNode {
  return {
    path: `${parent.path === '' ? '' : `${parent.path}/`}…`,
    name: `${files.toLocaleString('en-US')} more files`,
    type: 'file',
    lines,
    bytes,
    language: null,
    commits: 0,
    authors: 0,
    lastModified: parent.lastModified,
    ageDays: parent.ageDays,
    addedLines: 0,
    deletedLines: 0,
    reworkRatio: 0,
    complexity: null,
    functions: null,
    risk: parent.risk,
    flags: []
  }
}

/** Per-depth census, used to choose a collapse depth in one pass. */
function census(node: FileNode, depth: number, files: number[], directories: number[]): void {
  if (node.type === 'file') {
    files[depth] = (files[depth] ?? 0) + 1
    return
  }
  directories[depth] = (directories[depth] ?? 0) + 1
  for (const child of node.children ?? []) census(child, depth + 1, files, directories)
}

function collapseBeyondDepth(node: FileNode, depth: number, target: number): number {
  if (node.type === 'file') return 0
  const children = node.children
  if (children === undefined || children.length === 0) return 0

  if (depth >= target) {
    let files = 0
    let lines = 0
    let bytes = 0
    for (const child of children) {
      files += countFileNodes(child)
      lines += child.lines
      bytes += child.bytes
    }
    node.children = [collapsedNode(node, files, lines, bytes)]
    return files
  }

  let collapsed = 0
  for (const child of children) collapsed += collapseBeyondDepth(child, depth + 1, target)
  return collapsed
}

function capChildren(node: FileNode, cap: number): number {
  if (node.type === 'file') return 0
  const children = node.children
  if (children === undefined) return 0

  let capped = 0
  for (const child of children) capped += capChildren(child, cap)

  if (children.length > cap) {
    const kept = children.slice(0, cap - 1)
    const dropped = children.slice(cap - 1)
    let files = 0
    let lines = 0
    let bytes = 0
    for (const child of dropped) {
      files += countFileNodes(child)
      lines += child.lines
      bytes += child.bytes
    }
    kept.push(collapsedNode(node, files, lines, bytes))
    node.children = kept
    capped += files
  }

  return capped
}

/**
 * Brings the tree inside the IPC budget.
 *
 * The cut is by depth rather than by dropping arbitrary files, because a tree
 * missing a random 30% of its leaves is worse than useless — it looks complete
 * and is wrong. Collapsing whole subtrees into one labelled node is visibly
 * lossy, which is the honest failure mode. The deepest depth that fits is used,
 * so detail is only surrendered where the budget actually requires it.
 */
function pruneTree(root: FileNode, warn: (message: string) => void): void {
  const total = countFileNodes(root)

  if (total > MAX_TREE_FILES) {
    const files: number[] = []
    const directories: number[] = []
    census(root, 0, files, directories)
    const maxDepth = Math.max(files.length, directories.length)

    let running = files[0] ?? 0
    let target = 1
    for (let depth = 1; depth < maxDepth; depth++) {
      running += files[depth] ?? 0
      const kept = running + (directories[depth] ?? 0)
      if (kept > MAX_TREE_FILES) break
      target = depth
    }

    const collapsed = collapseBeyondDepth(root, 0, target)
    warn(
      `This repository has ${total.toLocaleString('en-US')} files, above the ` +
        `${MAX_TREE_FILES.toLocaleString('en-US')} VDE sends to the Map. ` +
        `${collapsed.toLocaleString('en-US')} files below depth ${target} are shown as collapsed ` +
        `summary nodes; every signal and finding still covers the whole repository.`
    )
  }

  const capped = capChildren(root, MAX_DIR_CHILDREN)
  if (capped > 0) {
    warn(
      `${capped.toLocaleString('en-US')} files sit in directories holding more than ` +
        `${MAX_DIR_CHILDREN.toLocaleString('en-US')} entries and are shown as a single collapsed node each.`
    )
  }
}

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

export interface BuildReportOptions {
  /** Progress within the report build; phases are the contract's own. */
  onProgress?: (phase: AnalysisPhase, message: string, current: number, total: number) => void
  /** Reuses a history the caller already read, avoiding a second log walk. */
  history?: History
}

/**
 * Builds the complete report for a repository at HEAD.
 *
 * Reads the history (unless handed one), rebuilds the HEAD context — cheap
 * after a scan, because every blob is already in the cache — runs the panel,
 * and assembles everything the renderer needs into one plain-data payload.
 */
export async function buildReport(
  repoId: string,
  repoPath: string,
  baseline: BaselineKind,
  ref: string | undefined,
  db: Db,
  settings: Settings,
  signal?: AbortSignal,
  options: BuildReportOptions = {}
): Promise<RepoReport> {
  const warnings: string[] = []
  const seen = new Set<string>()
  const warn = (message: string): void => {
    if (seen.has(message) || warnings.length >= 100) return
    seen.add(message)
    warnings.push(message)
  }

  throwIfCancelled(signal)
  options.onProgress?.('reading-history', 'Reading history', 0, 0)

  const history =
    options.history ??
    (await readHistory(repoPath, {
      signal,
      onProgress: (n) => options.onProgress?.('reading-history', 'Reading history', n, 0)
    }))

  const head = history.commits[0]
  if (head === undefined) {
    throw new Error(`${repoPath} has no commits reachable from HEAD, so there is nothing to report.`)
  }

  options.onProgress?.('scanning-tree', 'Reading the tree at HEAD', 0, 0)
  const ctx = await buildContext({
    repoId,
    repoPath,
    settings,
    db,
    history,
    rev: head.sha,
    signal,
    onWarning: warn,
    onProgress: (current, total) =>
      options.onProgress?.('parsing-content', 'Analysing file contents', current, total)
  })

  throwIfCancelled(signal)
  options.onProgress?.('computing-signals', 'Computing signals', 0, SIGNAL_ORDER.length)

  const run = runSignals(ctx)
  for (const message of run.warnings) warn(message)
  // Parser problems accumulate inside content/parse.ts; drain them here so a
  // grammar that would not load is visible to the user rather than silent.
  for (const message of takeWarnings()) warn(message)

  const facts = computeFacts(ctx)
  const repo = await resolveRepoRef(repoId, repoPath, history, db, signal, warn)

  const snapshotRows = db.getSnapshots(repoId)
  if (snapshotRows.length === 0) {
    warn(
      `No snapshots are stored for ${repo.name}, so this report has no history to compare against. ` +
        `Run a scan to build one.`
    )
  }

  const resolved = resolveBaseline(
    repoId,
    baseline,
    ref,
    head.sha,
    ctx.now,
    db,
    snapshotRows,
    warn
  )
  const deltas = computeDeltas(run.values, resolved.snapshot)

  const tree = buildFileTree(ctx, repo.name)
  pruneTree(tree, warn)

  const commits = history.commits
    .slice(0, MAX_COMMITS)
    .map((commit) => toCommitSummary(commit, ctx.megaThreshold))

  options.onProgress?.('done', 'Report ready', 1, 1)

  return {
    repo,
    // The clock, deliberately: a report is an observation made at a moment,
    // unlike the brief it feeds, which is rendered deterministically from it.
    generatedAt: new Date().toISOString(),
    baseline: resolved.ref,
    signals: run.values,
    deltas,
    topMovers: rankMovers(deltas),
    facts,
    baselineFacts: resolved.snapshot?.facts ?? null,
    snapshots: snapshotRows.map(toSnapshotPoint),
    timeline: buildTimeline(history, ctx.megaThreshold),
    tree,
    findings: run.findings,
    commits,
    warnings
  }
}

/** Exposed for tests. */
export const __testing = {
  buildTimeline,
  buildFileTree,
  pruneTree,
  computeDeltas,
  rankMovers,
  resolveBaseline,
  toCommitSummary,
  MAX_TREE_FILES,
  MAX_DIR_CHILDREN,
  DIRECTION_DEADBAND
}
