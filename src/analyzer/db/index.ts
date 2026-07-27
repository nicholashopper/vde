/**
 * The analyzer's persistence layer.
 *
 * Everything here is synchronous. That is not a compromise: this module only
 * ever runs inside the dedicated analyzer utility process, which has no UI to
 * block, and better-sqlite3's synchronous API is several times faster than any
 * async wrapper because it avoids a thread hop per statement. The hot path —
 * `getBlobs` / `putBlobs` — moves tens of thousands of rows per scan, and that
 * is where the design effort has gone.
 *
 * Three things are worth knowing before reading further:
 *
 *   • `blobs` is a *global* content-addressed cache keyed by git blob sha. It
 *     is never invalidated and never scoped to a repository. Removing a repo
 *     does not touch it.
 *   • `snapshots` and `scan_state` are derived. They are cheap to rebuild and
 *     are deleted with their repo.
 *   • Multi-row writes are always wrapped in a transaction, so a crash mid-scan
 *     leaves the database at a consistent earlier state rather than a partial
 *     one. WAL mode means readers never see a torn write in the first place.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import Database from 'better-sqlite3'
import type { RepoRef, SignalId, SnapshotFacts } from '../../shared/types'
import type { BlobAnalysis } from '../model'
import { migrate, SCHEMA_VERSION, SchemaError, type SqliteDb } from './schema'

export { SCHEMA_VERSION, SchemaError }
export type { Migration, MigrationOutcome, SqliteDb } from './schema'

export class DbError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DbError'
  }
}

// ---------------------------------------------------------------------------
// Public row shapes
// ---------------------------------------------------------------------------

/**
 * The per-snapshot signal payload. Deliberately just the numbers: a snapshot
 * exists to draw a sparkline point (`SnapshotPoint` in the shared contract),
 * and persisting drivers for 180 snapshots × 14 signals × 50 rows would cost
 * megabytes to store data no chart reads.
 */
export type SnapshotSignals = Partial<Record<SignalId, number>>

export interface SnapshotRow {
  id: number
  repoId: string
  commitSha: string
  /** YYYY-MM-DD, as computed by the analyzer (not derived from committedAt). */
  date: string
  /** Epoch milliseconds. */
  committedAt: number
  facts: SnapshotFacts
  signals: SnapshotSignals
}

/** Argument shape for the batched {@link Db.putSnapshots}. */
export interface SnapshotInput {
  repoId: string
  commitSha: string
  date: string
  committedAt: number
  facts: SnapshotFacts
  signals: SnapshotSignals
}

/**
 * Incremental-scan bookkeeping.
 *
 * `history` is opaque to this module — the scanner owns its shape and this
 * layer only compresses and round-trips it. Type it at the call site:
 * `db.getScanState<CachedHistory>(repoId)`.
 */
export interface ScanState<H = unknown> {
  repoId: string
  lastHead: string | null
  lastScannedAt: string | null
  history: H | null
}

/**
 * Partial update. A field left `undefined` (or omitted) is **unchanged**; an
 * explicit `null` **clears** it. This distinction matters: `lastHead` is
 * updated far more often than `history`, and rewriting a multi-megabyte
 * compressed history on every touch would be wasteful.
 */
export interface ScanStatePatch<H = unknown> {
  lastHead?: string | null
  lastScannedAt?: string | null
  history?: H | null
}

// ---------------------------------------------------------------------------
// Internal row shapes (snake_case, straight off SQLite)
// ---------------------------------------------------------------------------

interface BlobRow {
  sha: string
  bytes: number
  lines: number
  code_lines: number | null
  language: string | null
  binary: number
  functions: number | null
  total_complexity: number | null
  max_complexity: number | null
  complex_functions: number | null
  simhash: string | null
}

interface RepoRow {
  id: string
  path: string
  name: string
  added_at: string
  last_scan_at: string | null
  head: string
  branch: string | null
  first_commit_at: string
  last_commit_at: string
  commit_count: number
}

interface SnapshotSqlRow {
  id: number
  repo_id: string
  commit_sha: string
  date: string
  committed_at: number
  facts_json: string
  signals_json: string
}

interface ScanStateSqlRow {
  repo_id: string
  last_head: string | null
  last_scanned_at: string | null
  history_json: Uint8Array | null
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

export const DB_FILENAME = 'vde.db'

/**
 * SQLITE_MAX_VARIABLE_NUMBER is 32766 in SQLite ≥3.32 but 999 in every build
 * before it, and better-sqlite3 ships whichever amalgamation its prebuild was
 * compiled against. 900 is safe everywhere and also keeps the per-statement
 * bind cost bounded, which matters more than chunk count at this scale.
 */
const CHUNK_LIMIT = 900

/**
 * `IN (?, ?, …)` needs one prepared statement per placeholder count. Rather
 * than preparing a new statement for every tail length we ever see — which
 * would leak statements across a long-running process — we round each chunk up
 * to the next width on this ladder and pad it by repeating its last sha.
 * `IN` has set semantics, so duplicate placeholders are harmless, and this caps
 * the statement cache at eleven entries for the life of the connection.
 */
const CHUNK_WIDTHS: readonly number[] = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, CHUNK_LIMIT]

/** Default ceiling enforced by {@link Db.vacuumBlobs}. */
export const MAX_BLOB_ROWS = 500_000

/**
 * The cached history is a *cache*, so round-trip latency beats compression
 * ratio. Level 1 compresses JSON roughly 6× at three to four times the speed of
 * level 6; on a 100k-commit repository that is the difference between a
 * quarter-second and two seconds added to every scan, to save disk we have.
 */
const GZIP_LEVEL = 1

/**
 * Refuse to persist a compressed history larger than this. 192 MiB of gzip is
 * on the order of a gigabyte of JSON — reaching it means the caller stopped
 * producing a *compact* history, which is a bug worth surfacing loudly rather
 * than a condition worth degrading through.
 */
const MAX_HISTORY_BYTES = 192 * 1024 * 1024

// ---------------------------------------------------------------------------
// Marshalling helpers
// ---------------------------------------------------------------------------

/**
 * SQLite columns declared INTEGER still accept a REAL, and better-sqlite3 will
 * happily bind 10.5 into `lines`. Truncating at the boundary keeps the cache
 * honest without adopting STRICT tables, which would turn a caller's rounding
 * slip into a hard constraint failure mid-scan.
 */
function toInt(n: number): number {
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

function toIntOrNull(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  return Math.trunc(n)
}

function fromBlobRow(r: BlobRow): BlobAnalysis {
  return {
    sha: r.sha,
    bytes: r.bytes,
    lines: r.lines,
    codeLines: r.code_lines,
    language: r.language,
    binary: r.binary !== 0,
    functions: r.functions,
    totalComplexity: r.total_complexity,
    maxComplexity: r.max_complexity,
    complexFunctions: r.complex_functions,
    simhash: r.simhash
  }
}

function fromRepoRow(r: RepoRow): RepoRef {
  return {
    id: r.id,
    path: r.path,
    name: r.name,
    head: r.head,
    branch: r.branch,
    firstCommitAt: r.first_commit_at,
    lastCommitAt: r.last_commit_at,
    commitCount: r.commit_count,
    addedAt: r.added_at,
    lastScanAt: r.last_scan_at
  }
}

function parseJson<T>(json: string, what: string): T {
  try {
    return JSON.parse(json) as T
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new DbError(`Corrupt ${what} in the VDE database: ${reason}`)
  }
}

function fromSnapshotRow(r: SnapshotSqlRow): SnapshotRow {
  return {
    id: r.id,
    repoId: r.repo_id,
    commitSha: r.commit_sha,
    date: r.date,
    committedAt: r.committed_at,
    facts: parseJson<SnapshotFacts>(r.facts_json, `snapshot facts for ${r.repo_id}@${r.commit_sha}`),
    signals: parseJson<SnapshotSignals>(r.signals_json, `snapshot signals for ${r.repo_id}@${r.commit_sha}`)
  }
}

/** Smallest ladder width that can hold `n` placeholders. */
function widthFor(n: number): number {
  for (const w of CHUNK_WIDTHS) {
    if (n <= w) return w
  }
  return CHUNK_LIMIT
}

/** Pads a non-empty chunk to `width` by repeating its last element. */
function padTo(chunk: readonly string[], width: number): string[] {
  const out = chunk.slice()
  const last = out[out.length - 1]
  if (last === undefined) return out // unreachable: callers only pass non-empty chunks
  while (out.length < width) out.push(last)
  return out
}

function packHistory(history: unknown): Uint8Array | null {
  if (history === null || history === undefined) return null
  const json = JSON.stringify(history)
  // JSON.stringify returns undefined for functions, symbols and undefined.
  if (json === undefined) return null
  const packed = gzipSync(Buffer.from(json, 'utf8'), { level: GZIP_LEVEL })
  if (packed.byteLength > MAX_HISTORY_BYTES) {
    throw new DbError(
      `Cached history is ${packed.byteLength} bytes compressed, over the ${MAX_HISTORY_BYTES}-byte limit. ` +
        `scan_state.history_json is meant to hold a compact summary, not a full history dump.`
    )
  }
  return packed
}

function unpackHistory<H>(raw: Uint8Array | null): H | null {
  if (raw === null || raw.byteLength === 0) return null
  try {
    return JSON.parse(gunzipSync(raw).toString('utf8')) as H
  } catch {
    // An unreadable cache is indistinguishable from a cold one, and the scanner
    // can always rebuild it from git. Degrade rather than fail the scan.
    return null
  }
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const BLOB_COLUMNS =
  'sha, bytes, lines, code_lines, language, binary, functions, total_complexity, ' +
  'max_complexity, complex_functions, simhash'

const PUT_BLOB_SQL = `
INSERT INTO blobs (${BLOB_COLUMNS}, inserted_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(sha) DO UPDATE SET
  bytes = excluded.bytes,
  lines = excluded.lines,
  code_lines = excluded.code_lines,
  language = excluded.language,
  binary = excluded.binary,
  functions = excluded.functions,
  total_complexity = excluded.total_complexity,
  max_complexity = excluded.max_complexity,
  complex_functions = excluded.complex_functions,
  simhash = excluded.simhash`
// inserted_at is deliberately preserved on conflict: eviction order is
// "oldest-inserted first", and re-analysing a blob does not make it new.

const SNAPSHOT_COLUMNS = 'id, repo_id, commit_sha, date, committed_at, facts_json, signals_json'

const PUT_SNAPSHOT_SQL = `
INSERT INTO snapshots (repo_id, commit_sha, date, committed_at, facts_json, signals_json)
VALUES (?,?,?,?,?,?)
ON CONFLICT(repo_id, commit_sha) DO UPDATE SET
  date = excluded.date,
  committed_at = excluded.committed_at,
  facts_json = excluded.facts_json,
  signals_json = excluded.signals_json`

const REPO_COLUMNS =
  'id, path, name, added_at, last_scan_at, head, branch, first_commit_at, last_commit_at, commit_count'

/**
 * `added_at` is intentionally absent from the update list: it records when the
 * user first added the repo and must survive every re-scan. `id` is derived
 * from the canonical path, so a path collision implies an id collision and
 * ON CONFLICT(id) is sufficient.
 */
const UPSERT_REPO_SQL = `
INSERT INTO repos (${REPO_COLUMNS})
VALUES (?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  path = excluded.path,
  name = excluded.name,
  last_scan_at = excluded.last_scan_at,
  head = excluded.head,
  branch = excluded.branch,
  first_commit_at = excluded.first_commit_at,
  last_commit_at = excluded.last_commit_at,
  commit_count = excluded.commit_count`

/** Patch field → column, in the fixed order used by the scan_state upsert. */
const SCAN_STATE_COLUMNS: readonly [keyof ScanStatePatch, string][] = [
  ['lastHead', 'last_head'],
  ['lastScannedAt', 'last_scanned_at'],
  ['history', 'history_json']
]

// ---------------------------------------------------------------------------
// Db
// ---------------------------------------------------------------------------

type BlobSelect = Database.Statement<string[], BlobRow>

export class Db {
  /** Absolute path of the SQLite file. */
  readonly file: string
  /** Schema version installed on this connection. */
  readonly schemaVersion: number

  private readonly db: SqliteDb
  private closed = false

  /** Placeholder-width → statement. Bounded by CHUNK_WIDTHS.length. */
  private readonly blobSelects = new Map<number, BlobSelect>()
  /** DO-UPDATE-SET signature → statement. Bounded by 2³ patch shapes. */
  private readonly scanStateUpserts = new Map<string, Database.Statement<unknown[], unknown>>()

  private readonly stPutBlob: Database.Statement<
    [string, number, number, number | null, string | null, number, number | null, number | null, number | null, number | null, string | null, number],
    unknown
  >
  private readonly stCountBlobs: Database.Statement<[], { n: number }>
  private readonly stPutSnapshot: Database.Statement<[string, string, string, number, string, string], unknown>
  private readonly stSnapshots: Database.Statement<[string], SnapshotSqlRow>
  private readonly stSnapshotAtOrBefore: Database.Statement<[string, number], SnapshotSqlRow>
  private readonly stSnapshotByCommit: Database.Statement<[string, string], SnapshotSqlRow>
  private readonly stHasSnapshot: Database.Statement<[string, string], { one: number }>
  private readonly stUpsertRepo: Database.Statement<
    [string, string, string, string, string | null, string, string | null, string, string, number],
    unknown
  >
  private readonly stListRepos: Database.Statement<[], RepoRow>
  private readonly stGetRepo: Database.Statement<[string], RepoRow>
  private readonly stDelRepo: Database.Statement<[string], unknown>
  private readonly stDelRepoSnapshots: Database.Statement<[string], unknown>
  private readonly stDelRepoScanState: Database.Statement<[string], unknown>
  private readonly stGetScanState: Database.Statement<[string], ScanStateSqlRow>

  private readonly txPutBlobs: Database.Transaction<(rows: readonly BlobAnalysis[]) => void>
  private readonly txPutSnapshots: Database.Transaction<(rows: readonly SnapshotInput[]) => void>
  private readonly txRemoveRepo: Database.Transaction<(id: string) => void>
  private readonly txVacuum: Database.Transaction<(keep: ReadonlySet<string>, excess: number) => number>

  /**
   * Prefer {@link openDb}. This constructor exists so tools and tests can point
   * at an explicit file (including `:memory:`).
   */
  constructor(file: string) {
    this.file = file
    this.db = new Database(file)

    // WAL lets the main process read repo metadata while a scan is writing, and
    // survives a hard kill without the rollback-journal fsync tax. NORMAL is
    // the documented companion to WAL: durable across process crashes, and at
    // worst loses the last transaction on OS/power loss — acceptable for a
    // cache whose source of truth is the git repositories on disk.
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    // Two processes may hold this file open (main + analyzer utility process).
    this.db.pragma('busy_timeout = 5000')
    // 32 MiB of page cache. `getBlobs` does scattered point lookups over a table
    // that can reach 500k rows; keeping its upper b-tree levels resident is the
    // cheapest available win.
    this.db.pragma('cache_size = -32000')

    this.schemaVersion = migrate(this.db).to

    this.stPutBlob = this.db.prepare(PUT_BLOB_SQL)
    this.stCountBlobs = this.db.prepare('SELECT COUNT(*) AS n FROM blobs')

    this.stPutSnapshot = this.db.prepare(PUT_SNAPSHOT_SQL)
    this.stSnapshots = this.db.prepare(
      `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE repo_id = ? ORDER BY committed_at ASC, id ASC`
    )
    this.stSnapshotAtOrBefore = this.db.prepare(
      `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots
       WHERE repo_id = ? AND committed_at <= ?
       ORDER BY committed_at DESC, id DESC LIMIT 1`
    )
    this.stSnapshotByCommit = this.db.prepare(
      `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE repo_id = ? AND commit_sha = ?`
    )
    this.stHasSnapshot = this.db.prepare(
      'SELECT 1 AS one FROM snapshots WHERE repo_id = ? AND commit_sha = ? LIMIT 1'
    )

    this.stUpsertRepo = this.db.prepare(UPSERT_REPO_SQL)
    this.stListRepos = this.db.prepare(`SELECT ${REPO_COLUMNS} FROM repos ORDER BY added_at ASC, name ASC`)
    this.stGetRepo = this.db.prepare(`SELECT ${REPO_COLUMNS} FROM repos WHERE id = ?`)
    this.stDelRepo = this.db.prepare('DELETE FROM repos WHERE id = ?')
    this.stDelRepoSnapshots = this.db.prepare('DELETE FROM snapshots WHERE repo_id = ?')
    this.stDelRepoScanState = this.db.prepare('DELETE FROM scan_state WHERE repo_id = ?')

    this.stGetScanState = this.db.prepare(
      'SELECT repo_id, last_head, last_scanned_at, history_json FROM scan_state WHERE repo_id = ?'
    )

    this.txPutBlobs = this.db.transaction((rows: readonly BlobAnalysis[]): void => {
      // One timestamp for the whole batch: eviction order is per-batch, tie-
      // broken by sha, which makes vacuumBlobs deterministic.
      const now = Date.now()
      for (const b of rows) {
        this.stPutBlob.run(
          b.sha,
          toInt(b.bytes),
          toInt(b.lines),
          toIntOrNull(b.codeLines),
          b.language,
          b.binary ? 1 : 0,
          toIntOrNull(b.functions),
          toIntOrNull(b.totalComplexity),
          toIntOrNull(b.maxComplexity),
          toIntOrNull(b.complexFunctions),
          b.simhash,
          now
        )
      }
    })

    this.txPutSnapshots = this.db.transaction((rows: readonly SnapshotInput[]): void => {
      for (const s of rows) {
        this.stPutSnapshot.run(
          s.repoId,
          s.commitSha,
          s.date,
          toInt(s.committedAt),
          JSON.stringify(s.facts),
          JSON.stringify(s.signals)
        )
      }
    })

    this.txRemoveRepo = this.db.transaction((id: string): void => {
      // Blobs are content-addressed and shared across every repository; they are
      // never deleted here. vacuumBlobs is the only thing that evicts them.
      this.stDelRepoSnapshots.run(id)
      this.stDelRepoScanState.run(id)
      this.stDelRepo.run(id)
    })

    this.txVacuum = this.db.transaction((keep: ReadonlySet<string>, excess: number): number => {
      this.db.exec('DROP TABLE IF EXISTS temp.vde_keep')
      this.db.exec('CREATE TEMP TABLE vde_keep (sha TEXT PRIMARY KEY) WITHOUT ROWID')
      const ins = this.db.prepare<[string], unknown>('INSERT OR IGNORE INTO temp.vde_keep (sha) VALUES (?)')
      for (const sha of keep) ins.run(sha)
      // The subquery is uncorrelated, so SQLite materialises it before the
      // delete begins — reading and writing `blobs` in one statement is safe.
      const del = this.db.prepare<[number], unknown>(
        `DELETE FROM blobs WHERE sha IN (
           SELECT b.sha FROM blobs b
           WHERE NOT EXISTS (SELECT 1 FROM temp.vde_keep k WHERE k.sha = b.sha)
           ORDER BY b.inserted_at ASC, b.sha ASC
           LIMIT ?
         )`
      )
      const removed = del.run(excess).changes
      this.db.exec('DROP TABLE IF EXISTS temp.vde_keep')
      return removed
    })
  }

  // -------------------------------------------------------------------------
  // Blob cache
  // -------------------------------------------------------------------------

  /**
   * Batched lookup of the content-addressed blob cache.
   *
   * Input is de-duplicated (a tree routinely contains the same blob at several
   * paths) and split into chunks of at most {@link CHUNK_LIMIT} placeholders,
   * because SQLite rejects a statement with more than 999 bound parameters.
   * Shas with no cached analysis are simply absent from the result.
   */
  getBlobs(shas: readonly string[]): Map<string, BlobAnalysis> {
    const out = new Map<string, BlobAnalysis>()
    if (shas.length === 0) return out

    const unique = shas.length === 1 ? shas : Array.from(new Set(shas))

    for (let i = 0; i < unique.length; i += CHUNK_LIMIT) {
      const chunk = unique.slice(i, i + CHUNK_LIMIT)
      const width = widthFor(chunk.length)
      const params = chunk.length === width ? chunk : padTo(chunk, width)
      for (const row of this.blobSelect(width).all(...params)) {
        out.set(row.sha, fromBlobRow(row))
      }
    }
    return out
  }

  /**
   * Inserts or refreshes blob analyses. One transaction, one reused prepared
   * statement — this is the scan's hot write path and routinely sees tens of
   * thousands of rows.
   */
  putBlobs(rows: readonly BlobAnalysis[]): void {
    if (rows.length === 0) return
    this.txPutBlobs(rows)
  }

  /** Total rows in the global blob cache. */
  countBlobs(): number {
    return this.stCountBlobs.get()?.n ?? 0
  }

  private blobSelect(width: number): BlobSelect {
    const cached = this.blobSelects.get(width)
    if (cached) return cached
    const placeholders = new Array<string>(width).fill('?').join(',')
    const stmt = this.db.prepare<string[], BlobRow>(
      `SELECT ${BLOB_COLUMNS} FROM blobs WHERE sha IN (${placeholders})`
    )
    this.blobSelects.set(width, stmt)
    return stmt
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  putSnapshot(
    repoId: string,
    commitSha: string,
    date: string,
    committedAt: number,
    facts: SnapshotFacts,
    signals: SnapshotSignals
  ): void {
    // A single statement is already atomic; no transaction needed.
    this.stPutSnapshot.run(
      repoId,
      commitSha,
      date,
      toInt(committedAt),
      JSON.stringify(facts),
      JSON.stringify(signals)
    )
  }

  /**
   * Batched form used by the retroactive backfill. All-or-nothing: an
   * interrupted backfill leaves no partial run behind.
   */
  putSnapshots(rows: readonly SnapshotInput[]): void {
    if (rows.length === 0) return
    this.txPutSnapshots(rows)
  }

  /** Ascending by committed_at — the order every chart wants. */
  getSnapshots(repoId: string): SnapshotRow[] {
    return this.stSnapshots.all(repoId).map(fromSnapshotRow)
  }

  /** Newest snapshot at or before `epochMs`. This is how baselines resolve. */
  getSnapshotAtOrBefore(repoId: string, epochMs: number): SnapshotRow | null {
    const row = this.stSnapshotAtOrBefore.get(repoId, toInt(epochMs))
    return row ? fromSnapshotRow(row) : null
  }

  getSnapshotByCommit(repoId: string, sha: string): SnapshotRow | null {
    const row = this.stSnapshotByCommit.get(repoId, sha)
    return row ? fromSnapshotRow(row) : null
  }

  /** Cheaper than getSnapshotByCommit: never parses the JSON payloads. */
  hasSnapshot(repoId: string, sha: string): boolean {
    return this.stHasSnapshot.get(repoId, sha) !== undefined
  }

  // -------------------------------------------------------------------------
  // Repos
  // -------------------------------------------------------------------------

  upsertRepo(ref: RepoRef): void {
    this.stUpsertRepo.run(
      ref.id,
      ref.path,
      ref.name,
      ref.addedAt,
      ref.lastScanAt,
      ref.head,
      ref.branch,
      ref.firstCommitAt,
      ref.lastCommitAt,
      toInt(ref.commitCount)
    )
  }

  /** In the order the user added them — the sidebar's order. */
  listRepos(): RepoRef[] {
    return this.stListRepos.all().map(fromRepoRow)
  }

  getRepo(id: string): RepoRef | null {
    const row = this.stGetRepo.get(id)
    return row ? fromRepoRow(row) : null
  }

  /**
   * Forgets a repository and everything derived from it. Blobs survive: they are
   * content-addressed, shared with every other repo, and expensive to rebuild.
   */
  removeRepo(id: string): void {
    this.txRemoveRepo(id)
  }

  // -------------------------------------------------------------------------
  // Scan state
  // -------------------------------------------------------------------------

  getScanState<H = unknown>(repoId: string): ScanState<H> | null {
    const row = this.stGetScanState.get(repoId)
    if (!row) return null
    return {
      repoId: row.repo_id,
      lastHead: row.last_head,
      lastScannedAt: row.last_scanned_at,
      history: unpackHistory<H>(row.history_json)
    }
  }

  /**
   * Applies a partial update, creating the row if needed.
   *
   * `history` is stored as gzip(JSON) in a BLOB column rather than base64 text:
   * base64 would add 33% on top of the compressed bytes and force a UTF-8
   * round trip on every read, for no benefit inside a file we own. See
   * {@link ScanStatePatch} for the undefined-versus-null semantics.
   */
  setScanState<H = unknown>(repoId: string, patch: ScanStatePatch<H>): void {
    const packed = patch.history !== undefined ? packHistory(patch.history) : null

    const assignments: string[] = []
    for (const [field, column] of SCAN_STATE_COLUMNS) {
      if (patch[field] !== undefined) assignments.push(`${column} = excluded.${column}`)
    }

    const tail = assignments.length === 0 ? 'DO NOTHING' : `DO UPDATE SET ${assignments.join(', ')}`
    const key = assignments.join('|')
    let stmt = this.scanStateUpserts.get(key)
    if (!stmt) {
      stmt = this.db.prepare<unknown[], unknown>(
        `INSERT INTO scan_state (repo_id, last_head, last_scanned_at, history_json)
         VALUES (?,?,?,?) ON CONFLICT(repo_id) ${tail}`
      )
      this.scanStateUpserts.set(key, stmt)
    }
    stmt.run(repoId, patch.lastHead ?? null, patch.lastScannedAt ?? null, packed)
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * Caps the global blob cache, evicting oldest-inserted first.
   *
   * Blobs in `keepShas` are never evicted regardless of age — they are the live
   * working set, and dropping them would force an immediate re-parse. If the
   * keep set alone exceeds the cap, nothing (or only part of the excess) is
   * removed; that is correct, since evicting live entries would cost more than
   * the space it reclaimed.
   *
   * Freed pages return to the file's freelist for reuse rather than to the OS;
   * the database does not shrink on disk, it stops growing.
   *
   * @returns the number of rows deleted.
   */
  vacuumBlobs(keepShas: ReadonlySet<string>, cap: number = MAX_BLOB_ROWS): number {
    const total = this.countBlobs()
    const excess = total - Math.max(0, Math.trunc(cap))
    if (excess <= 0) return 0
    return this.txVacuum(keepShas, excess)
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Idempotent. Safe to call from a shutdown handler that may fire twice. */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      // Lets SQLite refresh stale query-planner statistics it has noticed drift
      // in, and folds the WAL back into the main file so the -wal does not grow
      // without bound across sessions. Both are best-effort.
      this.db.pragma('optimize')
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      // A failed checkpoint (e.g. another connection still reading) costs disk
      // space, not correctness. Never block shutdown on it.
    }
    this.db.close()
  }

  get isOpen(): boolean {
    return !this.closed && this.db.open
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Opens (creating if needed) `<userDataPath>/vde.db`, applies pragmas and runs
 * migrations. This is the only function the analyzer bootstrap should call.
 */
export function openDb(userDataPath: string): Db {
  mkdirSync(userDataPath, { recursive: true })
  return new Db(join(userDataPath, DB_FILENAME))
}

/** Opens a database at an explicit file path. For tests and offline tooling. */
export function openDbFile(file: string): Db {
  return new Db(file)
}
