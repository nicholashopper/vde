/**
 * The analyzer's internal model.
 *
 * `src/shared/types.ts` is the contract with the renderer; this is the contract
 * *within* the engine. Nothing here crosses IPC, so it may use Sets, Maps and
 * epoch numbers freely — all of which are cheaper than the wire types.
 *
 * Reading order: History is parsed once from `git log`. TreeEntry lists what
 * exists at a revision. BlobAnalysis is the (cached) result of looking inside a
 * blob. Everything a signal needs is assembled into AnalysisContext, and each
 * signal is a pure function of that context.
 */

import type { Finding, FileFlag, SignalDriver, SignalId, Settings } from '../shared/types'

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T'

export interface FileChange {
  path: string
  /** Present for renames and copies. */
  oldPath?: string
  status: ChangeStatus
  insertions: number
  deletions: number
  binary: boolean
}

export interface CommitRecord {
  sha: string
  parents: string[]
  authorName: string
  authorEmail: string
  /** Epoch milliseconds, UTC. */
  authoredAt: number
  committedAt: number
  subject: string
  files: FileChange[]
  /** True for commits with two or more parents. Merges are excluded from most
   *  signals so their diffs are not double-counted. */
  isMerge: boolean
}

export interface History {
  /** Newest first. */
  commits: CommitRecord[]
  firstAt: number
  lastAt: number
  /** author email → display name, for contributor counts. */
  authors: Map<string, string>
}

// ---------------------------------------------------------------------------
// Trees & blobs
// ---------------------------------------------------------------------------

export interface TreeEntry {
  /** Repo-relative path. */
  path: string
  /** Blob object id — the cache key for all content analysis. */
  sha: string
  /** Bytes, from `ls-tree -l`. -1 when git reports '-'. */
  size: number
  mode: string
}

/**
 * Everything VDE learns by looking inside one blob. Keyed by blob sha, which is
 * content-addressed — so this is computed at most once per distinct file
 * content, for the whole life of the database. This is what makes retroactive
 * backfill affordable: across 180 historical snapshots, an unchanged file is
 * parsed exactly once.
 */
export interface BlobAnalysis {
  sha: string
  bytes: number
  lines: number
  /** Lines that are neither blank nor a comment. Null when not parsed. */
  codeLines: number | null
  language: string | null
  binary: boolean
  functions: number | null
  totalComplexity: number | null
  maxComplexity: number | null
  /** Functions with cyclomatic complexity above 10. */
  complexFunctions: number | null
  /**
   * 64-bit SimHash of the blob's token shingles, as a 16-char hex string.
   * Used for near-duplicate detection without an LLM. Null for binaries.
   */
  simhash: string | null
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type FileKind =
  | 'source'
  | 'test'
  | 'doc'
  | 'config'
  | 'data'
  | 'asset'
  | 'generated'
  | 'vendored'
  | 'unknown'

/** Kinds that count as "the code" for scoring purposes. */
export const CODE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['source'])

/** Kinds excluded from every content-based signal. */
export const EXCLUDED_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  'generated',
  'vendored',
  'asset',
  'data'
])

// ---------------------------------------------------------------------------
// Per-path aggregates over the whole history
// ---------------------------------------------------------------------------

export interface FileStats {
  path: string
  /** Non-merge commits touching this path, following renames. */
  commits: number
  authors: Set<string>
  firstAt: number
  lastAt: number
  added: number
  deleted: number
  /** Present in the analysed tree. */
  alive: boolean
  /** Path this file was renamed from, most recent first. */
  formerPaths: string[]
  /** Shas of commits that touched it, newest first, capped at 200. */
  touchedBy: string[]
}

// ---------------------------------------------------------------------------
// Near-duplicate clusters (the sibling-sprawl mechanism)
// ---------------------------------------------------------------------------

export interface SprawlCluster {
  /** The shared stem, e.g. "docs/qa/enhance-2-bluewater". */
  stem: string
  members: string[]
  /** 'name' when clustered by filename similarity, 'content' by simhash. */
  basis: 'name' | 'content' | 'both'
  /** Mean pairwise similarity, 0–1. */
  similarity: number
}

// ---------------------------------------------------------------------------
// The context every signal is computed against
// ---------------------------------------------------------------------------

export interface AnalysisContext {
  repoId: string
  repoPath: string
  settings: Settings
  /** Commit the analysis is anchored to. */
  headSha: string
  /** Epoch ms of the anchor commit — "now" for age arithmetic. */
  now: number

  history: History
  /** Non-merge commits inside the scoring window, newest first. */
  window: CommitRecord[]
  /** Width of the scoring window in days. */
  windowDays: number

  tree: TreeEntry[]
  /** blob sha → analysis. Populated for every non-excluded tree entry. */
  blobs: Map<string, BlobAnalysis>
  /** repo-relative path → kind. Covers tree entries and historical paths. */
  kinds: Map<string, FileKind>
  /** repo-relative path → aggregates. Covers every path ever seen. */
  fileStats: Map<string, FileStats>
  /** Directory path → immediate child file count, for sprawl. */
  dirFileCounts: Map<string, number>
  clusters: SprawlCluster[]

  /**
   * Files-per-commit above which a commit is "mega" for this repo. Computed as
   * max(25, p90 × 2.5) so a repo of small commits is not judged by another
   * repo's habits.
   */
  megaThreshold: number
}

/** What a signal returns. `value` is always higher-is-worse. */
export interface SignalResult {
  value: number
  headline: string
  drivers: SignalDriver[]
  /** Findings this signal wants to raise. Ids and severity are filled in by
   *  the orchestrator so signals stay pure. */
  findings?: RawFinding[]
}

export type RawFinding = Omit<Finding, 'id' | 'signalId' | 'severity'>

export interface SignalComputer {
  id: SignalId
  compute(ctx: AnalysisContext): SignalResult
}

// ---------------------------------------------------------------------------
// Flags applied to tree nodes for the Map view
// ---------------------------------------------------------------------------

export interface FlagRule {
  flag: FileFlag
  applies(path: string, ctx: AnalysisContext): boolean
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export type ProgressFn = (phase: string, message: string, current: number, total: number) => void

/** Thrown to unwind a cancelled scan. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'Cancelled'
  }
}
