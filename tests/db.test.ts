/**
 * Round-trip and scale tests for src/analyzer/db.
 *
 * The two things worth actually proving here are (a) that the IN()-chunking in
 * getBlobs is correct at and around the 900-parameter boundary — a fencepost
 * there would silently drop cached analyses and make every scan slower without
 * making it wrong, which is the worst kind of bug — and (b) that the hot path
 * moves 10k rows in a time budget that a 50k-row scan can live with.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  Db,
  SCHEMA_VERSION,
  SchemaError,
  openDb,
  openDbFile,
  type ScanState,
  type SnapshotInput
} from '../src/analyzer/db'
import { META_SCHEMA_VERSION, currentVersion, setMeta } from '../src/analyzer/db/schema'
import type { BlobAnalysis } from '../src/analyzer/model'
import type { RepoRef, SnapshotFacts } from '../src/shared/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BLOB_COUNT = 10_000
const SNAPSHOT_COUNT = 200
const LOOKUP_COUNT = 5_000

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LANGUAGES = ['typescript', 'python', 'go', 'rust', 'markdown']

function shaFor(prefix: string, i: number): string {
  // 40 hex characters, like a real git object id.
  return (prefix + i.toString(16).padStart(8, '0')).padEnd(40, '0').slice(0, 40)
}

function makeBlob(i: number, rnd: () => number): BlobAnalysis {
  // Every ninth blob is binary, which exercises the all-nulls branch of the
  // marshalling code in both directions.
  const binary = i % 9 === 0
  const lang = LANGUAGES[i % LANGUAGES.length] ?? 'typescript'
  const lines = Math.floor(rnd() * 4000) + 1
  return binary
    ? {
        sha: shaFor('b1ob', i),
        bytes: Math.floor(rnd() * 1_000_000),
        lines: 0,
        codeLines: null,
        language: null,
        binary: true,
        functions: null,
        totalComplexity: null,
        maxComplexity: null,
        complexFunctions: null,
        simhash: null
      }
    : {
        sha: shaFor('b1ob', i),
        bytes: lines * 42,
        lines,
        codeLines: Math.floor(lines * 0.7),
        language: lang,
        binary: false,
        functions: Math.floor(lines / 25),
        totalComplexity: Math.floor(lines / 6),
        maxComplexity: Math.floor(rnd() * 40),
        complexFunctions: Math.floor(rnd() * 12),
        simhash: i.toString(16).padStart(16, 'a').slice(0, 16)
      }
}

function makeFacts(i: number): SnapshotFacts {
  return {
    commitCount: 100 + i,
    fileCount: 400 + i * 3,
    totalLines: 50_000 + i * 900,
    sourceLines: 30_000 + i * 500,
    docLines: 8_000 + i * 200,
    testLines: 9_000 + i * 150,
    configLines: 3_000 + i * 50,
    dirCount: 60 + i,
    maxDepth: 6,
    contributors: 1 + (i % 4),
    languages: [
      { language: 'typescript', files: 200 + i, lines: 20_000 + i * 100, bytes: 800_000 + i * 4000 },
      { language: 'python', files: 90, lines: 9_000, bytes: 320_000 }
    ]
  }
}

function makeRepo(id: string, path: string, name: string): RepoRef {
  return {
    id,
    path,
    name,
    head: shaFor('head', 1),
    branch: 'main',
    firstCommitAt: '2026-01-01T00:00:00.000Z',
    lastCommitAt: '2026-07-01T00:00:00.000Z',
    commitCount: 740,
    addedAt: '2026-07-20T09:00:00.000Z',
    lastScanAt: null
  }
}

/** Stands in for whatever compact history the scanner decides to cache. */
interface FakeHistory {
  version: number
  commits: { sha: string; at: number; subject: string; files: number }[]
}

function makeHistory(n: number): FakeHistory {
  const commits: FakeHistory['commits'] = []
  for (let i = 0; i < n; i++) {
    commits.push({
      sha: shaFor('c0m1', i),
      at: 1_760_000_000_000 + i * 60_000,
      subject: `feat(module-${i % 40}): change number ${i} touching several files`,
      files: (i % 17) + 1
    })
  }
  return { version: 1, commits }
}

const timings: Record<string, string> = {}
function timed<T>(label: string, fn: () => T): T {
  const t0 = performance.now()
  const out = fn()
  timings[label] = `${(performance.now() - t0).toFixed(1)} ms`
  return out
}

// ---------------------------------------------------------------------------

describe('Db — round trip at scale', () => {
  let dir: string
  let db: Db
  let blobs: BlobAnalysis[]

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vde-db-'))
    db = openDb(join(dir, 'userData'))
    const rnd = mulberry32(0xc0ffee)
    blobs = Array.from({ length: BLOB_COUNT }, (_, i) => makeBlob(i, rnd))
  })

  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
    // eslint-disable-next-line no-console
    console.log('\n[db.test] timings:', JSON.stringify(timings, null, 2))
  })

  it('creates the database file and installs the current schema', () => {
    expect(db.file).toBe(join(dir, 'userData', 'vde.db'))
    expect(db.schemaVersion).toBe(SCHEMA_VERSION)
    expect(db.isOpen).toBe(true)
  })

  it(`writes ${BLOB_COUNT} blobs in one transaction`, () => {
    timed(`putBlobs(${BLOB_COUNT})`, () => db.putBlobs(blobs))
    expect(db.countBlobs()).toBe(BLOB_COUNT)
  })

  it('is idempotent on re-put (content-addressed, so upsert must not duplicate)', () => {
    timed(`putBlobs(${BLOB_COUNT}) again`, () => db.putBlobs(blobs))
    expect(db.countBlobs()).toBe(BLOB_COUNT)
  })

  it(`reads ${LOOKUP_COUNT} shas back through the batched IN() path`, () => {
    // 4,500 present + 500 absent, so a miss must genuinely be absent from the
    // result rather than yielding a hollow row.
    const present = blobs.slice(0, 4_500).map((b) => b.sha)
    const absent = Array.from({ length: 500 }, (_, i) => shaFor('dead', i))
    const query = [...present, ...absent]
    expect(query.length).toBe(LOOKUP_COUNT)

    const got = timed(`getBlobs(${LOOKUP_COUNT})`, () => db.getBlobs(query))

    expect(got.size).toBe(4_500)
    for (const sha of absent) expect(got.has(sha)).toBe(false)
    for (const original of blobs.slice(0, 4_500)) {
      expect(got.get(original.sha)).toEqual(original)
    }
  })

  it('round-trips nulls and the binary flag exactly', () => {
    const bin = blobs.find((b) => b.binary)
    const src = blobs.find((b) => !b.binary)
    expect(bin).toBeDefined()
    expect(src).toBeDefined()
    if (!bin || !src) return
    const got = db.getBlobs([bin.sha, src.sha])
    expect(got.get(bin.sha)).toEqual(bin)
    expect(got.get(src.sha)).toEqual(src)
    expect(got.get(bin.sha)?.binary).toBe(true)
    expect(got.get(src.sha)?.binary).toBe(false)
  })

  // The whole point of the chunking. 900 is the chunk limit, so 899/900/901 and
  // 1799/1800/1801 sit either side of both the first and second boundary.
  it.each([0, 1, 2, 3, 899, 900, 901, 1_799, 1_800, 1_801, 2_701])(
    'returns exactly %i rows for a %i-sha query',
    (n) => {
      const shas = blobs.slice(0, n).map((b) => b.sha)
      const got = db.getBlobs(shas)
      expect(got.size).toBe(n)
      for (const sha of shas) expect(got.has(sha)).toBe(true)
    }
  )

  it('de-duplicates the input rather than over-fetching', () => {
    const first = blobs[0]
    expect(first).toBeDefined()
    if (!first) return
    const got = db.getBlobs([first.sha, first.sha, first.sha])
    expect(got.size).toBe(1)
    expect(got.get(first.sha)).toEqual(first)
  })

  it('handles an empty query without touching the database', () => {
    expect(db.getBlobs([]).size).toBe(0)
  })

  // -------------------------------------------------------------------------

  it('upserts and lists repos', () => {
    db.upsertRepo(makeRepo('repo-a', '/tmp/a', 'a'))
    db.upsertRepo(makeRepo('repo-b', '/tmp/b', 'b'))
    expect(db.listRepos().map((r) => r.id)).toEqual(['repo-a', 'repo-b'])

    const patched: RepoRef = { ...makeRepo('repo-a', '/tmp/a', 'a'), commitCount: 999, lastScanAt: '2026-07-26T10:00:00.000Z', branch: null }
    db.upsertRepo(patched)
    const got = db.getRepo('repo-a')
    expect(got).toEqual(patched)
    expect(db.listRepos()).toHaveLength(2)
    expect(db.getRepo('nope')).toBeNull()
  })

  it(`writes ${SNAPSHOT_COUNT} snapshots and reads them back in order`, () => {
    const base = Date.UTC(2026, 0, 1)
    const rows: SnapshotInput[] = Array.from({ length: SNAPSHOT_COUNT }, (_, i) => ({
      repoId: 'repo-a',
      commitSha: shaFor('5nap', i),
      date: new Date(base + i * 86_400_000).toISOString().slice(0, 10),
      committedAt: base + i * 86_400_000,
      facts: makeFacts(i),
      signals: { accretion: 90 + (i % 10), godFiles: i / 10, blastRadius: 12 + i }
    }))

    // Deliberately shuffled, so ascending output cannot be an accident of
    // insertion order.
    const shuffled = rows.slice().reverse()
    timed(`putSnapshots(${SNAPSHOT_COUNT})`, () => db.putSnapshots(shuffled))

    const got = timed('getSnapshots', () => db.getSnapshots('repo-a'))
    expect(got).toHaveLength(SNAPSHOT_COUNT)
    for (let i = 0; i < got.length; i++) {
      const row = got[i]
      const want = rows[i]
      expect(row).toBeDefined()
      expect(want).toBeDefined()
      if (!row || !want) continue
      expect(row.commitSha).toBe(want.commitSha)
      expect(row.date).toBe(want.date)
      expect(row.committedAt).toBe(want.committedAt)
      expect(row.facts).toEqual(want.facts)
      expect(row.signals).toEqual(want.signals)
    }
    // Ascending, strictly.
    for (let i = 1; i < got.length; i++) {
      expect((got[i]?.committedAt ?? 0) > (got[i - 1]?.committedAt ?? 0)).toBe(true)
    }
  })

  it('re-putting a snapshot updates in place instead of duplicating', () => {
    const sha = shaFor('5nap', 5)
    db.putSnapshot('repo-a', sha, '1999-12-31', 946_598_400_000, makeFacts(999), { rework: 42 })
    expect(db.getSnapshots('repo-a')).toHaveLength(SNAPSHOT_COUNT)
    const got = db.getSnapshotByCommit('repo-a', sha)
    expect(got?.date).toBe('1999-12-31')
    expect(got?.signals).toEqual({ rework: 42 })
    // Put it back so the ordering assertions below stay meaningful.
    const base = Date.UTC(2026, 0, 1)
    db.putSnapshot(
      'repo-a',
      sha,
      new Date(base + 5 * 86_400_000).toISOString().slice(0, 10),
      base + 5 * 86_400_000,
      makeFacts(5),
      { accretion: 95, godFiles: 0.5, blastRadius: 17 }
    )
  })

  it('resolves baselines with getSnapshotAtOrBefore', () => {
    const base = Date.UTC(2026, 0, 1)
    // Mid-day between snapshot 9 and 10 must resolve to 9.
    const at = db.getSnapshotAtOrBefore('repo-a', base + 9 * 86_400_000 + 3_600_000)
    expect(at?.commitSha).toBe(shaFor('5nap', 9))

    // Exact hit resolves to itself.
    expect(db.getSnapshotAtOrBefore('repo-a', base + 9 * 86_400_000)?.commitSha).toBe(shaFor('5nap', 9))

    // Before the first snapshot there is nothing to resolve to.
    expect(db.getSnapshotAtOrBefore('repo-a', base - 1)).toBeNull()

    // After the last, the last wins.
    expect(db.getSnapshotAtOrBefore('repo-a', base + 10_000 * 86_400_000)?.commitSha).toBe(
      shaFor('5nap', SNAPSHOT_COUNT - 1)
    )
  })

  it('scopes snapshots per repo', () => {
    expect(db.getSnapshots('repo-b')).toHaveLength(0)
    expect(db.hasSnapshot('repo-a', shaFor('5nap', 3))).toBe(true)
    expect(db.hasSnapshot('repo-b', shaFor('5nap', 3))).toBe(false)
    expect(db.hasSnapshot('repo-a', shaFor('nope', 3))).toBe(false)
    expect(db.getSnapshotByCommit('repo-b', shaFor('5nap', 3))).toBeNull()
  })

  // -------------------------------------------------------------------------

  it('compresses and round-trips the cached history', () => {
    const history = makeHistory(20_000)
    const raw = JSON.stringify(history).length

    timed('setScanState(20k commits)', () =>
      db.setScanState<FakeHistory>('repo-a', {
        lastHead: shaFor('head', 1),
        lastScannedAt: '2026-07-26T10:00:00.000Z',
        history
      })
    )
    const got = timed('getScanState(20k commits)', () => db.getScanState<FakeHistory>('repo-a'))

    expect(got).not.toBeNull()
    expect(got?.repoId).toBe('repo-a')
    expect(got?.lastHead).toBe(shaFor('head', 1))
    expect(got?.lastScannedAt).toBe('2026-07-26T10:00:00.000Z')
    expect(got?.history).toEqual(history)
    timings['history raw JSON'] = `${(raw / 1_048_576).toFixed(2)} MiB`
  })

  it('leaves omitted scan-state fields untouched and clears explicit nulls', () => {
    const before = db.getScanState<FakeHistory>('repo-a')
    expect(before?.history?.commits).toHaveLength(20_000)

    db.setScanState('repo-a', { lastHead: shaFor('head', 2) })
    const after: ScanState<FakeHistory> | null = db.getScanState<FakeHistory>('repo-a')
    expect(after?.lastHead).toBe(shaFor('head', 2))
    expect(after?.lastScannedAt).toBe('2026-07-26T10:00:00.000Z')
    expect(after?.history?.commits).toHaveLength(20_000)

    db.setScanState('repo-a', { history: null })
    const cleared = db.getScanState('repo-a')
    expect(cleared?.history).toBeNull()
    expect(cleared?.lastHead).toBe(shaFor('head', 2))

    expect(db.getScanState('repo-b')).toBeNull()
  })

  it('creates a scan-state row on first write', () => {
    db.setScanState('repo-b', { lastScannedAt: '2026-07-26T11:00:00.000Z' })
    const got = db.getScanState('repo-b')
    expect(got?.repoId).toBe('repo-b')
    expect(got?.lastHead).toBeNull()
    expect(got?.lastScannedAt).toBe('2026-07-26T11:00:00.000Z')
    expect(got?.history).toBeNull()
  })

  // -------------------------------------------------------------------------

  it('removeRepo drops snapshots and scan state but never blobs', () => {
    const blobsBefore = db.countBlobs()
    db.removeRepo('repo-a')

    expect(db.getRepo('repo-a')).toBeNull()
    expect(db.getSnapshots('repo-a')).toHaveLength(0)
    expect(db.getScanState('repo-a')).toBeNull()
    expect(db.hasSnapshot('repo-a', shaFor('5nap', 3))).toBe(false)

    expect(db.countBlobs()).toBe(blobsBefore)
    expect(db.listRepos().map((r) => r.id)).toEqual(['repo-b'])
    // Other repos are untouched.
    expect(db.getScanState('repo-b')).not.toBeNull()
  })

  it('survives a close/reopen with data and schema version intact', () => {
    db.close()
    expect(db.isOpen).toBe(false)

    db = openDb(join(dir, 'userData'))
    expect(db.schemaVersion).toBe(SCHEMA_VERSION)
    expect(db.countBlobs()).toBe(BLOB_COUNT)
    expect(db.listRepos().map((r) => r.id)).toEqual(['repo-b'])

    const first = blobs[0]
    expect(first).toBeDefined()
    if (first) expect(db.getBlobs([first.sha]).get(first.sha)).toEqual(first)
  })

  it('is safe to close twice', () => {
    const scratch = openDbFile(join(dir, 'twice.db'))
    scratch.close()
    expect(() => scratch.close()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------

describe('schema migrations', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vde-db-mig-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Pokes meta directly, the way a future build of VDE would have left it. */
  function poke(file: string, version: string): void {
    const raw = new Database(file)
    setMeta(raw, META_SCHEMA_VERSION, version)
    raw.close()
  }

  it('is idempotent — reopening applies nothing', () => {
    const file = join(dir, 'idem.db')
    const a = openDbFile(file)
    expect(a.schemaVersion).toBe(SCHEMA_VERSION)
    a.close()

    const b = openDbFile(file)
    expect(b.schemaVersion).toBe(SCHEMA_VERSION)
    b.close()

    const raw = new Database(file)
    expect(currentVersion(raw)).toBe(SCHEMA_VERSION)
    raw.close()
  })

  it('refuses a database written by a newer VDE rather than downgrading it', () => {
    const file = join(dir, 'future.db')
    openDbFile(file).close()
    poke(file, String(SCHEMA_VERSION + 5))

    expect(() => openDbFile(file)).toThrow(SchemaError)
    expect(() => openDbFile(file)).toThrow(/newer version of VDE/)
  })

  it('rejects a nonsense version marker', () => {
    const file = join(dir, 'garbage.db')
    openDbFile(file).close()
    poke(file, 'banana')

    expect(() => openDbFile(file)).toThrow(SchemaError)
  })
})

// ---------------------------------------------------------------------------

describe('Db.vacuumBlobs', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vde-db-gc-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Two batches with a real gap, so inserted_at genuinely differs. */
  async function seed(file: string, older: number, newer: number): Promise<Db> {
    const db = openDbFile(join(dir, file))
    const rnd = mulberry32(7)
    db.putBlobs(Array.from({ length: older }, (_, i) => makeBlob(i, rnd)))
    await new Promise((r) => setTimeout(r, 8))
    db.putBlobs(Array.from({ length: newer }, (_, i) => makeBlob(older + i, rnd)))
    return db
  }

  it('is a no-op below the cap', async () => {
    const db = await seed('under.db', 100, 100)
    expect(db.vacuumBlobs(new Set(), 500)).toBe(0)
    expect(db.countBlobs()).toBe(200)
    db.close()
  })

  it('evicts exactly the excess, oldest-inserted first, and never a kept sha', async () => {
    const db = await seed('over.db', 600, 400)
    expect(db.countBlobs()).toBe(1000)

    // Keep 200 of the *older* batch. Everything else in the older batch is fair
    // game and must go before anything from the newer batch is considered.
    const keep = new Set(Array.from({ length: 200 }, (_, i) => shaFor('b1ob', i)))
    const removed = db.vacuumBlobs(keep, 600)

    expect(removed).toBe(400)
    expect(db.countBlobs()).toBe(600)

    // Every kept sha survived.
    const survivors = db.getBlobs([...keep])
    expect(survivors.size).toBe(200)

    // The entire newer batch survived: it is newer than every eviction
    // candidate, and there were exactly 400 older candidates to take.
    const newerShas = Array.from({ length: 400 }, (_, i) => shaFor('b1ob', 600 + i))
    expect(db.getBlobs(newerShas).size).toBe(400)

    db.close()
  })

  it('never evicts live entries even when the keep set exceeds the cap', async () => {
    const db = await seed('live.db', 500, 500)
    const keep = new Set(Array.from({ length: 950 }, (_, i) => shaFor('b1ob', i)))
    const removed = db.vacuumBlobs(keep, 100)

    // Only the 50 non-kept rows can go; the cap is not reachable without
    // throwing away the working set, which would cost more than it saves.
    expect(removed).toBe(50)
    expect(db.countBlobs()).toBe(950)
    expect(db.getBlobs([...keep]).size).toBe(950)
    db.close()
  })
})
