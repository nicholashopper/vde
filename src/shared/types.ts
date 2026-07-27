/**
 * THE CONTRACT.
 *
 * Every module in VDE — the analyzer utility process, the main process, the
 * preload bridge, and the renderer — is written against this file and nothing
 * else. If a type is needed on both sides of an IPC boundary it lives here.
 *
 * Rules that hold across the whole app:
 *   1. Every signal is oriented so a HIGHER value is WORSE. No exceptions.
 *      This is what lets the dashboard be read at a glance without a composite
 *      score: every tile points the same way.
 *   2. Everything crossing IPC is structured-clone safe — plain data only, no
 *      functions, classes, Dates, or Maps. Timestamps are ISO-8601 strings.
 *   3. VDE never writes to an analyzed repository. See analyzer/git/exec.ts.
 */

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface RepoRef {
  /** Stable id derived from the canonical filesystem path. */
  id: string
  /** Absolute, symlink-resolved path to the repository working tree root. */
  path: string
  /** Directory basename, used as the display name. */
  name: string
  /** HEAD commit sha at the time of the last scan. */
  head: string
  /** Current branch name, or null when detached. */
  branch: string | null
  firstCommitAt: string
  lastCommitAt: string
  commitCount: number
  /** When the user added this repo to VDE. */
  addedAt: string
  /** When VDE last completed a scan, or null if never scanned. */
  lastScanAt: string | null
}

// ---------------------------------------------------------------------------
// Health status
// ---------------------------------------------------------------------------

/** Maps 1:1 onto the dataviz status palette. Never reused for series identity. */
export type HealthStatus = 'good' | 'warning' | 'serious' | 'critical'

export const HEALTH_STATUS_ORDER: readonly HealthStatus[] = [
  'good',
  'warning',
  'serious',
  'critical'
] as const

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * The signal panel. Each id corresponds to a pathology observed in real
 * vibecoded repositories and invisible to conventional linters.
 */
export type SignalId =
  | 'accretion'
  | 'blastRadius'
  | 'siblingSprawl'
  | 'fileThrash'
  | 'godFiles'
  | 'writeOnce'
  | 'rework'
  | 'cadence'
  | 'commitHygiene'
  | 'docBloat'
  | 'testDeficit'
  | 'complexityDrift'
  | 'directorySprawl'
  | 'unreviewedBulk'

export type SignalUnit = 'percent' | 'count' | 'ratio' | 'days' | 'lines' | 'files'

export interface SignalDef {
  id: SignalId
  /** Short tile title. */
  label: string
  /** One clause naming what is measured. */
  measures: string
  /** Why this matters specifically for an agent-written repository. */
  why: string
  unit: SignalUnit
  /** Decimal places for display. */
  precision: number
  /**
   * Upper bounds, inclusive, for each status band. A value above `serious`
   * is critical. Because every signal is higherIsWorse, these ascend.
   */
  thresholds: { good: number; warning: number; serious: number }
  /**
   * Ceiling used only to scale the tile's bar. Values above render full.
   */
  displayMax: number
  /** What a driver row represents for this signal. */
  driverNoun: string
}

export interface SignalDriver {
  kind: 'file' | 'directory' | 'commit' | 'cluster' | 'author'
  /** Repo-relative path for file/directory kinds. */
  path?: string
  /** Commit sha for commit kind. */
  sha?: string
  /** Display label, pre-computed by the analyzer. */
  label: string
  /** The number that earned this row its place in the ranking. */
  value: number
  /** Optional secondary line. */
  detail?: string
  /** For cluster kind: the member paths. */
  members?: string[]
}

export interface SignalValue {
  id: SignalId
  value: number
  status: HealthStatus
  /** Plain-English one-liner, e.g. "1 line removed for every 30 added". */
  headline: string
  /** Ranked worst offenders, longest-first. Capped at 50 by the analyzer. */
  drivers: SignalDriver[]
}

export interface SignalDelta {
  id: SignalId
  current: number
  baseline: number
  /** current − baseline. Positive always means "got worse". */
  absolute: number
  /** Fractional change, or null when the baseline is zero. */
  relative: number | null
  direction: 'worse' | 'better' | 'flat'
  /** |absolute| normalised by the signal's displayMax — used to rank movers. */
  magnitude: number
}

// ---------------------------------------------------------------------------
// Point-in-time facts
// ---------------------------------------------------------------------------

export interface LanguageStat {
  language: string
  files: number
  lines: number
  bytes: number
}

export interface SnapshotFacts {
  commitCount: number
  fileCount: number
  totalLines: number
  sourceLines: number
  docLines: number
  testLines: number
  configLines: number
  dirCount: number
  maxDepth: number
  contributors: number
  languages: LanguageStat[]
}

/** One point on every sparkline. Deliberately small — thousands are sent. */
export interface SnapshotPoint {
  /** YYYY-MM-DD */
  date: string
  commitSha: string
  signals: Partial<Record<SignalId, number>>
  fileCount: number
  totalLines: number
  sourceLines: number
  docLines: number
  testLines: number
  /** Top languages only, for the stacked-area chart. */
  languages: LanguageStat[]
}

// ---------------------------------------------------------------------------
// File tree (the Map view)
// ---------------------------------------------------------------------------

export type FileFlag =
  | 'god-file'
  | 'write-once'
  | 'high-rework'
  | 'stale'
  | 'sibling-sprawl'
  | 'generated'
  | 'binary'
  | 'vendored'

export interface FileNode {
  /** Repo-relative path. '' for the root node. */
  path: string
  name: string
  type: 'file' | 'directory'
  children?: FileNode[]
  lines: number
  bytes: number
  language: string | null
  /** Number of commits that touched this path. */
  commits: number
  authors: number
  lastModified: string
  ageDays: number
  addedLines: number
  deletedLines: number
  /** deletedLines / addedLines. 1.0 means fully rewritten in place. */
  reworkRatio: number
  /** Sum of cyclomatic complexity across parsed functions, or null. */
  complexity: number | null
  functions: number | null
  /** 0–1, drives the Map's sequential colour ramp. */
  risk: number
  flags: FileFlag[]
}

// ---------------------------------------------------------------------------
// Commits & timeline
// ---------------------------------------------------------------------------

export interface CommitSummary {
  sha: string
  shortSha: string
  authoredAt: string
  author: string
  subject: string
  filesChanged: number
  insertions: number
  deletions: number
  /** Above the repo's mega-commit threshold. */
  isMega: boolean
  /** Subject matches the conventional-commit grammar. */
  conventional: boolean
}

export interface TimelineBucket {
  /** YYYY-MM-DD */
  date: string
  commits: number
  insertions: number
  deletions: number
  filesTouched: number
  megaCommits: number
  authors: number
}

// ---------------------------------------------------------------------------
// Findings & the remediation brief
// ---------------------------------------------------------------------------

export interface Finding {
  id: string
  signalId: SignalId
  severity: HealthStatus
  title: string
  /** Two or three sentences of evidence. */
  detail: string
  paths: string[]
  metric: { label: string; value: number; unit: SignalUnit }
  /**
   * Remediation phrased as a direct instruction to a coding agent. This is what
   * gets assembled into the exportable brief.
   */
  remediation: string
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

export type BaselineKind = '7d' | '30d' | '90d' | 'first' | 'commit'

export interface BaselineRef {
  kind: BaselineKind
  /** Resolved commit sha of the baseline snapshot, null when unresolvable. */
  commitSha: string | null
  /** YYYY-MM-DD of the baseline snapshot. */
  date: string | null
  /** Human label, e.g. "7 days ago (a1b2c3d)". */
  label: string
}

// ---------------------------------------------------------------------------
// The report — the single payload the renderer draws
// ---------------------------------------------------------------------------

export interface RepoReport {
  repo: RepoRef
  generatedAt: string
  baseline: BaselineRef
  signals: SignalValue[]
  deltas: SignalDelta[]
  /** Ranked by |magnitude|, worst-first. Feeds the "what moved most" strip. */
  topMovers: SignalDelta[]
  facts: SnapshotFacts
  baselineFacts: SnapshotFacts | null
  snapshots: SnapshotPoint[]
  timeline: TimelineBucket[]
  tree: FileNode
  findings: Finding[]
  /** Most recent commits, newest first. Capped at 500. */
  commits: CommitSummary[]
  /** Non-fatal problems encountered during analysis. */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Analysis lifecycle
// ---------------------------------------------------------------------------

export type AnalysisPhase =
  | 'queued'
  | 'validating'
  | 'reading-history'
  | 'scanning-tree'
  | 'parsing-content'
  | 'backfilling'
  | 'computing-signals'
  | 'done'
  | 'cancelled'
  | 'error'

export interface AnalysisProgress {
  repoId: string
  phase: AnalysisPhase
  message: string
  /** 0-based units completed within the current phase. */
  current: number
  /** Total units in the current phase, or 0 when indeterminate. */
  total: number
  /** 0–1 across the whole run. */
  overall: number
  startedAt: string
  error?: string
}

export interface ScanOptions {
  /** Recompute from scratch, ignoring the snapshot and blob caches. */
  force?: boolean
  /**
   * Cap on retroactive snapshots. The analyzer picks an adaptive cadence
   * (daily for recent history, weekly then monthly further back) to fit.
   */
  maxSnapshots?: number
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  theme: 'dark' | 'light' | 'system'
  /** Default baseline for new reports. */
  defaultBaseline: BaselineKind
  /** Files matching these globs are excluded from all content analysis. */
  excludeGlobs: string[]
  /** Treat these globs as generated; they are flagged and excluded from scores. */
  generatedGlobs: string[]
  maxSnapshots: number
  /** Re-scan the active repo when its HEAD changes on disk. */
  watchHead: boolean
  /** Render charts with the accessibility texture channel enabled. */
  textureFills: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  defaultBaseline: '7d',
  excludeGlobs: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/.next/**',
    '**/target/**',
    '**/vendor/**',
    '**/__pycache__/**',
    '**/*.min.js',
    '**/*.min.css'
  ],
  generatedGlobs: [
    '**/*.lock',
    '**/pnpm-lock.yaml',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/poetry.lock',
    '**/Cargo.lock',
    '**/*.generated.*',
    '**/*.gen.ts',
    '**/schema.d.ts',
    '**/*.pb.go',
    '**/*_pb2.py'
  ],
  maxSnapshots: 180,
  watchHead: true,
  textureFills: false
}

// ---------------------------------------------------------------------------
// IPC surface exposed on window.vde by the preload bridge
// ---------------------------------------------------------------------------

/**
 * Spelled out rather than reused from Node's own platform union: this module is imported
 * by the renderer, which has no Node types, and a shared contract should not
 * depend on the host's globals.
 */
export type Platform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'

export interface VdeApi {
  repos: {
    list(): Promise<RepoRef[]>
    /** Opens a native directory picker. Resolves null if cancelled. */
    pick(): Promise<RepoRef | null>
    /** Adds a repo by absolute path. Rejects if it is not a git work tree. */
    add(path: string): Promise<RepoRef>
    remove(id: string): Promise<void>
    get(id: string): Promise<RepoRef | null>
  }
  analysis: {
    scan(repoId: string, opts?: ScanOptions): Promise<void>
    cancel(repoId: string): Promise<void>
    report(repoId: string, baseline: BaselineKind, ref?: string): Promise<RepoReport>
    /** Returns an unsubscribe function. */
    onProgress(cb: (p: AnalysisProgress) => void): () => void
  }
  brief: {
    /** Renders the markdown remediation brief for the given findings. */
    generate(repoId: string, findingIds?: string[]): Promise<string>
    copy(text: string): Promise<void>
    save(repoId: string, text: string): Promise<string | null>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  app: {
    version(): Promise<string>
    platform(): Promise<Platform>
    openExternal(url: string): Promise<void>
    /** Reveals a repo-relative file in the OS file manager. */
    revealFile(repoId: string, relPath: string): Promise<void>
  }
}
