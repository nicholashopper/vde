/**
 * Sibling sprawl — near-duplicate file clustering.
 *
 * This is the mechanism behind VDE's signature signal. It finds the canonical
 * agent failure mode: writing `report-final.md`, then `report-final-2.md`, then
 * `report-final-v3.md`, instead of editing one file. Each artefact is
 * individually defensible; the pile is landfill, and nothing else in a normal
 * toolchain will ever mention it.
 *
 * Two independent mechanisms, unioned:
 *
 *   (a) NAME similarity. Filenames are normalised — extension stripped,
 *       camelCase split, lowercased, tokenised on [-_.@~ ], and stripped of
 *       "version-ish" tokens. Two files in the SAME DIRECTORY cluster when
 *       their normalised token sets are equal or their Jaccard similarity
 *       clears `nameThreshold` (0.7).
 *
 *   (b) CONTENT similarity. Two files in the same directory cluster when
 *       their 64-bit SimHashes are within `contentThreshold` (0.85), i.e. a
 *       Hamming distance of at most 9 bits. This catches copy-paste-with-a-
 *       tweak, where the agent renamed the file properly but duplicated the
 *       body.
 *
 * Clustering is single-linkage (union-find over the qualifying pair graph).
 * That is deliberate: the real specimen contains
 *
 *     enhance-2-bluewater-clean-final-reproof.md
 *     enhance-2-bluewater-final-root-reproof.md
 *     enhance-2-bluewater-reproof.md
 *
 * where the first and second are only 0.6 similar to each other but both are
 * 0.75 similar to the third. A human reads all three as one pile, and
 * single-linkage is what reproduces that judgement.
 *
 * Chaining is what makes single-linkage dangerous, so it is fenced in three
 * ways: every edge is confined to one directory, one file extension, and one
 * *facet* (a module never meets its own test file, nor another module's).
 * Without the facet fence the specimen produced `Widget.tsx` +
 * `Widget.test.tsx` + `OtherWidget.test.tsx` as a cluster, which is three
 * correct files and no finding.
 *
 * DIRECTORY SCOPING IS LOAD-BEARING. `src/user/index.ts` and
 * `src/order/index.ts` are the same file by name and often near-identical by
 * content, and they are completely correct. Only siblings can sprawl.
 *
 * ON FALSE POSITIVES. A false positive here tells a user to delete something
 * they need, so every exclusion below is deliberate and documented. When in
 * doubt this module stays quiet: a missed cluster costs nothing, a wrong one
 * costs trust.
 */

import { EXCLUDED_KINDS } from '../model'
import type { FileKind, SprawlCluster } from '../model'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ClusterOptions {
  /**
   * repo-relative path → kind. Paths whose kind is in EXCLUDED_KINDS
   * (generated / vendored / asset / data) never participate. Unknown paths are
   * kept: absence of classification is not evidence of exclusion.
   */
  kinds?: ReadonlyMap<string, FileKind>
  /**
   * repo-relative path → line count. Used only to suppress content-similarity
   * edges between trivially small files, whose SimHashes collide for reasons
   * that have nothing to do with duplication. Omit to disable the guard.
   */
  lines?: ReadonlyMap<string, number>
  /** Caller-supplied veto, e.g. Settings.excludeGlobs. */
  isExcluded?: (path: string) => boolean
  /** Jaccard floor for a name edge. Default 0.7. */
  nameThreshold?: number
  /** SimHash similarity floor for a content edge. Default 0.85. */
  contentThreshold?: number
  /** Clusters smaller than this are dropped. Default 3. */
  minMembers?: number
  /** Files below this many lines cannot form content edges. Default 20. */
  minContentLines?: number
  /**
   * Above this many files in one directory+extension bucket, only the cheap
   * exact-normalised-stem path runs. Guards against a pathological directory
   * turning an O(n²) comparison into a hang. Default 4000.
   */
  maxBucketFiles?: number
}

export interface ResolvedClusterOptions {
  nameThreshold: number
  contentThreshold: number
  minMembers: number
  minContentLines: number
  maxBucketFiles: number
}

export const DEFAULT_CLUSTER_OPTIONS: ResolvedClusterOptions = {
  nameThreshold: 0.7,
  contentThreshold: 0.85,
  // Two siblings are normal and healthy: index.ts and index.test.ts, a module
  // and its types. Three is where a pattern starts.
  minMembers: 3,
  minContentLines: 20,
  maxBucketFiles: 4000
}

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

/**
 * Tokens that carry no identity — they mark a revision of something else.
 * Removing them is what collapses `report-final.md` and `report.md` onto the
 * same stem.
 *
 * Deliberately absent: `test`, `spec`, `e2e`, `mock`, `stub` (they name a
 * distinct artefact, not a revision of one); `part`, `no`, `pt` (ordinary
 * English words that appear in real identifiers such as `body-part`).
 */
const VERSION_WORDS: ReadonlySet<string> = new Set([
  'final',
  'finals',
  'latest',
  'current',
  'new',
  'newer',
  'newest',
  'old',
  'older',
  'oldest',
  'prev',
  'previous',
  'copy',
  'copies',
  'dup',
  'duplicate',
  'clone',
  'fix',
  'fixed',
  'update',
  'updated',
  'revise',
  'revised',
  'revision',
  'draft',
  'drafts',
  'wip',
  'tmp',
  'temp',
  'temporary',
  'backup',
  'bak',
  'orig',
  'original',
  'v',
  'ver',
  'version',
  'rev',
  'really',
  'actual',
  'actually'
])

/**
 * Letter-prefixed ordinals: `v2`, `p3`, `rev4`. Kept tight on purpose —
 * `f26`, `e8`, `h1` are identifiers in the wild, not version markers.
 *
 * These are only honoured in SUFFIX position (see {@link analyseName}). A
 * version marker is appended to an otherwise complete name, so `ashgrove-p3`
 * is a revision of `ashgrove` — whereas in `lane-P1-specs` the `P1` is a field
 * in a naming scheme and `lane-P2-specs` is a different document, not a newer
 * one. Observed both ways in the specimen.
 */
const VERSION_ORDINAL = /^(?:v|ver|version|rev|revision|p|pt)\d+$/

const BARE_DIGITS = /^\d+$/

/**
 * Markers that name a *companion* artefact rather than a revision. Files whose
 * facets differ are never compared: `index.ts` and `index.test.ts` are the
 * healthy case the whole signal must not fire on, and `Widget.tsx` beside
 * `Widget.test.tsx` must not chain into `OtherWidget.test.tsx`.
 *
 * A word only counts as a facet when it is attached with a dot or underscore
 * in the position the convention puts it — `Widget.test.tsx`, `handler_test.go`,
 * `test_handler.py`. Hyphenated, it is just a word: the specimen's
 * `lane-P1-specs.md` is a specification document, not a spec file, and losing
 * that distinction merged three separate work lanes into one bogus cluster.
 */
const FACET_TOKENS: ReadonlySet<string> = new Set([
  'test',
  'tests',
  'spec',
  'specs',
  'e2e',
  'story',
  'stories',
  'bench',
  'benchmark',
  'mock',
  'mocks',
  'stub',
  'stubs',
  'snap',
  'min',
  'map',
  // `.d.ts` declaration files.
  'd'
])

/** Splits a trailing numeric run off a token: `surface2` → ['surface', '2']. */
const TRAILING_DIGITS = /^(.+?)(\d+)$/

/**
 * Trailing digits are only a version marker when what precedes them is a real
 * word and the number is small. Without both guards `sha256.ts`, `crc32.ts`
 * and `base64.ts` all normalise to their prefix and cluster with each other —
 * a false positive that would tell someone to delete their hash functions.
 */
const MIN_STEM_BEFORE_DIGITS = 4
const MAX_ORDINAL_VALUE = 20

/** Splits a basename into stem and lowercased final extension (with dot). */
export function splitExtension(basename: string): { stem: string; ext: string } {
  const dot = basename.lastIndexOf('.')
  // A leading dot is a dotfile marker (`.gitignore`), not an extension.
  if (dot <= 0) return { stem: basename, ext: '' }
  return { stem: basename.slice(0, dot), ext: basename.slice(dot).toLowerCase() }
}

/**
 * Splits camelCase and PascalCase runs so `UserServiceV2` tokenises the same
 * way `user-service-v2` does. Letter→digit boundaries are deliberately NOT
 * split; that is handled by the guarded trailing-digit rule instead, so
 * `sha256` survives as one token.
 */
function splitCamel(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
}

/** `@` and `~` are version/scope punctuation in filenames (`prompt@v3.md`). */
const TOKEN_SEPARATOR_CHAR = /[-_.\s@~]/

/** Separators that attach a facet marker to the name it belongs to. */
const FACET_SEPARATOR = /[._]/

interface RawToken {
  text: string
  /** The separator character immediately preceding it; '' for the first. */
  sep: string
}

/**
 * Tokenises a stem while remembering how each token was attached, because
 * `foo.test` and `foo-test` mean different things.
 */
function tokeniseDetailed(stem: string): RawToken[] {
  const expanded = splitCamel(stem).toLowerCase()
  const out: RawToken[] = []
  let i = 0
  let sep = ''
  while (i < expanded.length) {
    if (TOKEN_SEPARATOR_CHAR.test(expanded[i] ?? '')) {
      // On a run of separators the last one wins; `foo._test` is dot-attached.
      sep = expanded[i] ?? ''
      i += 1
      continue
    }
    let j = i
    while (j < expanded.length && !TOKEN_SEPARATOR_CHAR.test(expanded[j] ?? '')) j += 1
    out.push({ text: expanded.slice(i, j), sep })
    sep = ''
    i = j
  }
  return out
}

/** Raw tokens: case-folded, split on separators and case boundaries. */
export function tokenise(stem: string): string[] {
  return tokeniseDetailed(stem).map((t) => t.text)
}

/**
 * True when `tokens[i]` sits where a facet marker conventionally sits: last and
 * dot- or underscore-attached (`Widget.test`, `handler_test`), or first and
 * underscore-leading (`test_handler`, the Python convention). A stem that is
 * nothing but a facet word — `test.ts` — is left alone, since stripping it
 * would leave no name at all.
 */
function isFacetAt(tokens: readonly RawToken[], i: number): boolean {
  const token = tokens[i]
  if (!token || !FACET_TOKENS.has(token.text)) return false
  if (tokens.length < 2) return false
  if (i === tokens.length - 1 && i > 0) return FACET_SEPARATOR.test(token.sep)
  if (i === 0) return (tokens[1]?.sep ?? '') === '_'
  return false
}

/** Strips a small trailing ordinal off a token: `surface2` → `surface`. */
function stripTrailingOrdinal(token: string): string | null {
  const m = TRAILING_DIGITS.exec(token)
  if (!m) return null
  // The lazy quantifier guarantees m[2] is the entire trailing digit run, so
  // m[1] never itself ends in a digit.
  const head = m[1] ?? ''
  const digits = m[2] ?? ''
  if (head.length < MIN_STEM_BEFORE_DIGITS) return null
  if (Number(digits) > MAX_ORDINAL_VALUE) return null
  return head
}

export interface NameAnalysis {
  /** Tokens as written, in order. Used to label a cluster. */
  raw: string[]
  /** Comparison tokens: raw minus revision markers and facet markers. */
  tokens: Set<string>
  /**
   * Companion-artefact markers, sorted. Two files are only ever compared when
   * these are equal.
   */
  facets: string[]
}

/**
 * Normalises a filename stem for comparison.
 *
 * Word-shaped revision markers (`final`, `copy`, `backup`) are dropped
 * wherever they appear — the specimen's `…-bluewater-final-root-reproof.md`
 * only joins its pile once `final` is gone. Numeric ordinals are dropped only
 * from the trailing run of revision markers, for the reason given on
 * {@link VERSION_ORDINAL}.
 *
 * If normalisation would empty the token set (a file literally named `v2.md`)
 * the raw tokens are kept: a stem of nothing matches every other stem of
 * nothing, which is the worst available failure mode.
 */
export function analyseName(stem: string): NameAnalysis {
  const detailed = tokeniseDetailed(stem)
  const raw = detailed.map((t) => t.text)

  const facets: string[] = []
  const body: string[] = []
  for (let i = 0; i < detailed.length; i += 1) {
    const token = detailed[i]
    if (!token) continue
    if (isFacetAt(detailed, i)) facets.push(token.text)
    else body.push(token.text)
  }

  // Find the trailing run of tokens that are purely revision markers. Only
  // inside that run does a numeric ordinal mean "another go at the same file".
  let firstOrdinal = body.length
  while (firstOrdinal > 0) {
    const token = body[firstOrdinal - 1]
    if (token === undefined) break
    const versionish =
      BARE_DIGITS.test(token) ||
      VERSION_WORDS.has(token) ||
      VERSION_ORDINAL.test(token) ||
      stripTrailingOrdinal(token) !== null
    if (!versionish) break
    firstOrdinal -= 1
  }

  const tokens = new Set<string>()
  for (let i = 0; i < body.length; i += 1) {
    const token = body[i]
    if (token === undefined) continue
    // Bare digits and revision words carry no identity in any position.
    if (BARE_DIGITS.test(token)) continue
    if (VERSION_WORDS.has(token)) continue
    if (i >= firstOrdinal) {
      if (VERSION_ORDINAL.test(token)) continue
      const head = stripTrailingOrdinal(token)
      if (head !== null) {
        tokens.add(head)
        continue
      }
    }
    tokens.add(token)
  }
  if (tokens.size === 0) for (const token of raw) tokens.add(token)

  facets.sort()
  return { raw, tokens, facets }
}

/** Convenience wrapper — the comparison token set alone. */
export function normaliseTokens(stem: string): Set<string> {
  return analyseName(stem).tokens
}

/** Jaccard similarity of two token sets. 1.0 when equal, 0 when disjoint. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  // Iterate the smaller set; the intersection is bounded by it either way.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let inter = 0
  for (const t of small) if (large.has(t)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

// ---------------------------------------------------------------------------
// SimHash comparison
// ---------------------------------------------------------------------------

const SIMHASH_HEX = /^[0-9a-f]{16}$/i
const SIMHASH_BITS = 64

interface Hash64 {
  hi: number
  lo: number
}

function parseHash(hex: string): Hash64 | null {
  if (!SIMHASH_HEX.test(hex)) return null
  // Two 32-bit halves keep the hot path in integer arithmetic; BigInt is used
  // only for band extraction, which runs once per file rather than per pair.
  return { hi: parseInt(hex.slice(0, 8), 16) >>> 0, lo: parseInt(hex.slice(8, 16), 16) >>> 0 }
}

function popcount32(v: number): number {
  let n = v - ((v >>> 1) & 0x55555555)
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333)
  n = (n + (n >>> 4)) & 0x0f0f0f0f
  return (n * 0x01010101) >>> 24
}

function hamming(a: Hash64, b: Hash64): number {
  return popcount32((a.hi ^ b.hi) >>> 0) + popcount32((a.lo ^ b.lo) >>> 0)
}

/** 1 − normalised Hamming distance. */
export function simhashSimilarity(a: string, b: string): number {
  const pa = parseHash(a)
  const pb = parseHash(b)
  if (!pa || !pb) return 0
  return 1 - hamming(pa, pb) / SIMHASH_BITS
}

/**
 * Band keys for candidate generation.
 *
 * With `d` the maximum tolerated Hamming distance, splitting the hash into
 * `d + 1` bands guarantees that any pair within `d` shares at least one band
 * exactly — `d` differing bits can spoil at most `d` bands. So banding is a
 * lossless prefilter, not an approximation, and it turns an O(n²) directory
 * scan into a hash-bucket join.
 */
function bandKeys(hex: string, bandCount: number): string[] {
  const value = BigInt('0x' + hex)
  const keys: string[] = []
  const base = Math.floor(SIMHASH_BITS / bandCount)
  const extra = SIMHASH_BITS % bandCount
  let offset = 0
  for (let b = 0; b < bandCount; b += 1) {
    const width = base + (b < extra ? 1 : 0)
    const mask = (1n << BigInt(width)) - 1n
    keys.push(`${b}:${((value >> BigInt(offset)) & mask).toString(36)}`)
    offset += width
  }
  return keys
}

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

/**
 * Directory names whose contents are near-identical *by design*. Every entry
 * here is a place where a pile of similar files is the correct engineering
 * outcome and flagging it would be actively harmful.
 */
const EXCLUDED_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  // Deliberately ordered sequences. `0002_add_users.sql` is not a worse
  // version of `0001_init.sql`; deleting either corrupts a database.
  'migrations',
  'migration',
  'migrate',
  'schema_migrations',
  // Recorded artefacts. Golden files, snapshots and fixtures are supposed to
  // be many, similar, and numbered.
  '__snapshots__',
  '__fixtures__',
  '__mocks__',
  'snapshots',
  'fixtures',
  'fixture',
  'testdata',
  'test-data',
  'test_data',
  'corpus',
  'corpora',
  'golden',
  'goldens',
  'cassettes',
  'recordings',
  // Translation bundles: one file per language, structurally identical by
  // construction, and every one of them load-bearing.
  'locales',
  'locale',
  'i18n',
  'l10n',
  'lang',
  'langs',
  'languages',
  'translations',
  'translation',
  'intl',
  // Append-only news fragments (towncrier and friends).
  'changelog.d',
  'newsfragments',
  // Not ours to judge.
  'node_modules',
  'bower_components',
  'vendor',
  'third_party',
  'thirdparty',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  'target',
  '__pycache__'
])

/**
 * Dated artefacts. A file whose name carries a date is a log entry, not a
 * revision — the next one does not supersede it. Matches ISO dates, compact
 * dates, and year-month.
 */
const DATED_STEM = /(?:^|[-_.])(?:\d{4}[-_]\d{2}[-_]\d{2}|\d{8}|\d{4}[-_]\d{2})(?:$|[-_.])/

/** Changelog-shaped names, which accumulate on purpose. */
const CHANGELOG_STEM = /^(?:changelog|change[-_]?log|release[-_]?notes|news|history)(?:$|[-_.])/i

/** A BCP-47-ish language tag used as a whole filename: en, fr, pt-BR, zh_Hans. */
const LANGUAGE_TAG = /^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/i

/** Zero-padded sequence prefix: `0001_init.sql`, `003-thumbnails.sql`. */
const SEQUENCE_PREFIX = /^\d{3,}[-_.]/

/**
 * A long numeric run anywhere in the stem: `test_migration_0003.py`. Three or
 * more digits is an identifier, not an ordinal — nobody reaches revision 007
 * of a document, but they do write one test per numbered migration.
 */
const LONG_NUMBER = /\d{3,}/

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function baseOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/**
 * True when a path must never take part in clustering. Kept separate from the
 * cluster-level vetoes so the reason for each rejection stays legible.
 */
function isExcludedPath(path: string, kinds: ReadonlyMap<string, FileKind> | undefined): boolean {
  const kind = kinds?.get(path)
  if (kind !== undefined && EXCLUDED_KINDS.has(kind)) return true

  const segments = path.split('/')
  // The final segment is the filename; only directories are checked here.
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i]
    if (seg === undefined) continue
    const lower = seg.toLowerCase()
    if (EXCLUDED_DIR_SEGMENTS.has(lower)) return true
    // Alembic keeps migrations in `alembic/versions`. `versions` on its own is
    // too generic to exclude, so it is only honoured under that parent.
    if (lower === 'versions' && (segments[i - 1] ?? '').toLowerCase() === 'alembic') return true
  }

  const { stem } = splitExtension(baseOf(path))
  if (DATED_STEM.test(stem)) return true
  if (CHANGELOG_STEM.test(stem)) return true
  return false
}

/**
 * Cluster-level vetoes, applied after grouping. These catch families that only
 * look wrong in aggregate, and they are checked against every member so a
 * single innocent-looking file cannot rescue a bad cluster.
 */
function isVetoedCluster(members: readonly string[]): boolean {
  let allLanguageTags = true
  let allSequenced = true
  let allNumbered = true
  const stems = new Set<string>()
  const numbers = new Set<string>()
  for (const path of members) {
    const base = baseOf(path)
    const { stem } = splitExtension(base)
    stems.add(stem.toLowerCase())
    if (!LANGUAGE_TAG.test(stem)) allLanguageTags = false
    if (!SEQUENCE_PREFIX.test(base)) allSequenced = false
    const n = LONG_NUMBER.exec(stem)
    if (n === null) allNumbered = false
    else numbers.add(n[0])
  }
  // en.json / fr.json / de.json. Their names are disjoint, so they can only
  // have been grouped by content — which is exactly what a translation bundle
  // looks like. Distinct stems confirm one file per language rather than a
  // pile of revisions.
  if (allLanguageTags && stems.size === members.length) return true
  // 0001_init.sql / 0002_add_users.sql outside a directory named migrations.
  if (allSequenced) return true
  // test_migration_0003.py … _0007.py: every member carries its own long
  // number, so this is one file per numbered thing, not seven attempts at one
  // file. Requiring the numbers to be distinct keeps genuine sprawl — where
  // the differentiator is a suffix, not an identifier — out of this veto.
  if (allNumbered && numbers.size === members.length) return true
  return false
}

// ---------------------------------------------------------------------------
// Union-find
// ---------------------------------------------------------------------------

class DisjointSet {
  private readonly parent: number[]
  private readonly rank: number[]

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
    this.rank = new Array<number>(n).fill(0)
  }

  find(x: number): number {
    let root = x
    // Iterative to survive pathological chains without blowing the stack.
    while ((this.parent[root] ?? root) !== root) root = this.parent[root] ?? root
    let cur = x
    while ((this.parent[cur] ?? cur) !== root) {
      const next = this.parent[cur] ?? cur
      this.parent[cur] = root
      cur = next
    }
    return root
  }

  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    const rka = this.rank[ra] ?? 0
    const rkb = this.rank[rb] ?? 0
    if (rka < rkb) this.parent[ra] = rb
    else if (rka > rkb) this.parent[rb] = ra
    else {
      this.parent[rb] = ra
      this.rank[ra] = rka + 1
    }
  }
}

// ---------------------------------------------------------------------------
// The clusterer
// ---------------------------------------------------------------------------

interface Candidate {
  path: string
  stem: string
  tokens: Set<string>
  /** Sorted normalised tokens, joined — the exact-match key. */
  key: string
  hash: Hash64 | null
  hashHex: string | null
  contentEligible: boolean
}

/**
 * Groups near-duplicate siblings.
 *
 * @param paths      Repo-relative paths present in the analysed tree.
 * @param simhashes  path → 16-char hex SimHash. Missing entries simply carry
 *                   no content evidence; binaries legitimately have none.
 * @param opts       See {@link ClusterOptions}.
 * @returns Clusters of three or more members, sorted by member count
 *          descending then stem ascending, with member lists sorted ascending.
 *          Fully deterministic for a given input.
 */
export function buildClusters(
  paths: readonly string[],
  simhashes: ReadonlyMap<string, string>,
  opts: ClusterOptions = {}
): SprawlCluster[] {
  const cfg: ResolvedClusterOptions = {
    nameThreshold: opts.nameThreshold ?? DEFAULT_CLUSTER_OPTIONS.nameThreshold,
    contentThreshold: opts.contentThreshold ?? DEFAULT_CLUSTER_OPTIONS.contentThreshold,
    minMembers: opts.minMembers ?? DEFAULT_CLUSTER_OPTIONS.minMembers,
    minContentLines: opts.minContentLines ?? DEFAULT_CLUSTER_OPTIONS.minContentLines,
    maxBucketFiles: opts.maxBucketFiles ?? DEFAULT_CLUSTER_OPTIONS.maxBucketFiles
  }

  // Bucket by directory AND extension. Directory scoping is the correctness
  // requirement; the extension split is a conservatism — `config.ts`,
  // `config.json` and `config.yaml` are a legitimate trio, and real sprawl
  // almost always duplicates the artefact type along with the name.
  const buckets = new Map<string, Candidate[]>()
  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0) continue
    if (opts.isExcluded?.(path) === true) continue
    if (isExcludedPath(path, opts.kinds)) continue

    const base = baseOf(path)
    const { stem, ext } = splitExtension(base)
    if (stem.length === 0) continue

    const hex = simhashes.get(path)
    const hash = hex === undefined ? null : parseHash(hex)
    const lineCount = opts.lines?.get(path)
    const contentEligible =
      hash !== null && (lineCount === undefined || lineCount >= cfg.minContentLines)

    const name = analyseName(stem)
    const candidate: Candidate = {
      path,
      stem,
      tokens: name.tokens,
      key: '',
      hash,
      hashHex: hash === null || hex === undefined ? null : hex.toLowerCase(),
      contentEligible
    }
    candidate.key = [...candidate.tokens].sort().join('\u0000')

    // Facets join the bucket key so a module is never compared with its own
    // test, story or declaration file — nor, transitively, with a different
    // module's test, which is how `Widget.tsx` + `Widget.test.tsx` +
    // `OtherWidget.test.tsx` chained into a false cluster before this existed.
    const bucketKey = `${dirOf(path)}\u0000${ext}\u0000${name.facets.join(',')}`
    const existing = buckets.get(bucketKey)
    if (existing) existing.push(candidate)
    else buckets.set(bucketKey, [candidate])
  }

  const clusters: SprawlCluster[] = []
  // Sort bucket keys so output order never depends on Map insertion order,
  // which in turn depends on the caller's path ordering.
  for (const bucketKey of [...buckets.keys()].sort()) {
    const bucket = buckets.get(bucketKey)
    if (!bucket || bucket.length < cfg.minMembers) continue
    bucket.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    for (const cluster of clusterBucket(bucket, cfg)) clusters.push(cluster)
  }

  clusters.sort(
    (a, b) => b.members.length - a.members.length || (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0)
  )
  return clusters
}

function clusterBucket(bucket: readonly Candidate[], cfg: ResolvedClusterOptions): SprawlCluster[] {
  const n = bucket.length
  const dsu = new DisjointSet(n)
  const oversized = n > cfg.maxBucketFiles

  // --- (a) name edges -------------------------------------------------------
  // Exact normalised-stem equality first: O(n), and it is the highest-precision
  // evidence there is. This path always runs, even for oversized buckets.
  const byKey = new Map<string, number>()
  for (let i = 0; i < n; i += 1) {
    const c = bucket[i]
    if (!c) continue
    const first = byKey.get(c.key)
    if (first === undefined) byKey.set(c.key, i)
    else dsu.union(first, i)
  }

  if (!oversized) {
    // Jaccard ≥ t requires at least one shared token, so an inverted index is
    // a lossless prefilter. It also collapses the common case where a
    // directory holds many files with no vocabulary in common at all.
    const byToken = new Map<string, number[]>()
    for (let i = 0; i < n; i += 1) {
      const c = bucket[i]
      if (!c) continue
      for (const token of c.tokens) {
        const list = byToken.get(token)
        if (list) list.push(i)
        else byToken.set(token, [i])
      }
    }
    forEachCandidatePair(byToken, (i, j) => {
      if (dsu.find(i) === dsu.find(j)) return
      const a = bucket[i]
      const b = bucket[j]
      if (!a || !b) return
      if (jaccard(a.tokens, b.tokens) >= cfg.nameThreshold) dsu.union(i, j)
    })

    // --- (b) content edges --------------------------------------------------
    const maxDistance = Math.floor(SIMHASH_BITS * (1 - cfg.contentThreshold))
    if (maxDistance >= 0) {
      const bandCount = Math.min(SIMHASH_BITS, maxDistance + 1)
      const byBand = new Map<string, number[]>()
      for (let i = 0; i < n; i += 1) {
        const c = bucket[i]
        if (!c || !c.contentEligible || c.hashHex === null) continue
        for (const key of bandKeys(c.hashHex, bandCount)) {
          const list = byBand.get(key)
          if (list) list.push(i)
          else byBand.set(key, [i])
        }
      }
      forEachCandidatePair(byBand, (i, j) => {
        if (dsu.find(i) === dsu.find(j)) return
        const a = bucket[i]
        const b = bucket[j]
        if (!a || !b || !a.hash || !b.hash) return
        if (hamming(a.hash, b.hash) <= maxDistance) dsu.union(i, j)
      })
    }
  }

  // --- assemble -------------------------------------------------------------
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i += 1) {
    const root = dsu.find(i)
    const list = groups.get(root)
    if (list) list.push(i)
    else groups.set(root, [i])
  }

  const out: SprawlCluster[] = []
  for (const indices of groups.values()) {
    if (indices.length < cfg.minMembers) continue
    const members: Candidate[] = []
    for (const i of indices) {
      const c = bucket[i]
      if (c) members.push(c)
    }
    if (members.length < cfg.minMembers) continue
    members.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

    const paths = members.map((m) => m.path)
    if (isVetoedCluster(paths)) continue

    out.push({
      stem: sharedStem(members),
      members: paths,
      basis: basisOf(members, cfg),
      similarity: meanPairwiseSimilarity(members)
    })
  }
  return out
}

/**
 * A posting list longer than this contributes no discrimination and would
 * reinstate the O(n²) scan the index exists to avoid.
 *
 * Skipping it is provably lossless for name edges: if two files share only one
 * token then |A∩B| = 1, and Jaccard ≥ 0.7 forces |A| + |B| ≤ 2.43, i.e. both
 * sets are exactly {token} — which the exact-normalised-stem pass has already
 * merged. For content bands it cannot trigger below `maxBucketFiles` unless
 * the hashes are degenerate.
 */
const MAX_POSTING_LIST = 512

/**
 * Visits every pair sharing at least one index key. Posting lists are built in
 * ascending index order, so `i < j` holds without a check. A pair sharing
 * several keys is visited several times; the callbacks are idempotent and
 * short-circuit on an already-merged pair, which is cheaper than materialising
 * a deduplicated pair set.
 */
function forEachCandidatePair(
  index: ReadonlyMap<string, number[]>,
  visit: (i: number, j: number) => void
): void {
  for (const list of index.values()) {
    if (list.length < 2 || list.length > MAX_POSTING_LIST) continue
    for (let a = 0; a < list.length; a += 1) {
      const i = list[a]
      if (i === undefined) continue
      for (let b = a + 1; b < list.length; b += 1) {
        const j = list[b]
        if (j === undefined) continue
        visit(i, j)
      }
    }
  }
}

/** Characters that end a word inside a filename stem. */
const STEM_BOUNDARY = /[-_.\s@~]/

/**
 * The label a human would write for the pile: the shared directory plus the
 * longest common prefix of the members' stems, cut back to a word boundary.
 *
 * The prefix is compared case-insensitively but sliced from the first member's
 * original stem, so `Report-final.md` and `report-final-2.md` still share one.
 *
 * The cut-back matters. `extract_table_questions@v1` and `…@v15` share the
 * literal prefix `extract_table_questions@v`, and the trailing `@v` is a
 * fragment of a version marker, not part of the name. Where the prefix already
 * lands on a boundary in every member — `enhance-2-cohort-ashgrove` beside
 * `enhance-2-cohort-ashgrove-p3` — it is kept whole.
 */
function sharedStem(members: readonly Candidate[]): string {
  const first = members[0]
  if (!first) return ''
  const dir = dirOf(first.path)

  let end = first.stem.length
  for (let i = 1; i < members.length && end > 0; i += 1) {
    const other = members[i]
    if (!other) continue
    const limit = Math.min(end, other.stem.length)
    let k = 0
    while (k < limit && first.stem[k]?.toLowerCase() === other.stem[k]?.toLowerCase()) k += 1
    end = k
  }

  // Does the prefix end on a word boundary in every member? If the next
  // character is a separator, or there is no next character, it does.
  let onBoundary = true
  for (const m of members) {
    const next = m.stem[end]
    if (next !== undefined && !STEM_BOUNDARY.test(next)) {
      onBoundary = false
      break
    }
  }
  if (!onBoundary) {
    while (end > 0 && !STEM_BOUNDARY.test(first.stem[end - 1] ?? '')) end -= 1
  }
  while (end > 0 && STEM_BOUNDARY.test(first.stem[end - 1] ?? '')) end -= 1

  // Content-formed clusters can share no name prefix at all; fall back to the
  // directory, which is still a true and useful label.
  const label = first.stem.slice(0, end)
  if (label === '') return dir === '' ? '(repo root)' : dir
  return dir === '' ? label : `${dir}/${label}`
}

/** Best available evidence for one pair: name and content are alternatives. */
function pairSimilarity(a: Candidate, b: Candidate): number {
  const name = jaccard(a.tokens, b.tokens)
  if (!a.hash || !b.hash) return name
  return Math.max(name, 1 - hamming(a.hash, b.hash) / SIMHASH_BITS)
}

/** Mean over all pairs — a cohesion figure, not just the linking edges. */
function meanPairwiseSimilarity(members: readonly Candidate[]): number {
  let total = 0
  let pairs = 0
  for (let i = 0; i < members.length; i += 1) {
    const a = members[i]
    if (!a) continue
    for (let j = i + 1; j < members.length; j += 1) {
      const b = members[j]
      if (!b) continue
      total += pairSimilarity(a, b)
      pairs += 1
    }
  }
  return pairs === 0 ? 0 : total / pairs
}

/**
 * Reports which mechanisms actually hold across the finished cluster, not
 * merely which produced the spanning edges. A name-formed cluster whose
 * members are also byte-similar is genuinely 'both', and saying so tells the
 * user the merge is safe.
 */
function basisOf(members: readonly Candidate[], cfg: ResolvedClusterOptions): 'name' | 'content' | 'both' {
  let byName = false
  let byContent = false
  const maxDistance = Math.floor(SIMHASH_BITS * (1 - cfg.contentThreshold))
  for (let i = 0; i < members.length; i += 1) {
    const a = members[i]
    if (!a) continue
    for (let j = i + 1; j < members.length; j += 1) {
      const b = members[j]
      if (!b) continue
      if (!byName && jaccard(a.tokens, b.tokens) >= cfg.nameThreshold) byName = true
      if (
        !byContent &&
        a.contentEligible &&
        b.contentEligible &&
        a.hash &&
        b.hash &&
        hamming(a.hash, b.hash) <= maxDistance
      ) {
        byContent = true
      }
      if (byName && byContent) return 'both'
    }
  }
  if (byName && byContent) return 'both'
  if (byContent) return 'content'
  // Exact normalised-stem equality is a name edge even at Jaccard 1.0, and
  // 'name' is the only honest default for a cluster with no content evidence.
  return 'name'
}

