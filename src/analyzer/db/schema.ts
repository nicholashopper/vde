/**
 * The on-disk schema, and the forward-only migration runner that installs it.
 *
 * VDE's database is a *cache with an index*, not a system of record: the git
 * repositories on disk are the only truth. That shapes three decisions here.
 *
 *   1. `blobs` is content-addressed by git blob sha, so a row is valid forever
 *      and is shared across every repository the user has added. This is the
 *      single most important property in the whole engine — it is what makes a
 *      180-snapshot retroactive backfill affordable, because an unchanged file
 *      is parsed once rather than once per snapshot.
 *   2. `snapshots` and `scan_state` are derived and disposable. Deleting a repo
 *      deletes both; it never deletes blobs.
 *   3. Migrations are forward-only. A database written by a newer VDE is
 *      refused rather than downgraded, because a downgrade could only be
 *      implemented by throwing away columns a future version needs.
 *
 * Migrations run inside a transaction. SQLite's DDL is transactional, so a
 * crash mid-migration leaves the database at the previous version rather than
 * half-migrated.
 */

import type Database from 'better-sqlite3'

/** The instance type of a better-sqlite3 connection. */
export type SqliteDb = Database.Database

export class SchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaError'
  }
}

// ---------------------------------------------------------------------------
// meta — the bootstrap table
// ---------------------------------------------------------------------------

/**
 * Created before any migration runs, because the migration runner has to read
 * the current version out of it. Every migration is also free to write here.
 */
const META_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export const META_SCHEMA_VERSION = 'schema_version'
export const META_CREATED_AT = 'created_at'

export function getMeta(db: SqliteDb, key: string): string | null {
  const row = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? row.value : null
}

export function setMeta(db: SqliteDb, key: string, value: string): void {
  db.prepare<[string, string], unknown>(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

// ---------------------------------------------------------------------------
// Version 1
// ---------------------------------------------------------------------------

/**
 * `blobs` is WITHOUT ROWID deliberately. The table is keyed by a 40-character
 * sha and every read is a point lookup on that key; a rowid table would store
 * the sha twice (once in the automatic unique index, once in the row) and cost
 * an extra b-tree descent per lookup. Rows here are ~100 bytes, comfortably
 * inside the <1/20-of-a-page guidance for WITHOUT ROWID. Because the primary
 * key *is* the table, no separate index on blobs(sha) exists or is needed.
 *
 * `inserted_at` exists only so `vacuumBlobs` can evict oldest-first. It is
 * deliberately not indexed: the GC runs rarely and can afford a scan-and-sort,
 * whereas a secondary index would cost ~25 MB at the 500k-row cap and slow down
 * the hot insert path forever.
 *
 * `snapshots.repo_id` and `scan_state.repo_id` carry no FOREIGN KEY. A scan
 * legitimately writes snapshots while it is still discovering the facts
 * (head, commit count, first/last commit dates) that the repos row is built
 * from, so the repo row is often finalised *after* its snapshots. `removeRepo`
 * therefore performs the cascade itself, inside one transaction.
 */
const V1_DDL = `
${META_DDL}

CREATE TABLE IF NOT EXISTS repos (
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  added_at        TEXT NOT NULL,
  last_scan_at    TEXT,
  head            TEXT NOT NULL DEFAULT '',
  branch          TEXT,
  first_commit_at TEXT NOT NULL DEFAULT '',
  last_commit_at  TEXT NOT NULL DEFAULT '',
  commit_count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS blobs (
  sha               TEXT PRIMARY KEY,
  bytes             INTEGER NOT NULL,
  lines             INTEGER NOT NULL,
  code_lines        INTEGER,
  language          TEXT,
  binary            INTEGER NOT NULL,
  functions         INTEGER,
  total_complexity  INTEGER,
  max_complexity    INTEGER,
  complex_functions INTEGER,
  simhash           TEXT,
  inserted_at       INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id      TEXT NOT NULL,
  commit_sha   TEXT NOT NULL,
  date         TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  facts_json   TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  UNIQUE (repo_id, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_repo_time ON snapshots (repo_id, committed_at);

CREATE TABLE IF NOT EXISTS scan_state (
  repo_id         TEXT PRIMARY KEY,
  last_head       TEXT,
  last_scanned_at TEXT,
  history_json    BLOB
);
`

// ---------------------------------------------------------------------------
// The migration ledger
// ---------------------------------------------------------------------------

export interface Migration {
  /** Strictly increasing, starting at 1. */
  version: number
  /** Short identifier, surfaced in errors and logs. */
  name: string
  /** Runs inside a transaction. Must be idempotent-safe on retry after crash. */
  up(db: SqliteDb): void
}

/**
 * Append-only. Never edit a migration that has shipped — add another one.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: (db) => {
      db.exec(V1_DDL)
      setMeta(db, META_CREATED_AT, new Date().toISOString())
    }
  }
]

/** The version a freshly migrated database ends up at. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Reads the installed schema version. 0 means "nothing installed yet". */
export function currentVersion(db: SqliteDb): number {
  db.exec(META_DDL)
  const raw = getMeta(db, META_SCHEMA_VERSION)
  if (raw === null) return 0
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || n < 0) {
    throw new SchemaError(`meta.${META_SCHEMA_VERSION} holds "${raw}", which is not a schema version.`)
  }
  return n
}

export interface MigrationOutcome {
  from: number
  to: number
  /** Versions applied by this call, in order. Empty when already current. */
  applied: number[]
}

/**
 * Brings the database up to {@link SCHEMA_VERSION}, applying each pending
 * migration in its own transaction so a failure leaves the last *complete*
 * version installed.
 *
 * Throws if the database is newer than this build understands: silently
 * operating on a schema from the future is how caches become corrupt.
 */
export function migrate(db: SqliteDb): MigrationOutcome {
  const from = currentVersion(db)

  if (from > SCHEMA_VERSION) {
    throw new SchemaError(
      `This database was written by a newer version of VDE (schema v${from}; this build understands v${SCHEMA_VERSION}). ` +
        `Migrations are forward-only, so VDE will not open it. Upgrade VDE, or remove the database file to start fresh.`
    )
  }

  const applied: number[] = []
  // Sorted defensively: the ledger is authored in order, but ordering is a
  // correctness requirement rather than a convention.
  const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version)

  for (const m of pending) {
    const run = db.transaction(() => {
      m.up(db)
      setMeta(db, META_SCHEMA_VERSION, String(m.version))
    })
    try {
      run()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new SchemaError(`Migration ${m.version} (${m.name}) failed and was rolled back: ${reason}`)
    }
    applied.push(m.version)
  }

  return { from, to: SCHEMA_VERSION, applied }
}
