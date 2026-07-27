/**
 * Reconstructing the repository at a revision.
 *
 * `buildContext` is the expensive half of VDE. Everything a signal needs — the
 * tree, the contents of every blob in it, per-path history aggregates, the
 * near-duplicate clusters — is assembled here, once, and every one of the
 * fourteen signals is then a pure function over the result. That separation is
 * what makes 180 retroactive snapshots affordable: the analysis is rerun 180
 * times, but the *reading* is not.
 *
 * Three mechanisms carry that weight.
 *
 *  1. THE BLOB CACHE. `BlobAnalysis` is keyed by git blob sha, which is
 *     content-addressed, so a file that did not change between two snapshots is
 *     read and parsed exactly once — ever, across the whole life of the
 *     database. On a repository whose files mostly sit still (which is every
 *     repository) this turns an O(snapshots x files) cost into O(distinct
 *     contents). It is the single reason backfill is possible at all.
 *
 *  2. ANCESTRY, NOT TIMESTAMPS. A snapshot at an old commit must see exactly
 *     the commits reachable from it. Filtering the history by author time would
 *     be wrong on any branchy repository (a commit authored earlier can land
 *     later), so the parent graph is walked instead.
 *
 *  3. BOUNDED PARALLELISM WITH YIELDS. Reading a blob costs a `git cat-file`
 *     process; running eight at once hides that latency. The work that follows
 *     each read — line counting, SimHash, tree-sitter — is CPU-bound on the one
 *     JS thread, so no amount of concurrency speeds it up and threads would only
 *     add copying. What matters instead is yielding to the event loop
 *     periodically so progress can be reported and cancellation observed; a scan
 *     that cannot be cancelled is a scan that hangs the app.
 */

import type { LanguageStat, Settings, SnapshotFacts } from '../../shared/types'
import { buildClusters } from '../content/clusters'
import { classifyFile, isExcluded } from '../content/classify'
import { detectLanguage } from '../content/language'
import { countLines } from '../content/loc'
import { MAX_PARSE_CHARS, analyzeSource, isLanguageSupported } from '../content/parse'
import { simhash64 } from '../content/simhash'
import type { Db } from '../db'
import { readBlob } from '../git/exec'
import { readTree } from '../git/tree'
import type {
  AnalysisContext,
  BlobAnalysis,
  CommitRecord,
  FileKind,
  FileStats,
  History,
  TreeEntry
} from '../model'
import { Cancelled, EXCLUDED_KINDS } from '../model'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

/**
 * Width of the scoring window for the signals that measure recent behaviour
 * (accretion, blast radius, commit hygiene, doc bloat). Ninety days is long
 * enough to survive a quiet fortnight and short enough that a repository is not
 * judged forever by its first month.
 */
const DEFAULT_WINDOW_DAYS = 90

/** Floor on the window, so a three-day-old repository still has one. */
const MIN_WINDOW_DAYS = 7

/** Mega-commit floor and multiple: max(25, p90 x 2.5). See model.ts. */
const MEGA_FLOOR = 25
const MEGA_P90_MULTIPLE = 2.5

/**
 * Blobs larger than this are not read. A 16 MB file is a checked-in artefact,
 * not code, and reading it would cost more than every source file combined.
 * Deliberately NOT written to the cache: the decision is a policy of this build,
 * and caching it would freeze that policy into the database forever.
 */
const MAX_BLOB_BYTES = 8 * 1024 * 1024

/** Above this, SimHash is skipped: a fingerprint of a 4 MB bundle means nothing. */
const MAX_SIMHASH_CHARS = 4 * 1024 * 1024

/**
 * Concurrent `git cat-file` processes. Each read is one spawn, so this hides
 * process-start latency; past roughly this point the JS thread is the
 * bottleneck and more workers only add contention.
 */
const BLOB_READ_CONCURRENCY = 8

/** Blobs analysed between progress reports and event-loop yields. */
const YIELD_EVERY = 64

/** Rows per blob-cache write. Bounded so a cancelled scan still banks its work. */
const BLOB_WRITE_CHUNK = 512

/** Contractual cap from model.ts: FileStats.touchedBy holds 200 shas, newest first. */
const TOUCHED_BY_CAP = 200

/** Rename chains are two or three hops in practice; the cap only bounds cycles. */
const RENAME_CHAIN_CAP = 32

/** Languages that dominate the stacked-area chart; the rest are still summed. */
const UNKNOWN_LANGUAGE = 'Other'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Immediate parent directory of a repo-relative path; '' for root-level files. */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** Depth of a repo-relative path. Root is 0, 'src' is 1, 'src/a' is 2. */
function depthOf(path: string): number {
  if (path === '') return 0
  let d = 1
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 47 /* '/' */) d++
  return d
}

/**
 * Symlinks (120000) and submodule gitlinks (160000) are pointers, not content.
 * Counting them would inflate file counts, directory sprawl and line totals with
 * things that have no lines.
 */
function isRegularFile(entry: TreeEntry): boolean {
  return entry.mode !== '120000' && entry.mode !== '160000'
}

/** Nearest-rank percentile over an ascending array. Matches signals/history.ts. */
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const rank = Math.ceil((p / 100) * sortedAsc.length)
  const idx = Math.min(Math.max(rank - 1, 0), sortedAsc.length - 1)
  return sortedAsc[idx] ?? 0
}

/**
 * Hands the event loop back so a queued progress message can be posted and an
 * abort can be observed. `setImmediate` runs after I/O callbacks, which is
 * exactly where a pending `postMessage` is waiting.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Cancelled()
}

// ---------------------------------------------------------------------------
// Ancestry
// ---------------------------------------------------------------------------

/**
 * sha → position in `History.commits`, memoised per History object. Built once
 * and reused across every snapshot of a backfill, where it is consulted a few
 * hundred thousand times.
 */
const HISTORY_POSITIONS = new WeakMap<History, Map<string, number>>()

function historyPositions(history: History): Map<string, number> {
  const cached = HISTORY_POSITIONS.get(history)
  if (cached !== undefined) return cached
  const positions = new Map<string, number>()
  for (let i = 0; i < history.commits.length; i++) {
    const c = history.commits[i]
    if (c !== undefined) positions.set(c.sha, i)
  }
  HISTORY_POSITIONS.set(history, positions)
  return positions
}

/**
 * The commits reachable from `sha`, newest-first, preserving the history's own
 * ordering.
 *
 * Walking the parent graph rather than filtering on author time is not
 * pedantry: `git commit --date`, rebases and clock skew all produce commits
 * whose author time is older than commits they descend from, and a snapshot
 * that included work not yet merged at that point would report the future.
 *
 * A sha absent from the history (a ref outside HEAD's reachability) yields the
 * whole history — the caller asked about a revision we cannot place, and
 * silently returning nothing would render an empty repository.
 */
export function ancestorCommits(history: History, sha: string): CommitRecord[] {
  const positions = historyPositions(history)
  const start = positions.get(sha)
  if (start === undefined) return history.commits
  // Fast path: the newest commit reaches everything the history contains.
  if (start === 0) return history.commits

  const reachable = new Uint8Array(history.commits.length)
  reachable[start] = 1
  const stack: number[] = [start]

  for (;;) {
    const i = stack.pop()
    if (i === undefined) break
    const commit = history.commits[i]
    if (commit === undefined) continue
    for (const parent of commit.parents) {
      const j = positions.get(parent)
      if (j === undefined) continue
      if (reachable[j] === 1) continue
      reachable[j] = 1
      stack.push(j)
    }
  }

  const out: CommitRecord[] = []
  for (let i = 0; i < history.commits.length; i++) {
    if (reachable[i] !== 1) continue
    const c = history.commits[i]
    if (c !== undefined) out.push(c)
  }
  return out
}

/** Restricts a History to the commits reachable from `sha`. */
function historyAt(history: History, sha: string): History {
  const commits = ancestorCommits(history, sha)
  if (commits === history.commits) return history

  const authors = new Map<string, string>()
  let firstAt = Number.POSITIVE_INFINITY
  let lastAt = 0
  for (const c of commits) {
    if (!authors.has(c.authorEmail)) authors.set(c.authorEmail, c.authorName)
    if (c.authoredAt > 0 && c.authoredAt < firstAt) firstAt = c.authoredAt
    if (c.authoredAt > lastAt) lastAt = c.authoredAt
  }
  return {
    commits,
    firstAt: Number.isFinite(firstAt) ? firstAt : 0,
    lastAt,
    authors
  }
}

// ---------------------------------------------------------------------------
// Per-path history aggregates
// ---------------------------------------------------------------------------

function newFileStats(path: string): FileStats {
  return {
    path,
    commits: 0,
    authors: new Set<string>(),
    firstAt: Number.POSITIVE_INFINITY,
    lastAt: 0,
    added: 0,
    deleted: 0,
    alive: false,
    formerPaths: [],
    touchedBy: []
  }
}

/**
 * Builds `FileStats` for every path the given commits ever touched.
 *
 * Commits arrive newest-first and are walked in that order, which makes
 * `touchedBy` and `formerPaths` naturally most-recent-first — both are
 * documented that way in model.ts — and lets `touchedBy` stop at its cap
 * without keeping a longer list around to trim.
 *
 * Merge commits are skipped. `git log` reports no diff for a merge without
 * `-m`, so their `files` list is empty anyway; skipping them explicitly states
 * the intent rather than relying on that.
 *
 * RENAMES ARE FOLDED FORWARD. A rename A→B leaves *both* records in the map (so
 * signals/history.ts can recognise A as renamed-away and fold its historical
 * line attributions onto B) and additionally rolls A's totals into B, so that
 * `commits` really is "commits touching this path, following renames" as the
 * model promises. Without the roll-up a heavily edited file that was renamed
 * last week reads as write-once.
 */
export function aggregateFileStats(
  commits: readonly CommitRecord[],
  livePaths: ReadonlySet<string>
): Map<string, FileStats> {
  const stats = new Map<string, FileStats>()

  const ensure = (path: string): FileStats => {
    let s = stats.get(path)
    if (s === undefined) {
      s = newFileStats(path)
      stats.set(path, s)
    }
    return s
  }

  for (const commit of commits) {
    if (commit.isMerge) continue
    for (const change of commit.files) {
      const s = ensure(change.path)
      s.commits++
      s.authors.add(commit.authorEmail)
      if (commit.authoredAt > 0) {
        if (commit.authoredAt < s.firstAt) s.firstAt = commit.authoredAt
        if (commit.authoredAt > s.lastAt) s.lastAt = commit.authoredAt
      }
      s.added += change.insertions
      s.deleted += change.deletions
      if (s.touchedBy.length < TOUCHED_BY_CAP) s.touchedBy.push(commit.sha)
      // Only 'R' establishes ancestry. A copy ('C') creates a second file that
      // happens to share content; its history does not belong to the original.
      if (change.status === 'R' && change.oldPath !== undefined && change.oldPath !== change.path) {
        if (!s.formerPaths.includes(change.oldPath)) s.formerPaths.push(change.oldPath)
      }
    }
  }

  for (const s of stats.values()) {
    if (!Number.isFinite(s.firstAt)) s.firstAt = 0
    s.alive = livePaths.has(s.path)
  }

  // A path present in the tree but absent from history happens on shallow
  // clones, where the creating commit was never fetched. Give it a record so the
  // Map view and the per-file signals have something to read.
  for (const path of livePaths) {
    if (!stats.has(path)) {
      const s = ensure(path)
      s.firstAt = 0
      s.alive = true
    }
  }

  foldRenamesForward(stats)
  return stats
}

/**
 * Rolls each renamed-away path's totals into the path it became.
 *
 * Mirrors the folding in signals/history.ts exactly, including its one important
 * exception: a former path that is *alive* in the analysed tree was recreated as
 * a genuinely new file (agents do this constantly — move a module out, write a
 * fresh one back under the old name) and must not be folded into anything.
 */
function foldRenamesForward(stats: Map<string, FileStats>): void {
  const successor = new Map<string, string>()
  for (const [path, s] of stats) {
    for (const former of s.formerPaths) {
      if (former === path || former === '') continue
      if (stats.get(former)?.alive === true) continue
      if (!successor.has(former)) successor.set(former, path)
    }
  }
  if (successor.size === 0) return

  const canonical = new Map<string, string>()
  const resolve = (start: string): string => {
    const memo = canonical.get(start)
    if (memo !== undefined) return memo
    let cur = start
    // Depth cap rather than a visited set: chains are short, and a cycle (which
    // git can produce from a swap) must terminate rather than throw.
    for (let hops = 0; hops < RENAME_CHAIN_CAP; hops++) {
      const next = successor.get(cur)
      if (next === undefined || next === cur || next === start) break
      cur = next
    }
    canonical.set(start, cur)
    return cur
  }

  // `resolve` always lands on a terminal path, so a fold target is never itself
  // a fold source — the mutations below cannot cascade or double-count.
  for (const [path, s] of stats) {
    const target = resolve(path)
    if (target === path) continue
    const t = stats.get(target)
    if (t === undefined) continue
    t.commits += s.commits
    t.added += s.added
    t.deleted += s.deleted
    for (const author of s.authors) t.authors.add(author)
    if (s.firstAt > 0 && (t.firstAt === 0 || s.firstAt < t.firstAt)) t.firstAt = s.firstAt
    if (s.lastAt > t.lastAt) t.lastAt = s.lastAt
    for (const sha of s.touchedBy) {
      if (t.touchedBy.length >= TOUCHED_BY_CAP) break
      if (!t.touchedBy.includes(sha)) t.touchedBy.push(sha)
    }
  }
}

// ---------------------------------------------------------------------------
// Blob analysis
// ---------------------------------------------------------------------------

/** Running totals for one scan, so backfill can report a real cache hit rate. */
export interface BlobCacheStats {
  hits: number
  misses: number
  /** Blobs skipped for exceeding {@link MAX_BLOB_BYTES}. */
  oversize: number
  /** Blobs whose read or analysis failed. */
  failed: number
  bytesRead: number
}

export function newBlobCacheStats(): BlobCacheStats {
  return { hits: 0, misses: 0, oversize: 0, failed: 0, bytesRead: 0 }
}

/** What the blob loader is asked to produce content for. */
interface BlobRequest {
  sha: string
  /** A path holding this content, used for language detection only. */
  path: string
  /** Size from `ls-tree -l`; -1 when git reported '-'. */
  size: number
  kind: FileKind
}

/**
 * Looks inside one blob.
 *
 * Language detection is path-first (see content/language.ts), which means the
 * same content at two paths with different extensions could in principle be
 * cached under whichever was seen first. That is inherent in keying
 * `BlobAnalysis` by sha — the contract in model.ts — and is harmless in
 * practice: identical bytes at `a.py` and `a.rs` do not happen.
 */
async function analyseBlob(
  repoPath: string,
  request: BlobRequest,
  signal: AbortSignal | undefined
): Promise<BlobAnalysis | null> {
  const buf = await readBlob(repoPath, request.sha, { signal, maxBuffer: MAX_BLOB_BYTES })

  const language = detectLanguage(request.path, buf)
  const counts = countLines(buf, language)

  const analysis: BlobAnalysis = {
    sha: request.sha,
    bytes: buf.length,
    lines: counts.lines,
    codeLines: counts.codeLines,
    language,
    binary: counts.binary,
    functions: null,
    totalComplexity: null,
    maxComplexity: null,
    complexFunctions: null,
    simhash: null
  }

  if (counts.binary) return analysis

  // One decode, shared by SimHash and tree-sitter. Both want a string, and
  // decoding an 8 MB buffer twice is pure waste.
  const needsParse =
    (request.kind === 'source' || request.kind === 'test') &&
    language !== null &&
    isLanguageSupported(language)
  const needsSimhash = buf.length <= MAX_SIMHASH_CHARS
  if (!needsParse && !needsSimhash) return analysis

  const text = buf.toString('utf8')

  if (needsSimhash) analysis.simhash = simhash64(text)

  if (needsParse && language !== null && text.length <= MAX_PARSE_CHARS) {
    const structural = await analyzeSource(text, language)
    if (structural !== null) {
      analysis.functions = structural.functions
      analysis.totalComplexity = structural.totalComplexity
      analysis.maxComplexity = structural.maxComplexity
      analysis.complexFunctions = structural.complexFunctions
    }
  }

  return analysis
}

interface ResolveBlobsOptions {
  repoPath: string
  db: Db
  signal?: AbortSignal
  onProgress?: (current: number, total: number) => void
  onWarning?: (message: string) => void
  cache: BlobCacheStats
}

/**
 * Resolves `BlobAnalysis` for every requested blob: cache first, then read and
 * parse only the misses.
 *
 * The cache lookup is a single batched query for the whole tree, so a snapshot
 * whose files are all unchanged costs one SQL round trip and no git at all.
 * That is the mechanism the entire backfill rests on.
 */
async function resolveBlobs(
  requests: readonly BlobRequest[],
  opts: ResolveBlobsOptions
): Promise<Map<string, BlobAnalysis>> {
  const blobs = new Map<string, BlobAnalysis>()
  if (requests.length === 0) return blobs

  const shas = requests.map((r) => r.sha)
  const cached = opts.db.getBlobs(shas)

  const misses: BlobRequest[] = []
  for (const request of requests) {
    if (blobs.has(request.sha)) continue
    const hit = cached.get(request.sha)
    if (hit !== undefined) {
      blobs.set(request.sha, hit)
      opts.cache.hits++
      continue
    }
    misses.push(request)
  }
  opts.cache.misses += misses.length

  opts.onProgress?.(0, misses.length)
  if (misses.length === 0) return blobs

  const pending: BlobAnalysis[] = []
  let cursor = 0
  let done = 0

  const flush = (): void => {
    if (pending.length === 0) return
    opts.db.putBlobs(pending)
    pending.length = 0
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      throwIfCancelled(opts.signal)
      const index = cursor++
      if (index >= misses.length) return
      const request = misses[index]
      if (request === undefined) return

      if (request.size > MAX_BLOB_BYTES) {
        // Not cached: see MAX_BLOB_BYTES. The check is free to repeat.
        opts.cache.oversize++
        blobs.set(request.sha, {
          sha: request.sha,
          bytes: request.size,
          lines: 0,
          codeLines: null,
          language: detectLanguage(request.path),
          binary: false,
          functions: null,
          totalComplexity: null,
          maxComplexity: null,
          complexFunctions: null,
          simhash: null
        })
      } else {
        try {
          const analysis = await analyseBlob(opts.repoPath, request, opts.signal)
          if (analysis !== null) {
            blobs.set(request.sha, analysis)
            pending.push(analysis)
            opts.cache.bytesRead += analysis.bytes
          }
        } catch (err) {
          if (opts.signal?.aborted === true) throw new Cancelled()
          if (err instanceof Cancelled) throw err
          opts.cache.failed++
          const reason = err instanceof Error ? err.message : String(err)
          opts.onWarning?.(
            `Could not read ${request.path} (blob ${request.sha.slice(0, 8)}): ${reason}. ` +
              `It is excluded from this snapshot's content signals.`
          )
        }
      }

      done++
      if (done % YIELD_EVERY === 0) {
        if (pending.length >= BLOB_WRITE_CHUNK) flush()
        opts.onProgress?.(done, misses.length)
        await yieldToEventLoop()
      }
    }
  }

  const workerCount = Math.min(BLOB_READ_CONCURRENCY, misses.length)
  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  } finally {
    // Bank whatever was analysed even when the scan was cancelled: the work is
    // valid regardless of why we stopped, and re-reading it would be pure waste.
    flush()
  }

  opts.onProgress?.(misses.length, misses.length)
  return blobs
}

// ---------------------------------------------------------------------------
// buildContext
// ---------------------------------------------------------------------------

export interface BuildContextInput {
  repoId: string
  repoPath: string
  settings: Settings
  db: Db
  /** The repository's full history, read once per scan. */
  history: History
  /** Commit sha to anchor on. Normally in `history`; HEAD is the common case. */
  rev: string
  /** Pre-read tree, when the caller already has one for this revision. */
  tree?: TreeEntry[]
  signal?: AbortSignal
  /** Called with (blobs analysed, blobs to analyse) during content analysis. */
  onProgress?: (current: number, total: number) => void
  onWarning?: (message: string) => void
  /** Accumulates cache statistics across a whole backfill. */
  cache?: BlobCacheStats
  /** Overrides the adaptive scoring window. */
  windowDays?: number
}

/**
 * Assembles everything the fourteen signals read, for one revision.
 *
 * The anchor commit's author time becomes `ctx.now`: age arithmetic in a
 * snapshot must be relative to that snapshot, or a file written the day before
 * a two-year-old revision would read as two years stale.
 */
export async function buildContext(input: BuildContextInput): Promise<AnalysisContext> {
  const { repoPath, settings, db, rev } = input
  throwIfCancelled(input.signal)

  const history = historyAt(input.history, rev)
  const anchor = history.commits.find((c) => c.sha === rev)
  // An unknown revision still has to produce a coherent context; the newest
  // commit's timestamp is the only defensible "now" available.
  const now = anchor?.authoredAt ?? history.lastAt ?? 0

  const tree = input.tree ?? (await readTree(repoPath, rev, { signal: input.signal }))
  throwIfCancelled(input.signal)

  // --- classification, directory counts, live path set ---------------------
  //
  // Classification is path-only. `classifyFile` can also read a blob's opening
  // lines to spot an "@generated" header, but doing so here would make a file's
  // kind depend on whether its blob happened to be a cache miss on this run —
  // and a signal whose value moves with cache state is not a measurement.
  const kinds = new Map<string, FileKind>()
  const livePaths = new Set<string>()
  const dirFileCounts = new Map<string, number>()
  const analysable: BlobRequest[] = []
  const seenSha = new Set<string>()

  for (const entry of tree) {
    if (!isRegularFile(entry)) continue
    livePaths.add(entry.path)

    const kind = classifyFile(entry.path, settings)
    kinds.set(entry.path, kind)

    const dir = dirOf(entry.path)
    dirFileCounts.set(dir, (dirFileCounts.get(dir) ?? 0) + 1)
    // Every ancestor gets a key, at zero if it holds only subdirectories. The
    // calibration behind directorySprawl's thresholds counts those containers;
    // omitting them here would move the specimen from 38% to 20% and cross two
    // threshold bands. See the note on directorySprawl in signals/tree.ts.
    let cur = dir
    while (cur !== '') {
      if (!dirFileCounts.has(cur)) dirFileCounts.set(cur, 0)
      cur = dirOf(cur)
    }
    if (!dirFileCounts.has('')) dirFileCounts.set('', 0)

    if (EXCLUDED_KINDS.has(kind)) continue
    if (isExcluded(entry.path, settings)) continue
    if (seenSha.has(entry.sha)) continue
    seenSha.add(entry.sha)
    analysable.push({ sha: entry.sha, path: entry.path, size: entry.size, kind })
  }

  // --- history aggregates --------------------------------------------------

  const fileStats = aggregateFileStats(history.commits, livePaths)
  for (const path of fileStats.keys()) {
    if (!kinds.has(path)) kinds.set(path, classifyFile(path, settings))
  }

  // --- content -------------------------------------------------------------

  const cache = input.cache ?? newBlobCacheStats()
  const blobs = await resolveBlobs(analysable, {
    repoPath,
    db,
    signal: input.signal,
    onProgress: input.onProgress,
    onWarning: input.onWarning,
    cache
  })
  throwIfCancelled(input.signal)

  // --- scoring window ------------------------------------------------------

  const ageDays = history.firstAt > 0 ? (now - history.firstAt) / DAY_MS : 0
  const windowDays =
    input.windowDays ??
    Math.min(DEFAULT_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.ceil(ageDays) || MIN_WINDOW_DAYS))
  const windowStart = now - windowDays * DAY_MS
  const window: CommitRecord[] = []
  for (const c of history.commits) {
    if (c.isMerge) continue
    if (c.authoredAt > now) continue
    if (c.authoredAt <= windowStart) continue
    window.push(c)
  }

  // --- mega-commit threshold ----------------------------------------------

  const sizes: number[] = []
  for (const c of history.commits) {
    if (c.isMerge) continue
    sizes.push(c.files.length)
  }
  sizes.sort((a, b) => a - b)
  const megaThreshold = Math.max(MEGA_FLOOR, Math.round(percentile(sizes, 90) * MEGA_P90_MULTIPLE))

  // --- near-duplicate clusters --------------------------------------------

  const simhashes = new Map<string, string>()
  const lineCounts = new Map<string, number>()
  for (const entry of tree) {
    if (!isRegularFile(entry)) continue
    const blob = blobs.get(entry.sha)
    if (blob === undefined) continue
    lineCounts.set(entry.path, blob.lines)
    if (blob.simhash !== null) simhashes.set(entry.path, blob.simhash)
  }

  const clusters = buildClusters([...livePaths].sort(), simhashes, {
    kinds,
    lines: lineCounts,
    isExcluded: (path) => isExcluded(path, settings)
  })

  throwIfCancelled(input.signal)

  return {
    repoId: input.repoId,
    repoPath,
    settings,
    headSha: rev,
    now,
    history,
    window,
    windowDays,
    tree,
    blobs,
    kinds,
    fileStats,
    dirFileCounts,
    clusters,
    megaThreshold
  }
}

// ---------------------------------------------------------------------------
// computeFacts
// ---------------------------------------------------------------------------

interface LanguageAccum {
  files: number
  lines: number
  bytes: number
}

/** Languages shown per snapshot point; the rest are folded into "Other". */
const SNAPSHOT_LANGUAGE_CAP = 12

/**
 * The point-in-time facts stored with every snapshot and shown in the brief.
 *
 * Line totals cover only the files VDE actually looked inside — excluded kinds
 * (lockfiles, vendored trees, images) contribute nothing, which is the whole
 * point of excluding them. `fileCount` is the opposite: it counts every regular
 * file in the tree, because "how big is this repository" is a question about the
 * repository, not about what we chose to measure.
 */
export function computeFacts(ctx: AnalysisContext): SnapshotFacts {
  let fileCount = 0
  let totalLines = 0
  let sourceLines = 0
  let docLines = 0
  let testLines = 0
  let configLines = 0
  let maxDepth = 0

  const languages = new Map<string, LanguageAccum>()

  for (const entry of ctx.tree) {
    if (!isRegularFile(entry)) continue
    fileCount++

    // Depth of the deepest *file*, not of the deepest directory: "max depth 8"
    // for the calibration specimen counts `a/b/c/d/e/f/g/h.ts` as eight levels,
    // which is also how a reader of the brief will count it.
    const depth = depthOf(entry.path)
    if (depth > maxDepth) maxDepth = depth

    const blob = ctx.blobs.get(entry.sha)
    if (blob === undefined) continue

    totalLines += blob.lines
    switch (ctx.kinds.get(entry.path)) {
      case 'source':
        sourceLines += blob.lines
        break
      case 'doc':
        docLines += blob.lines
        break
      case 'test':
        testLines += blob.lines
        break
      case 'config':
        configLines += blob.lines
        break
      default:
        break
    }

    const name = blob.language ?? UNKNOWN_LANGUAGE
    const accum = languages.get(name)
    if (accum === undefined) languages.set(name, { files: 1, lines: blob.lines, bytes: blob.bytes })
    else {
      accum.files++
      accum.lines += blob.lines
      accum.bytes += blob.bytes
    }
  }

  const contributors = new Set<string>()
  for (const c of ctx.history.commits) contributors.add(c.authorEmail)

  const ranked: LanguageStat[] = [...languages.entries()]
    .map(([language, a]) => ({ language, files: a.files, lines: a.lines, bytes: a.bytes }))
    .sort((a, b) => b.lines - a.lines || b.files - a.files || a.language.localeCompare(b.language))

  return {
    commitCount: ctx.history.commits.length,
    fileCount,
    totalLines,
    sourceLines,
    docLines,
    testLines,
    configLines,
    // The root key is a bookkeeping entry, not a directory of the repository.
    dirCount: Math.max(0, ctx.dirFileCounts.size - 1),
    maxDepth,
    contributors: contributors.size,
    languages: ranked
  }
}

/**
 * Trims a language breakdown to the slices a stacked-area chart can actually
 * draw, folding the tail into one "Other" band so the totals still add up.
 */
export function topLanguages(stats: readonly LanguageStat[], cap = SNAPSHOT_LANGUAGE_CAP): LanguageStat[] {
  if (stats.length <= cap) return [...stats]
  const head = stats.slice(0, cap - 1)
  const tail = stats.slice(cap - 1)
  const other: LanguageStat = { language: UNKNOWN_LANGUAGE, files: 0, lines: 0, bytes: 0 }
  for (const s of tail) {
    other.files += s.files
    other.lines += s.lines
    other.bytes += s.bytes
  }
  head.push(other)
  return head
}

/** Exposed for tests. */
export const __testing = {
  dirOf,
  depthOf,
  percentile,
  isRegularFile,
  historyAt,
  MAX_BLOB_BYTES,
  BLOB_READ_CONCURRENCY
}
