/**
 * Retroactive snapshots.
 *
 * Every sparkline in VDE is drawn from this: the full fourteen-signal analysis,
 * recomputed at up to a couple of hundred historical revisions so a user can see
 * not just that accretion is at 94% but that it was 71% a month ago. Nothing
 * else in the product answers "is this getting worse", which is the question the
 * whole app exists for.
 *
 * WHY THIS IS AFFORDABLE. Naively, N snapshots of a 4,000-file repository means
 * 4,000 x N blob reads and tree-sitter parses — on the reference specimen, about
 * 760,000 parses for 180 snapshots. It is instead about 6,000, because
 * `BlobAnalysis` is cached against the git blob sha and a file that did not
 * change between two revisions is read once, ever. The per-snapshot cost that
 * remains is one `ls-tree`, one batched cache lookup, and the pure-function
 * signal pass. Measured hit rates are reported through {@link BackfillResult} so
 * this claim is checkable rather than asserted.
 *
 * CANCELLATION. Each snapshot is a second or two of work, so checking the abort
 * signal only between revisions would leave a user waiting after they clicked
 * stop. It is checked between revisions *and* inside the content loop
 * (see snapshots/compute.ts), which yields to the event loop periodically for
 * exactly that reason.
 */

import type { SignalId, Settings } from '../../shared/types'
import type { Db, SnapshotSignals } from '../db'
import { pickSnapshotRevisions, type SnapshotRevision } from '../git/tree'
import type { History } from '../model'
import { Cancelled } from '../model'
import { runSignals } from '../signals'
import { buildContext, computeFacts, newBlobCacheStats, type BlobCacheStats } from './compute'

export interface BackfillOptions {
  /** Recompute revisions already stored, ignoring the snapshot cache. */
  force?: boolean
  /** Overrides `Settings.maxSnapshots`. */
  maxSnapshots?: number
}

export interface BackfillResult {
  /** Revisions `pickSnapshotRevisions` chose. */
  total: number
  /** Revisions analysed on this run. */
  computed: number
  /** Revisions already in the database and left alone. */
  skipped: number
  /** Blob-cache behaviour across the whole run. */
  cache: BlobCacheStats
  /** hits / (hits + misses), or 1 when nothing needed resolving. */
  cacheHitRate: number
  /** Wall-clock milliseconds. */
  elapsedMs: number
  /** Non-fatal problems, for RepoReport.warnings. */
  warnings: string[]
}

/** Called with (revisions finished, revisions total). */
export type BackfillProgress = (current: number, total: number, revision: SnapshotRevision) => void

/** Warnings are deduplicated and bounded; one broken blob must not flood the UI. */
const MAX_WARNINGS = 50

/**
 * Walks the chosen revisions, computing and storing a snapshot for each.
 *
 * Revisions arrive chronologically ascending, which is deliberate: consecutive
 * snapshots share most of their blobs, so walking in order keeps the SQLite page
 * cache warm on exactly the rows the next revision will ask for.
 *
 * Snapshots are written one at a time rather than batched at the end. A scan
 * that is cancelled — or that crashes — after ninety revisions should keep those
 * ninety; `putSnapshot` is a single atomic statement, so each is durable the
 * moment it lands.
 */
export async function backfill(
  repoPath: string,
  repoId: string,
  history: History,
  db: Db,
  settings: Settings,
  onProgress?: BackfillProgress,
  signal?: AbortSignal,
  opts: BackfillOptions = {}
): Promise<BackfillResult> {
  const startedAt = Date.now()
  const cache = newBlobCacheStats()
  const warnings: string[] = []
  const seenWarnings = new Set<string>()
  const warn = (message: string): void => {
    if (seenWarnings.has(message) || warnings.length >= MAX_WARNINGS) return
    seenWarnings.add(message)
    warnings.push(message)
  }

  const maxSnapshots = Math.max(1, Math.trunc(opts.maxSnapshots ?? settings.maxSnapshots ?? 180))
  const revisions = pickSnapshotRevisions(history, maxSnapshots)

  let computed = 0
  let skipped = 0

  for (let i = 0; i < revisions.length; i++) {
    if (signal?.aborted === true) throw new Cancelled()
    const revision = revisions[i]
    if (revision === undefined) continue

    onProgress?.(i, revisions.length, revision)

    if (opts.force !== true && db.hasSnapshot(repoId, revision.sha)) {
      skipped++
      continue
    }

    const ctx = await buildContext({
      repoId,
      repoPath,
      settings,
      db,
      history,
      rev: revision.sha,
      signal,
      cache,
      onWarning: warn
    })

    const facts = computeFacts(ctx)
    const run = runSignals(ctx)
    for (const message of run.warnings) warn(message)

    // Only the numbers are persisted. Drivers and findings are regenerated from
    // a live context when the user opens a revision; storing 180 x 14 x 50
    // driver rows would cost megabytes to hold data no chart reads.
    const signals: SnapshotSignals = {}
    for (const value of run.values) signals[value.id as SignalId] = value.value

    // Author time, matching every other timestamp VDE shows and the clock
    // `pickSnapshotRevisions` buckets on. Baselines resolve against this column,
    // so it must agree with the anchor `buildReport` uses.
    db.putSnapshot(repoId, revision.sha, revision.date, ctx.now, facts, signals)
    computed++
  }

  onProgress?.(revisions.length, revisions.length, revisions[revisions.length - 1] ?? { sha: '', date: '' })

  const resolved = cache.hits + cache.misses
  return {
    total: revisions.length,
    computed,
    skipped,
    cache,
    cacheHitRate: resolved === 0 ? 1 : cache.hits / resolved,
    elapsedMs: Date.now() - startedAt,
    warnings
  }
}
