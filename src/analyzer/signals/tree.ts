/**
 * Tree-shaped signals.
 *
 * Seven of VDE's fourteen signals read the *shape of the repository at HEAD*
 * rather than the shape of its history: how big files are, how many of them are
 * near-duplicates of each other, how many were written once and abandoned, how
 * branchy their functions are, how thin the directory tree is, and how much of
 * the writing went into prose instead of code.
 *
 * Every computer here is a pure function of AnalysisContext. Nothing in this
 * file touches the filesystem, spawns a process, or reaches for git — by the
 * time a signal runs, the expensive reads are already in the context. That is
 * what makes the whole panel cheap to recompute for 180 retroactive snapshots.
 *
 * Two invariants hold throughout, and the rest of the app depends on them:
 *   - `value` is always higher-is-worse, on a 0–100 scale for these seven.
 *   - `drivers` are ranked worst-first, capped at 50, and carry a label that is
 *     ready to render. The renderer never formats a number.
 */

import type { FileFlag, SignalDriver } from '../../shared/types'
import type {
  AnalysisContext,
  BlobAnalysis,
  FileKind,
  FileStats,
  RawFinding,
  SignalComputer,
  SignalResult,
  SprawlCluster,
  TreeEntry
} from '../model'
import { EXCLUDED_KINDS } from '../model'

// ---------------------------------------------------------------------------
// Calibration constants
//
// These are the numbers the seven signals are defined by. They live together at
// the top so a reviewer can audit every threshold in one screen, and so the
// signal bodies read as prose rather than as arithmetic.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

/** A file above this many lines exceeds what a reviewer — or a context window — holds. */
const GOD_FILE_LINES = 800
/** Above this, the file is not merely large, it is a structural problem worth a finding. */
const GOD_FILE_FINDING_LINES = 2000

/** A file must be this old before "committed once" means "abandoned" rather than "new". */
const WRITE_ONCE_MIN_AGE_DAYS = 14

/** No commit in this long: the file has fallen out of the working set. */
const STALE_DAYS = 180

/** deleted/added at or above this, with enough volume to mean it, is a rewrite. */
const REWORK_RATIO = 0.5
const REWORK_MIN_ADDED = 200

/** Two files with similar names are a coincidence; three are a pattern. */
const CLUSTER_MIN_MEMBERS = 3
/** Four is no longer explicable and gets named in the brief. */
const CLUSTER_FINDING_MEMBERS = 4

/** Cyclomatic complexity above which a function is "complex". Matches signals.ts. */
const COMPLEXITY_LIMIT = 10

/** The test-to-source LINE ratio testDeficit scores a shortfall against. */
const TEST_RATIO_TARGET = 0.4
/** A directory needs this much source before its local test ratio means anything. */
const DIR_MIN_SOURCE_LINES = 300

/** Fewer than this many files and a directory is not carrying its own weight. */
const DIR_SPRAWL_MIN_FILES = 3

/** Hard cap from the contract: SignalValue.drivers is capped at 50 by the analyzer. */
const DRIVER_CAP = 50
/**
 * Findings are read by a human and pasted into an agent prompt, so they are
 * rationed far harder than drivers. Ten of anything is already a wall of text.
 */
const FINDING_CAP = 10

// ---------------------------------------------------------------------------
// Numeric and formatting helpers
// ---------------------------------------------------------------------------

function round(n: number, dp: number): number {
  if (!Number.isFinite(n)) return 0
  const f = 10 ** dp
  return Math.round(n * f) / f
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * Percentage of `whole` that `part` represents, rounded to two places.
 *
 * Two places rather than the tile's one: snapshot deltas are computed from
 * these numbers, and rounding to display precision before differencing makes
 * small real movements vanish.
 */
function pct(part: number, whole: number): number {
  if (!(whole > 0) || !Number.isFinite(part)) return 0
  return round(100 * (part / whole), 2)
}

function fmt1(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(1)
}

function fmt2(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(2)
}

/** Thousands separators without depending on ICU locale data being present. */
function fmtInt(n: number): string {
  const v = Number.isFinite(n) ? Math.round(n) : 0
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/** Inclusive-exclusive slice with the contract's driver cap applied. */
function capDrivers(rows: SignalDriver[]): SignalDriver[] {
  return rows.length > DRIVER_CAP ? rows.slice(0, DRIVER_CAP) : rows
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / DAY_MS)
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** Depth of a repo-relative path. Root is 0, 'src' is 1, 'src/a' is 2. */
function depthOf(path: string): number {
  if (path === '') return 0
  let d = 1
  for (let i = 0; i < path.length; i++) if (path[i] === '/') d++
  return d
}

/** Every ancestor directory of a path, nearest first, excluding the root. */
function ancestorsOf(path: string): string[] {
  const out: string[] = []
  let cur = dirOf(path)
  while (cur !== '') {
    out.push(cur)
    cur = dirOf(cur)
  }
  return out
}

/**
 * Minimal glob → RegExp for the shapes that actually appear in
 * Settings.excludeGlobs / generatedGlobs: `**` for any number of segments, `*`
 * and `?` within a segment, everything else literal.
 *
 * A trailing `/**` matches the directory itself as well as its contents, which
 * is what lets directorySprawl test a bare directory path against
 * `**\/node_modules/**` and get a hit.
 */
function globToRegExp(glob: string): RegExp {
  let src = '^'
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === undefined) break
    if (c === '/' && glob.slice(i) === '/**') {
      src += '(?:/.*)?'
      i += 3
      continue
    }
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // '**/' means "zero or more leading path segments".
          src += '(?:[^/]*/)*'
          i += 3
        } else {
          src += '.*'
          i += 2
        }
        continue
      }
      src += '[^/]*'
      i += 1
      continue
    }
    if (c === '?') {
      src += '[^/]'
      i += 1
      continue
    }
    src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    i += 1
  }
  return new RegExp(src + '$')
}

function compileGlobs(globs: readonly string[]): RegExp[] {
  const out: RegExp[] = []
  for (const g of globs) {
    if (typeof g !== 'string' || g.length === 0) continue
    try {
      out.push(globToRegExp(g))
    } catch {
      // A malformed user glob must not take down the scan; it is simply ignored.
    }
  }
  return out
}

function anyMatch(res: readonly RegExp[], path: string): boolean {
  for (const r of res) if (r.test(path)) return true
  return false
}

/** Directory names that mean "someone else's code". Used for the vendored flag. */
const VENDOR_SEGMENT =
  /(?:^|\/)(?:vendor|vendored|third_party|thirdparty|3rdparty|node_modules|bower_components|\.yarn|Pods)(?:\/|$)/

/** Test-tree directory names, used to map a parallel test tree back onto source. */
const TEST_DIR_SEGMENT = /^(?:tests?|specs?|__tests__|__test__|testing|e2e)$/i

/**
 * Extensions we treat as binary when no BlobAnalysis exists. Blobs are only
 * analysed for non-excluded tree entries, so an image or a font never gets one
 * and would otherwise never earn its 'binary' flag on the Map.
 */
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'icns', 'tif', 'tiff', 'avif', 'heic',
  'mp3', 'mp4', 'm4a', 'mov', 'avi', 'mkv', 'wav', 'ogg', 'webm', 'flac',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  'so', 'dylib', 'dll', 'exe', 'class', 'o', 'a', 'node', 'wasm',
  'pyc', 'pyo', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'parquet', 'pack', 'idx'
])

function extOf(path: string): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  if (dot <= slash + 1) return ''
  return path.slice(dot + 1).toLowerCase()
}

// ---------------------------------------------------------------------------
// The per-context index
//
// computeFileFlags and computeRisk are called once per node of a 4,000-node
// tree, and several signals need the same derived sets. Rebuilding them per
// call is quadratic, so they are memoised against the context object itself.
// The context is rebuilt for every snapshot, so the WeakMap entry dies with it
// and there is no invalidation problem to get wrong.
// ---------------------------------------------------------------------------

interface TreeIndex {
  entryByPath: Map<string, TreeEntry>
  /** Every path present in the analysed tree, regardless of kind. */
  livePaths: Set<string>
  /** Live paths that count for scoring: regular files, kind not excluded, not glob-excluded. */
  scored: Set<string>
  /** Scored paths of kind 'source', in tree order. */
  sourcePaths: string[]
  /** Scored paths of kind 'test'. */
  testPaths: string[]
  /** Members of near-duplicate clusters large enough to count (>= CLUSTER_MIN_MEMBERS). */
  sprawlMembers: Set<string>
  excludeRe: RegExp[]
  generatedRe: RegExp[]
  /** Directories that directly contain at least one scored source file. */
  sourceDirs: Set<string>
  /** path → 1-based rank among the repo's most-churned files. Top 5 only. */
  churnRank: Map<string, number>
}

const INDEX = new WeakMap<AnalysisContext, TreeIndex>()

function isRegularFile(entry: TreeEntry): boolean {
  // Symlinks (120000) and submodule gitlinks (160000) are not content we can
  // measure; counting them would inflate file counts and directory sprawl.
  return entry.mode !== '120000' && entry.mode !== '160000'
}

function buildIndex(ctx: AnalysisContext): TreeIndex {
  const excludeRe = compileGlobs(ctx.settings.excludeGlobs)
  const generatedRe = compileGlobs(ctx.settings.generatedGlobs)

  const entryByPath = new Map<string, TreeEntry>()
  const livePaths = new Set<string>()
  const scored = new Set<string>()
  const sourcePaths: string[] = []
  const testPaths: string[] = []
  const sourceDirs = new Set<string>()

  for (const entry of ctx.tree) {
    entryByPath.set(entry.path, entry)
    livePaths.add(entry.path)
    if (!isRegularFile(entry)) continue
    const kind = ctx.kinds.get(entry.path) ?? 'unknown'
    if (EXCLUDED_KINDS.has(kind)) continue
    if (anyMatch(excludeRe, entry.path)) continue
    scored.add(entry.path)
    if (kind === 'source') {
      sourcePaths.push(entry.path)
      sourceDirs.add(dirOf(entry.path))
    } else if (kind === 'test') {
      testPaths.push(entry.path)
    }
  }

  const sprawlMembers = new Set<string>()
  for (const cluster of ctx.clusters) {
    if (cluster.members.length < CLUSTER_MIN_MEMBERS) continue
    for (const member of cluster.members) sprawlMembers.add(member)
  }

  // The repo-wide churn leaderboard. Computed over every path ever seen, not
  // just live ones: a doc that churned 68 times and was then deleted is still
  // evidence of documenting-instead-of-doing.
  const churnRank = new Map<string, number>()
  const ranked: FileStats[] = []
  for (const stats of ctx.fileStats.values()) {
    const kind = ctx.kinds.get(stats.path) ?? 'unknown'
    if (EXCLUDED_KINDS.has(kind)) continue
    if (anyMatch(excludeRe, stats.path)) continue
    ranked.push(stats)
  }
  ranked.sort((a, b) => b.commits - a.commits || a.path.localeCompare(b.path))
  for (let i = 0; i < Math.min(5, ranked.length); i++) {
    const row = ranked[i]
    if (row) churnRank.set(row.path, i + 1)
  }

  return {
    entryByPath,
    livePaths,
    scored,
    sourcePaths,
    testPaths,
    sprawlMembers,
    excludeRe,
    generatedRe,
    sourceDirs,
    churnRank
  }
}

function indexFor(ctx: AnalysisContext): TreeIndex {
  const cached = INDEX.get(ctx)
  if (cached) return cached
  const built = buildIndex(ctx)
  INDEX.set(ctx, built)
  return built
}

function kindOf(ctx: AnalysisContext, path: string): FileKind {
  return ctx.kinds.get(path) ?? 'unknown'
}

function blobFor(ctx: AnalysisContext, ix: TreeIndex, path: string): BlobAnalysis | undefined {
  const entry = ix.entryByPath.get(path)
  if (!entry) return undefined
  return ctx.blobs.get(entry.sha)
}

/** Lines in a live file, or 0 when the blob was never analysed. */
function linesOf(ctx: AnalysisContext, ix: TreeIndex, path: string): number {
  const blob = blobFor(ctx, ix, path)
  return blob && Number.isFinite(blob.lines) ? blob.lines : 0
}

/**
 * Whether a *historical* path counts for scoring. Signals that walk commits see
 * paths that no longer exist, so they cannot use the live `scored` set.
 */
function historicalPathCounts(ctx: AnalysisContext, ix: TreeIndex, path: string): boolean {
  if (EXCLUDED_KINDS.has(kindOf(ctx, path))) return false
  return !anyMatch(ix.excludeRe, path)
}

// ---------------------------------------------------------------------------
// 1. Sibling sprawl
// ---------------------------------------------------------------------------

function describeBasis(basis: SprawlCluster['basis']): string {
  switch (basis) {
    case 'name':
      return 'near-identical filenames'
    case 'content':
      return 'near-identical contents'
    default:
      return 'near-identical names and contents'
  }
}

/**
 * Share of live files sitting in a near-duplicate filename cluster.
 *
 * The clustering itself is done upstream (content/clusters.ts); this signal
 * only scores it. Cluster members are intersected with the scored set before
 * counting, so a cluster that reaches back into deleted or vendored paths
 * cannot push the numerator past the denominator.
 */
export const siblingSprawl: SignalComputer = {
  id: 'siblingSprawl',
  compute(ctx): SignalResult {
    const ix = indexFor(ctx)
    const total = ix.scored.size

    const live = ctx.clusters
      .map((cluster) => ({ cluster, members: cluster.members.filter((p) => ix.scored.has(p)) }))
      .filter((c) => c.members.length >= CLUSTER_MIN_MEMBERS)
      .sort(
        (a, b) => b.members.length - a.members.length || a.cluster.stem.localeCompare(b.cluster.stem)
      )

    const inCluster = new Set<string>()
    for (const c of live) for (const m of c.members) inCluster.add(m)

    const value = pct(inCluster.size, total)

    const drivers: SignalDriver[] = capDrivers(
      live.map(({ cluster, members }) => ({
        kind: 'cluster' as const,
        label: `${cluster.stem} — ${members.length} variants`,
        value: members.length,
        detail: `${describeBasis(cluster.basis)}, mean similarity ${fmt1(cluster.similarity * 100)}%`,
        members
      }))
    )

    const findings: RawFinding[] = live
      .filter((c) => c.members.length >= CLUSTER_FINDING_MEMBERS)
      .slice(0, FINDING_CAP)
      .map(({ cluster, members }) => ({
        title: `${members.length} near-duplicate files share the stem "${cluster.stem}"`,
        detail:
          `${members.length} live files differ only by a version, date or qualifier suffix ` +
          `(${describeBasis(cluster.basis)}, mean similarity ${fmt1(cluster.similarity * 100)}%): ` +
          `${members.slice(0, 8).join(', ')}${members.length > 8 ? `, and ${members.length - 8} more` : ''}. ` +
          `Each was written instead of editing the one before it, so nothing in the repository ` +
          `identifies which is current and which are abandoned drafts.`,
        paths: members,
        metric: { label: 'files in cluster', value: members.length, unit: 'files' as const },
        remediation:
          `Read all ${members.length} files listed above and decide which single file is authoritative. ` +
          `Merge any content that exists only in the others into it, then delete the others in one commit ` +
          `whose subject names the surviving file. Do not create a new "consolidated" file: that would ` +
          `leave ${members.length + 1} variants instead of ${members.length}.`
      }))

    const headline =
      total === 0
        ? 'No files to analyse.'
        : inCluster.size === 0
          ? `No near-duplicate filename clusters across ${fmtInt(total)} files.`
          : `${fmt1(value)}% of files (${fmtInt(inCluster.size)} of ${fmtInt(total)}) sit in ${fmtInt(live.length)} ` +
            `near-duplicate ${plural(live.length, 'cluster', 'clusters')}; the largest holds ${live[0]?.members.length ?? 0}.`

    return { value, headline, drivers, findings }
  }
}

// ---------------------------------------------------------------------------
// 2. God files
// ---------------------------------------------------------------------------

interface SizedFile {
  path: string
  lines: number
  blob: BlobAnalysis
}

/**
 * Share of *source lines* — not source files — living in files over 800 lines.
 *
 * Weighting by lines rather than by file count is deliberate: three 6,000-line
 * files out of a thousand is a much worse repository than three 850-line files
 * out of ten, and a file-count ratio cannot tell those apart.
 */
export const godFiles: SignalComputer = {
  id: 'godFiles',
  compute(ctx): SignalResult {
    const ix = indexFor(ctx)

    const sized: SizedFile[] = []
    let totalLines = 0
    for (const path of ix.sourcePaths) {
      const blob = blobFor(ctx, ix, path)
      if (!blob || !Number.isFinite(blob.lines)) continue
      totalLines += blob.lines
      sized.push({ path, lines: blob.lines, blob })
    }

    const god = sized.filter((f) => f.lines > GOD_FILE_LINES)
    god.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path))
    let godLines = 0
    for (const f of god) godLines += f.lines

    const value = pct(godLines, totalLines)

    const drivers: SignalDriver[] = capDrivers(
      god.map((f) => {
        const share = pct(f.lines, totalLines)
        const fnPart =
          f.blob.functions !== null && f.blob.functions > 0
            ? ` · ${fmtInt(f.blob.functions)} ${plural(f.blob.functions, 'function', 'functions')}`
            : ''
        return {
          kind: 'file' as const,
          path: f.path,
          label: `${f.path} — ${fmtInt(f.lines)} lines`,
          value: f.lines,
          detail: `${fmt1(share)}% of all source lines${fnPart}`
        }
      })
    )

    const findings: RawFinding[] = god
      .filter((f) => f.lines > GOD_FILE_FINDING_LINES)
      .slice(0, FINDING_CAP)
      .map((f) => ({
        title: `${f.path} is ${fmtInt(f.lines)} lines`,
        detail:
          `${f.path} holds ${fmtInt(f.lines)} lines, ${fmt1(pct(f.lines, totalLines))}% of all source lines in the repository` +
          `${f.blob.functions !== null ? ` across ${fmtInt(f.blob.functions)} functions` : ''}. ` +
          `A file this size cannot be reviewed in one sitting and does not fit comfortably in an agent's ` +
          `working context, so every future edit to it will be made without full sight of the rest.`,
        paths: [f.path],
        metric: { label: 'lines', value: f.lines, unit: 'lines' as const },
        remediation:
          `Split ${f.path} along its existing seams. Identify the groups of functions that share state or ` +
          `a single responsibility, move each group into its own module beside the original, and re-export ` +
          `from ${f.path} so callers keep working. Do this as a pure move with no behaviour change, ` +
          `in one commit per extracted module.`
      }))

    const largest = sized.reduce<SizedFile | null>(
      (best, f) => (best === null || f.lines > best.lines ? f : best),
      null
    )

    const headline =
      totalLines === 0
        ? 'No source lines found.'
        : god.length === 0
          ? `No source file exceeds ${GOD_FILE_LINES} lines` +
            (largest ? `; the largest is ${largest.path} at ${fmtInt(largest.lines)} lines.` : '.')
          : `${fmt1(value)}% of source lines sit in ${fmtInt(god.length)} ${plural(god.length, 'file', 'files')} ` +
            `over ${GOD_FILE_LINES} lines${largest ? ` (largest: ${largest.path}, ${fmtInt(largest.lines)} lines)` : ''}.`

    return { value, headline, drivers, findings }
  }
}

// ---------------------------------------------------------------------------
// 3. Write-once code
// ---------------------------------------------------------------------------

/**
 * Share of live source files committed exactly once and left alone since.
 *
 * The 14-day floor is what separates "written yesterday" from "written and
 * forgotten". Without it, a burst of new work would read as abandonment.
 */
export const writeOnce: SignalComputer = {
  id: 'writeOnce',
  compute(ctx): SignalResult {
    const ix = indexFor(ctx)
    const cutoff = ctx.now - WRITE_ONCE_MIN_AGE_DAYS * DAY_MS

    const hits: Array<{ path: string; stats: FileStats; ageDays: number }> = []
    for (const path of ix.sourcePaths) {
      const stats = ctx.fileStats.get(path)
      if (!stats || stats.commits !== 1) continue
      // A zero/absent timestamp means we could not date the file; treating it as
      // ancient would manufacture offenders, so it is skipped instead.
      if (!Number.isFinite(stats.firstAt) || stats.firstAt <= 0) continue
      if (stats.firstAt > cutoff) continue
      hits.push({ path, stats, ageDays: daysBetween(stats.firstAt, ctx.now) })
    }

    const total = ix.sourcePaths.length
    const value = pct(hits.length, total)

    hits.sort((a, b) => a.stats.firstAt - b.stats.firstAt || a.path.localeCompare(b.path))

    const drivers: SignalDriver[] = capDrivers(
      hits.map((h) => {
        const lines = linesOf(ctx, ix, h.path)
        return {
          kind: 'file' as const,
          path: h.path,
          label: `${h.path} — 1 commit, ${fmtInt(h.ageDays)} days ago`,
          value: round(h.ageDays, 1),
          detail: lines > 0 ? `${fmtInt(lines)} lines, never revisited` : 'never revisited'
        }
      })
    )

    const oldest = hits[0]
    const headline =
      total === 0
        ? 'No source files found.'
        : hits.length === 0
          ? `Every source file older than ${WRITE_ONCE_MIN_AGE_DAYS} days has been revisited at least once.`
          : `${fmt1(value)}% of source files (${fmtInt(hits.length)} of ${fmtInt(total)}) were committed once and ` +
            `never touched again${oldest ? `; the oldest landed ${fmtInt(oldest.ageDays)} days ago.` : '.'}`

    return { value, headline, drivers }
  }
}

// ---------------------------------------------------------------------------
// 4. Complexity drift
// ---------------------------------------------------------------------------

/**
 * Share of parsed functions above cyclomatic complexity 10.
 *
 * Counted per live source *file*, not per distinct blob: two paths holding
 * identical content are two files a maintainer has to read, and the duplication
 * is itself part of the problem. Files whose language has no parser contribute
 * nothing in either direction rather than being scored as simple.
 */
export const complexityDrift: SignalComputer = {
  id: 'complexityDrift',
  compute(ctx): SignalResult {
    const ix = indexFor(ctx)

    let functions = 0
    let complex = 0
    let parsedFiles = 0
    const worst: Array<{ path: string; blob: BlobAnalysis }> = []

    for (const path of ix.sourcePaths) {
      const blob = blobFor(ctx, ix, path)
      if (!blob || blob.functions === null) continue
      parsedFiles++
      functions += blob.functions
      complex += blob.complexFunctions ?? 0
      if (blob.maxComplexity !== null && blob.maxComplexity > COMPLEXITY_LIMIT) {
        worst.push({ path, blob })
      }
    }

    const value = functions === 0 ? 0 : pct(complex, functions)

    worst.sort(
      (a, b) =>
        (b.blob.maxComplexity ?? 0) - (a.blob.maxComplexity ?? 0) ||
        (b.blob.complexFunctions ?? 0) - (a.blob.complexFunctions ?? 0) ||
        a.path.localeCompare(b.path)
    )

    const drivers: SignalDriver[] = capDrivers(
      worst.map(({ path, blob }) => {
        const max = blob.maxComplexity ?? 0
        const cf = blob.complexFunctions ?? 0
        const fn = blob.functions ?? 0
        return {
          kind: 'file' as const,
          path,
          label: `${path} — max cc ${fmtInt(max)}`,
          value: max,
          detail: `${fmtInt(cf)} of ${fmtInt(fn)} ${plural(fn, 'function', 'functions')} above cc ${COMPLEXITY_LIMIT}`
        }
      })
    )

    const headline =
      functions === 0
        ? parsedFiles === 0
          ? 'No source files in a supported language were parsed.'
          : 'No functions were found in the parsed source files.'
        : complex === 0
          ? `None of the ${fmtInt(functions)} parsed functions exceeds cyclomatic complexity ${COMPLEXITY_LIMIT}.`
          : `${fmt1(value)}% of parsed functions (${fmtInt(complex)} of ${fmtInt(functions)}) exceed cyclomatic ` +
            `complexity ${COMPLEXITY_LIMIT}.`

    return { value, headline, drivers }
  }
}

// ---------------------------------------------------------------------------
// 5. Doc bloat
// ---------------------------------------------------------------------------

/**
 * Share of file-changes in the scoring window that landed on documentation.
 *
 * Measured in file-touches rather than lines because a doc commit is cheap in
 * lines and expensive in attention: the question is how much of the project's
 * *activity* went into prose, not how many words it produced. Excluded kinds
 * (lockfiles, vendored trees, assets) are removed from both sides so a noisy
 * lockfile cannot dilute the ratio.
 */
export const docBloat: SignalComputer = {
  id: 'docBloat',
  compute(ctx): SignalResult {
    const ix = indexFor(ctx)

    let docTouches = 0
    let totalTouches = 0
    const windowChurn = new Map<string, number>()

    for (const commit of ctx.window) {
      if (commit.isMerge) continue
      // A commit can list the same path twice (a rename plus a modification);
      // counting it twice would over-weight whichever side it landed on.
      const seen = new Set<string>()
      for (const change of commit.files) {
        const path = change.path
        if (seen.has(path)) continue
        seen.add(path)
        if (!historicalPathCounts(ctx, ix, path)) continue
        totalTouches++
        if (kindOf(ctx, path) === 'doc') {
          docTouches++
          windowChurn.set(path, (windowChurn.get(path) ?? 0) + 1)
        }
      }
    }

    const value = pct(docTouches, totalTouches)

    const churned = [...windowChurn.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

    const drivers: SignalDriver[] = capDrivers(
      churned.map(([path, commits]) => {
        const stats = ctx.fileStats.get(path)
        const allTime = stats?.commits ?? commits
        return {
          kind: 'file' as const,
          path,
          label: `${path} — ${fmtInt(commits)} ${plural(commits, 'commit', 'commits')}`,
          value: commits,
          detail: `${fmtInt(allTime)} ${plural(allTime, 'commit', 'commits')} all-time`
        }
      })
    )

    // The pattern worth naming: a doc file that out-churns the source. If a
    // document is one of the five most-edited files in the whole repository,
    // the project has been producing narrative about the work rather than work.
    const findings: RawFinding[] = []
    for (const [path, rank] of ix.churnRank) {
      if (kindOf(ctx, path) !== 'doc') continue
      const stats = ctx.fileStats.get(path)
      const commits = stats?.commits ?? 0
      const alive = ix.livePaths.has(path)
      findings.push({
        title:
          rank === 1
            ? `${path} is the single most-churned file in the repository`
            : `${path} is the #${rank} most-churned file in the repository`,
        detail:
          `${path} has been rewritten across ${fmtInt(commits)} commits, placing it #${rank} out of every file ` +
          `in the repository — above ${rank === 1 ? 'every' : 'almost every'} source file. ` +
          `Documentation that changes harder than the code it describes is a record of intent, not of work` +
          `${alive ? '' : ' (the file has since been deleted, so the effort left nothing behind)'}.`,
        paths: [path],
        metric: { label: 'commits', value: commits, unit: 'count' as const },
        remediation:
          `Stop editing ${path} as a progress log. Read it, extract the statements that are still true and ` +
          `that belong in the code as comments, docstrings or tests, and apply them there. Then reduce ` +
          `${path} to the durable subset and leave it alone; if it is a status or planning document, delete it.`
      })
      if (findings.length >= FINDING_CAP) break
    }

    const topDoc = churned[0]
    const headline =
      totalTouches === 0
        ? `No file changes in the last ${fmtInt(ctx.windowDays)} days.`
        : docTouches === 0
          ? `None of the ${fmtInt(totalTouches)} file changes in the last ${fmtInt(ctx.windowDays)} days touched documentation.`
          : `${fmt1(value)}% of file changes in the last ${fmtInt(ctx.windowDays)} days landed on docs ` +
            `(${fmtInt(docTouches)} of ${fmtInt(totalTouches)})` +
            `${topDoc ? `; ${topDoc[0]} alone took ${fmtInt(topDoc[1])}.` : '.'}`

    return { value, headline, drivers, findings }
  }
}

// ---------------------------------------------------------------------------
// 6. Test deficit
// ---------------------------------------------------------------------------

interface DirRatio {
  dir: string
  sourceLines: number
  testLines: number
}

/**
 * Maps a test directory onto the source directory it mirrors.
 *
 * Co-located tests need no help — `src/a/b.test.ts` already lands in `src/a`.
 * A parallel tree does: without this, every repository that keeps its tests in
 * a top-level `tests/` would show a local ratio of zero for every source
 * directory and the driver list would degenerate into "the biggest directories".
 * Credit is added to the mirror in addition to the test directory's own subtree,
 * never moved, so the arithmetic stays monotone.
 */
function mirrorSourceDirs(dir: string, sourceDirs: ReadonlySet<string>): string[] {
  const segments = dir.split('/')
  if (!segments.some((s) => TEST_DIR_SEGMENT.test(s))) return []
  const base = segments.filter((s) => !TEST_DIR_SEGMENT.test(s)).join('/')
  const candidates =
    base === '' ? ['src', 'lib', 'app'] : [base, `src/${base}`, `lib/${base}`, `app/${base}`]
  const out: string[] = []
  for (const candidate of candidates) {
    if (candidate !== '' && sourceDirs.has(candidate) && !out.includes(candidate)) out.push(candidate)
  }
  return out
}

/**
 * Shortfall against a 0.4 test-to-source LINE ratio.
 *
 * Scored as a shortfall so that, like every other tile, higher is worse — and
 * so a well-tested repository reads as a clean zero. This is the one signal in
 * the panel that can report good news, and it says so plainly when it can. A
 * panel where every tile always scolds is a panel nobody believes.
 */
export const testDeficit: SignalComputer = {
  id: 'testDeficit',
  compute(ctx): SignalResult {
    const ix = indexFor(ctx)

    let sourceLines = 0
    let testLines = 0

    // Subtree totals: each file's lines are credited to every ancestor
    // directory, so a directory's ratio describes everything beneath it.
    const perDir = new Map<string, DirRatio>()
    const bump = (dir: string, source: number, test: number): void => {
      const row = perDir.get(dir)
      if (row) {
        row.sourceLines += source
        row.testLines += test
      } else {
        perDir.set(dir, { dir, sourceLines: source, testLines: test })
      }
    }

    for (const path of ix.scored) {
      const kind = kindOf(ctx, path)
      if (kind !== 'source' && kind !== 'test') continue
      const lines = linesOf(ctx, ix, path)
      if (lines <= 0) continue
      const isTest = kind === 'test'
      if (isTest) testLines += lines
      else sourceLines += lines

      for (const ancestor of ancestorsOf(path)) bump(ancestor, isTest ? 0 : lines, isTest ? lines : 0)

      if (isTest) {
        for (const mirror of mirrorSourceDirs(dirOf(path), ix.sourceDirs)) {
          bump(mirror, 0, lines)
          for (const ancestor of ancestorsOf(mirror)) bump(ancestor, 0, lines)
        }
      }
    }

    const ratio = sourceLines > 0 ? testLines / sourceLines : null
    const value =
      ratio === null ? 0 : round(Math.min(100, Math.max(0, 100 * (1 - ratio / TEST_RATIO_TARGET))), 2)

    // Turning per-directory ratios into a driver list that a reader can trust
    // takes two prunes. Nothing in a line count says which source a test file
    // exercises, so the rules below are about reporting at a granularity where
    // the claim is defensible rather than pretending to a precision we lack.
    //
    //  1. Report the SHALLOWEST directories that fall below the target, not the
    //     deepest. A deep row ("codecs/ has no tests in it") is usually an
    //     artefact of where files were filed; the shallowest failing directory
    //     is the region a maintainer would actually go and fix, and it collapses
    //     a package's worth of leaf rows into one.
    //  2. Drop a directory when the *package* enclosing it is properly tested —
    //     the `pkg/src/...` beside `pkg/tests/...` layout, where the source
    //     folder's own ratio is zero only because the tests are next door.
    //     See enclosingPackage() for how that boundary is found.
    const candidates = [...perDir.values()].filter((d) => d.sourceLines >= DIR_MIN_SOURCE_LINES)
    const byDir = new Map(candidates.map((d) => [d.dir, d]))

    const failing = candidates.filter((d) => d.testLines / d.sourceLines < TEST_RATIO_TARGET)
    const failingDirs = new Set(failing.map((d) => d.dir))
    const shallowest = failing.filter((d) => !ancestorsOf(d.dir).some((a) => failingDirs.has(a)))

    /**
     * Walks up from a candidate looking for the directory that behaves like its
     * package — the ancestor that is essentially "this directory plus its test
     * folder". Two conditions define it: the ancestor holds test lines the
     * candidate does not (so tests really are sitting beside it), and the
     * candidate accounts for most of the ancestor's source (so the ancestor is
     * not a monorepo container whose other packages are carrying the average).
     * That second condition is what stops one well-tested corner of a monorepo
     * from excusing every untested package beneath it.
     */
    const PACKAGE_DOMINANCE = 0.75
    const enclosingPackage = (d: DirRatio): DirRatio | null => {
      let cur = dirOf(d.dir)
      while (cur !== '') {
        const ancestor = byDir.get(cur)
        if (
          ancestor &&
          ancestor.testLines > d.testLines &&
          d.sourceLines >= ancestor.sourceLines * PACKAGE_DOMINANCE
        ) {
          return ancestor
        }
        cur = dirOf(cur)
      }
      return null
    }

    const scoredDirs = shallowest
      .filter((d) => {
        const pkg = enclosingPackage(d)
        return pkg === null || pkg.testLines / pkg.sourceLines < TEST_RATIO_TARGET
      })
      .map((d) => {
        const r = d.testLines / d.sourceLines
        return {
          ...d,
          ratio: r,
          shortfall: round(Math.min(100, Math.max(0, 100 * (1 - r / TEST_RATIO_TARGET))), 2)
        }
      })
    scoredDirs.sort((a, b) => b.shortfall - a.shortfall || b.sourceLines - a.sourceLines || a.dir.localeCompare(b.dir))

    const drivers: SignalDriver[] = capDrivers(
      scoredDirs.map((d) => ({
        kind: 'directory' as const,
        path: d.dir,
        label: `${d.dir} — ${fmt2(d.ratio)} test lines per source line`,
        value: d.shortfall,
        detail: `${fmtInt(d.sourceLines)} source lines vs ${fmtInt(d.testLines)} test lines`
      }))
    )

    // Even a healthy repo usually has a corner with nothing behind it. Saying so
    // in the same breath as the good news is what keeps the tile honest: a
    // headline that only ever praises is as useless as one that only ever scolds.
    const gaps = scoredDirs.length

    let headline: string
    if (ratio === null) {
      headline = 'No source lines found, so there is nothing to test.'
    } else if (ratio >= TEST_RATIO_TARGET) {
      headline =
        `Healthy: ${fmtInt(testLines)} test lines to ${fmtInt(sourceLines)} source lines — a ratio of ` +
        `${fmt2(ratio)}, at or above the ${fmt2(TEST_RATIO_TARGET)} target. No deficit` +
        (gaps > 0
          ? `, though ${fmtInt(gaps)} ${plural(gaps, 'directory', 'directories')} below still ${plural(gaps, 'falls', 'fall')} short.`
          : ' anywhere in the tree.')
    } else if (testLines === 0) {
      headline = `No test files at all against ${fmtInt(sourceLines)} source lines.`
    } else {
      headline =
        `${fmt2(ratio)} test lines per source line against a ${fmt2(TEST_RATIO_TARGET)} target — ` +
        `${fmt1(value)}% short. ${fmtInt(Math.round(sourceLines * TEST_RATIO_TARGET - testLines))} more test lines would close it.`
    }

    return { value, headline, drivers }
  }
}

// ---------------------------------------------------------------------------
// 7. Directory sprawl
// ---------------------------------------------------------------------------

/**
 * Share of directories holding fewer than three files.
 *
 * `ctx.dirFileCounts` counts *immediate child files*, so a pure container
 * directory such as `src/` counts as thin even though it is legitimate
 * structure. That is intentional — the driver rows report how many
 * subdirectories a thin directory has, so a reader can tell a container from a
 * landfill — but it does mean this signal inherits its denominator from
 * whatever the tree walker chose to put in the map. Whether container
 * directories appear as zero-count keys moves the specimen between roughly 38%
 * (they do) and 20% (they do not), which crosses two threshold bands, so the
 * two sides must agree. The calibration in signals.ts counts them.
 */
export const directorySprawl: SignalComputer = {
  id: 'directorySprawl',
  compute(ctx): SignalResult {
    const ix = indexFor(ctx)

    // Immediate child-directory counts, derived from the key set so the drivers
    // can distinguish "empty leaf" from "container that holds only folders".
    const childDirs = new Map<string, number>()
    for (const dir of ctx.dirFileCounts.keys()) {
      if (dir === '') continue
      const parent = dirOf(dir)
      if (parent === '') continue
      childDirs.set(parent, (childDirs.get(parent) ?? 0) + 1)
    }

    const dirs: Array<{ dir: string; files: number; subdirs: number; depth: number }> = []
    for (const [dir, files] of ctx.dirFileCounts) {
      if (dir === '' || dir === '.') continue // the repo root is not sprawl
      if (anyMatch(ix.excludeRe, dir)) continue
      dirs.push({ dir, files, subdirs: childDirs.get(dir) ?? 0, depth: depthOf(dir) })
    }

    const thin = dirs.filter((d) => d.files < DIR_SPRAWL_MIN_FILES)
    const value = pct(thin.length, dirs.length)

    // Emptiest first; among equally empty directories, the deepest and most
    // isolated ones are the ones actually costing a reader navigation.
    thin.sort(
      (a, b) => a.files - b.files || a.subdirs - b.subdirs || b.depth - a.depth || a.dir.localeCompare(b.dir)
    )

    const drivers: SignalDriver[] = capDrivers(
      thin.map((d) => ({
        kind: 'directory' as const,
        path: d.dir,
        label: `${d.dir} — ${fmtInt(d.files)} ${plural(d.files, 'file', 'files')}`,
        value: d.files,
        detail:
          d.subdirs > 0
            ? `depth ${d.depth}, ${fmtInt(d.subdirs)} ${plural(d.subdirs, 'subdirectory', 'subdirectories')}`
            : `depth ${d.depth}, no subdirectories`
      }))
    )

    const maxDepth = dirs.reduce((m, d) => (d.depth > m ? d.depth : m), 0)
    const headline =
      dirs.length === 0
        ? 'The repository has no subdirectories.'
        : thin.length === 0
          ? `Every one of the ${fmtInt(dirs.length)} directories holds at least ${DIR_SPRAWL_MIN_FILES} files.`
          : `${fmt1(value)}% of directories (${fmtInt(thin.length)} of ${fmtInt(dirs.length)}) hold fewer than ` +
            `${DIR_SPRAWL_MIN_FILES} files, across a tree ${fmtInt(maxDepth)} levels deep.`

    return { value, headline, drivers }
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** The seven tree-shaped signals, in panel order. */
export const treeSignals: SignalComputer[] = [
  siblingSprawl,
  godFiles,
  writeOnce,
  complexityDrift,
  docBloat,
  testDeficit,
  directorySprawl
]

// ---------------------------------------------------------------------------
// Per-file flags for the Map view
// ---------------------------------------------------------------------------

function isBinaryByExtension(path: string): boolean {
  return BINARY_EXT.has(extOf(path))
}

/**
 * The FileFlag vocabulary applied to one path.
 *
 * Flags are badges on a Map node, so they must be cheap and they must never
 * contradict the tiles: 'god-file' uses the same 800-line boundary as godFiles,
 * 'write-once' the same 14-day floor as writeOnce, and 'sibling-sprawl' the same
 * three-member minimum as siblingSprawl. Returned in the order the FileFlag
 * union declares them, so a legend can rely on stable ordering.
 */
export function computeFileFlags(path: string, ctx: AnalysisContext): FileFlag[] {
  const ix = indexFor(ctx)
  const blob = blobFor(ctx, ix, path)
  const stats = ctx.fileStats.get(path)
  const kind = kindOf(ctx, path)
  const flags: FileFlag[] = []

  if (blob && Number.isFinite(blob.lines) && blob.lines > GOD_FILE_LINES) flags.push('god-file')

  if (
    stats &&
    stats.commits === 1 &&
    Number.isFinite(stats.firstAt) &&
    stats.firstAt > 0 &&
    ctx.now - stats.firstAt > WRITE_ONCE_MIN_AGE_DAYS * DAY_MS
  ) {
    flags.push('write-once')
  }

  if (stats && stats.added >= REWORK_MIN_ADDED && stats.deleted / Math.max(1, stats.added) >= REWORK_RATIO) {
    flags.push('high-rework')
  }

  if (
    stats &&
    Number.isFinite(stats.lastAt) &&
    stats.lastAt > 0 &&
    ctx.now - stats.lastAt > STALE_DAYS * DAY_MS
  ) {
    flags.push('stale')
  }

  if (ix.sprawlMembers.has(path)) flags.push('sibling-sprawl')

  if (kind === 'generated' || anyMatch(ix.generatedRe, path)) flags.push('generated')

  // Blobs are only analysed for non-excluded entries, so assets and vendored
  // binaries never get one; fall back to the extension for those.
  if (blob ? blob.binary : isBinaryByExtension(path)) flags.push('binary')

  if (kind === 'vendored' || VENDOR_SEGMENT.test(path)) flags.push('vendored')

  return flags
}

// ---------------------------------------------------------------------------
// Risk — the Map view's colour ramp
// ---------------------------------------------------------------------------

/**
 * Logarithmic 0–1 normalisation with a soft knee.
 *
 * `scale` sets where the curve is steep (small values still separate) and `cap`
 * is where it saturates at 1. Linear normalisation would put 95% of a
 * repository's files in the bottom decile of the ramp and waste the colour
 * scale; log spreads the mass where the files actually are.
 */
function logNorm(x: number, scale: number, cap: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0
  return clamp01(Math.log2(1 + x / scale) / Math.log2(1 + cap / scale))
}

/** Weights for the five risk terms. Sum to 1 so risk is genuinely 0–1. */
const RISK_W_SIZE = 0.28
const RISK_W_REWORK = 0.22
const RISK_W_CHURN = 0.18
const RISK_W_COMPLEXITY = 0.17
const RISK_W_STALENESS = 0.15

/**
 * Files nobody wrote get their risk pushed down rather than removed. A
 * 6,000-line generated schema would otherwise be the brightest thing on the
 * Map, which is true but useless — it drowns out the files a human can act on.
 */
const RISK_DAMP_NOT_OURS = 0.4

/**
 * Risk score for one file, 0–1, driving the Map's sequential colour ramp.
 *
 * THE FORMULA — this is the answer to "what does the colour mean?":
 *
 *   risk = damp × ( 0.28·size + 0.22·rework + 0.18·churn + 0.17·complexity + 0.15·stale )
 *
 *   size       log-normalised line count, saturating at 1,600 lines
 *              (an 800-line file scores ~0.79; a 100-line file ~0.28)
 *   rework     (deleted ÷ added), clamped to 1, damped by a volume ramp that
 *              reaches full weight at 200 added lines — the same 200-line floor
 *              the 'high-rework' flag uses, so the badge and the colour agree
 *   churn      log-normalised commit count, saturating at 60 commits
 *   complexity log-normalised maximum cyclomatic complexity in the file,
 *              saturating at cc 40 (cc 10 — the "complex function" line —
 *              scores 0.5). Unparsed languages contribute 0 rather than being
 *              guessed at
 *   stale      days since the last commit ÷ 180, clamped
 *   damp       0.4 for generated, vendored, binary and otherwise-excluded
 *              files, 1.0 for code the team actually wrote
 *
 * Both tails of activity are penalised on purpose: a file that churns
 * constantly is one the agent keeps circling, and a file that has not been
 * touched in six months is one nobody dares open. They are different
 * pathologies and the Map should show both.
 *
 * The function is monotonic non-decreasing in each of the five terms, so a file
 * can never get safer by growing, being rewritten more, or ageing — which is
 * what makes the colour comparable between two snapshots of the same repo.
 */
export function computeRisk(path: string, ctx: AnalysisContext): number {
  const ix = indexFor(ctx)
  const blob = blobFor(ctx, ix, path)
  const stats = ctx.fileStats.get(path)
  if (!blob && !stats) return 0

  const lines = blob && Number.isFinite(blob.lines) ? blob.lines : 0
  const added = stats?.added ?? 0
  const deleted = stats?.deleted ?? 0
  const commits = stats?.commits ?? 0
  const maxComplexity = blob?.maxComplexity ?? 0

  const size = logNorm(lines, 80, 1600)

  // Volume ramp: ten lines rewritten is noise, two hundred is a rewrite.
  const reworkRatio = added > 0 ? clamp01(deleted / added) : 0
  const rework = reworkRatio * clamp01(added / REWORK_MIN_ADDED)

  const churn = logNorm(commits, 3, 60)
  const complexity = logNorm(maxComplexity, 5, 40)

  const lastAt = stats && Number.isFinite(stats.lastAt) && stats.lastAt > 0 ? stats.lastAt : ctx.now
  const stale = clamp01(daysBetween(lastAt, ctx.now) / STALE_DAYS)

  const raw =
    RISK_W_SIZE * size +
    RISK_W_REWORK * rework +
    RISK_W_CHURN * churn +
    RISK_W_COMPLEXITY * complexity +
    RISK_W_STALENESS * stale

  const kind = kindOf(ctx, path)
  const notOurs =
    EXCLUDED_KINDS.has(kind) ||
    anyMatch(ix.generatedRe, path) ||
    anyMatch(ix.excludeRe, path) ||
    VENDOR_SEGMENT.test(path) ||
    (blob ? blob.binary : isBinaryByExtension(path))

  return round(clamp01(raw) * (notOurs ? RISK_DAMP_NOT_OURS : 1), 3)
}
