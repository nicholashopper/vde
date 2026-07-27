/**
 * Reading a revision's tree, and choosing which revisions are worth reading.
 *
 * `readTree` is the cheap half: one `ls-tree` per revision, NUL-delimited so
 * paths arrive as raw bytes rather than C-quoted text.
 *
 * `pickSnapshotRevisions` is the interesting half. VDE draws every signal as a
 * sparkline over the repository's life, which means recomputing the whole
 * analysis at N historical revisions. N is capped (see `Settings.maxSnapshots`)
 * because each snapshot costs a tree read plus blob analysis, so the revisions
 * have to be *chosen*, not sampled uniformly: a user debugging a regression
 * cares about last Tuesday, not about the difference between month four and
 * month five.
 */

import type { CommitRecord, History, TreeEntry } from '../model'
import { Cancelled } from '../model'
import { streamLines } from './exec'
import { unquotePath } from './log'

export interface ReadTreeOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/** A monorepo tree can be enormous; the gateway's 2-minute default is tight. */
const TREE_TIMEOUT_MS = 10 * 60_000

const DAY_MS = 86_400_000

/** Days back from the anchor that get one snapshot per day. */
const DAILY_WINDOW_DAYS = 90
/** Days back from the anchor that get one snapshot per week. */
const WEEKLY_WINDOW_DAYS = 180

// ---------------------------------------------------------------------------
// readTree
// ---------------------------------------------------------------------------

/**
 * Lists every blob in the tree at `rev`, recursively.
 *
 * Submodules (`commit` entries) and directories are skipped: neither has
 * content VDE can analyse, and a submodule's size is reported as '-'.
 *
 * `-z` is what makes this safe — without it git C-quotes any path containing a
 * byte outside printable ASCII, and the quoting would have to be undone for
 * every entry in a large tree. The unquoter is still applied defensively for
 * git builds that quote regardless.
 */
export async function readTree(repoPath: string, rev: string, opts: ReadTreeOptions = {}): Promise<TreeEntry[]> {
  if (opts.signal?.aborted) throw new Cancelled()

  const revision = rev.trim()
  if (revision.length === 0) {
    throw new Error('readTree requires a revision')
  }
  // A revision beginning with '-' would be parsed by git as an option. The
  // read-only gateway screens known-dangerous flags, but this closes the whole
  // class rather than the enumerated members of it.
  if (revision.startsWith('-')) {
    throw new Error(`readTree refuses the revision "${revision}": it would be read as a git option`)
  }

  const entries: TreeEntry[] = []

  try {
    await streamLines(
      repoPath,
      ['ls-tree', '-r', '-l', '-z', revision],
      (record) => {
        const entry = parseTreeRecord(record)
        if (entry) entries.push(entry)
      },
      { separator: '\0', signal: opts.signal, timeoutMs: opts.timeoutMs ?? TREE_TIMEOUT_MS }
    )
  } catch (e) {
    if (opts.signal?.aborted) throw new Cancelled()
    throw e
  }

  return entries
}

/**
 * One `ls-tree -l` record: `<mode> <type> <sha><padding><size>\t<path>`.
 *
 * `-l` right-aligns the size in a fixed-width column, so the metadata half must
 * be split on runs of whitespace rather than single spaces. The path is
 * everything after the first tab; git escapes tabs inside paths, so the first
 * tab is unambiguously the separator.
 */
function parseTreeRecord(record: string): TreeEntry | null {
  if (record.length === 0) return null

  const tab = record.indexOf('\t')
  if (tab <= 0) return null

  const meta = record.slice(0, tab).split(/\s+/)
  if (meta.length < 4) return null

  const mode = meta[0] ?? ''
  const type = meta[1] ?? ''
  const sha = meta[2] ?? ''
  const sizeRaw = meta[3] ?? ''

  // 'tree' entries only appear without -r; 'commit' entries are submodule
  // pointers, whose content lives in another repository entirely.
  if (type !== 'blob') return null
  if (sha.length === 0) return null

  const size = sizeRaw === '-' ? -1 : Number.parseInt(sizeRaw, 10)
  const path = unquotePath(record.slice(tab + 1))
  if (path.length === 0) return null

  return { path, sha, size: Number.isFinite(size) ? size : -1, mode }
}

// ---------------------------------------------------------------------------
// pickSnapshotRevisions
// ---------------------------------------------------------------------------

export interface SnapshotRevision {
  sha: string
  /** YYYY-MM-DD, UTC. */
  date: string
}

/**
 * Chooses the revisions to reconstruct the repository at.
 *
 * Cadence is adaptive and anchored on the newest commit rather than on wall
 * clock time — a repository abandoned a year ago still deserves daily detail
 * across its final ninety days of activity, and `AnalysisContext.now` is
 * likewise the anchor commit's timestamp.
 *
 *   0–90 days before the anchor    one snapshot per day
 *   90–180 days before the anchor  one snapshot per week
 *   beyond 180 days                one snapshot per calendar month
 *
 * Each bucket is represented by its *last* commit, so a snapshot shows the
 * state at the end of that period. Merge commits are skipped as representatives
 * when the bucket holds anything else: a merge's tree is a combination nobody
 * authored, and its numbers can jump discontinuously.
 *
 * The first commit and HEAD are always included — the former so growth charts
 * start at the true origin, the latter because the report is anchored there.
 * When the result still exceeds `maxSnapshots`, the oldest buckets are dropped
 * first; resolution near HEAD is what the user is actually looking at.
 *
 * Returned chronologically ascending.
 */
export function pickSnapshotRevisions(history: History, maxSnapshots: number): SnapshotRevision[] {
  const commits = history.commits
  if (commits.length === 0 || maxSnapshots <= 0) return []

  // `History.commits` is newest-first, so these are the two forced entries.
  const head = commits[0]
  const first = commits[commits.length - 1]
  if (!head || !first) return []

  if (maxSnapshots === 1) return [toRevision(head)]

  const anchorDay = Math.floor(history.lastAt / DAY_MS)

  /** bucket key → best representative found so far. */
  const buckets = new Map<string, { rep: CommitRecord | null; fallback: CommitRecord | null }>()

  for (const c of commits) {
    const key = bucketKey(c.authoredAt, anchorDay)
    let slot = buckets.get(key)
    if (!slot) {
      slot = { rep: null, fallback: null }
      buckets.set(key, slot)
    }
    // Iterating newest-first, so the first acceptable commit seen in a bucket
    // is that bucket's last commit.
    if (c.isMerge) {
      if (!slot.fallback) slot.fallback = c
    } else if (!slot.rep) {
      slot.rep = c
    }
  }

  // Key by date, not by sha: two buckets can never resolve to the same date
  // (the cadence bands partition the day axis), and a duplicated date would put
  // two points on the same x position of every chart.
  const byDate = new Map<string, { commit: CommitRecord; at: number }>()
  for (const slot of buckets.values()) {
    const rep = slot.rep ?? slot.fallback
    if (rep) byDate.set(utcDate(rep.authoredAt), { commit: rep, at: rep.authoredAt })
  }

  // HEAD *replaces* its bucket's representative: the report is computed against
  // HEAD, so the final point on every chart has to be the same tree the rest of
  // the UI is describing — even when HEAD is a merge.
  byDate.set(utcDate(head.authoredAt), { commit: head, at: head.authoredAt })

  // Genesis *owns* its date, replacing that day's bucket representative. Growth
  // charts have to start at the repository's true origin, and keeping both would
  // put two points on the same x position of every sparkline — one snapshot per
  // date is the invariant the whole chart layer assumes.
  byDate.set(utcDate(first.authoredAt), { commit: first, at: first.authoredAt })

  const ordered = [...byDate.values()]
  ordered.sort(
    (a, b) => a.at - b.at || (a.commit.sha < b.commit.sha ? -1 : a.commit.sha > b.commit.sha ? 1 : 0)
  )
  const picked = ordered.map((e: { commit: CommitRecord; at: number }) => toRevision(e.commit))

  if (picked.length <= maxSnapshots) return picked

  // Thin from the old end, keeping the genesis snapshot and the newest
  // (maxSnapshots - 1) entries. The last of those is always HEAD.
  const genesis = picked[0]
  const recent = picked.slice(picked.length - (maxSnapshots - 1))
  return genesis ? [genesis, ...recent] : recent
}

function toRevision(c: CommitRecord): SnapshotRevision {
  return { sha: c.sha, date: utcDate(c.authoredAt) }
}

/**
 * Days are indexed off the UTC epoch so bucket boundaries never depend on the
 * machine's timezone — two users analysing the same repository must get the
 * same snapshots.
 */
function bucketKey(at: number, anchorDay: number): string {
  const day = Math.floor(at / DAY_MS)
  const back = anchorDay - day
  if (back < DAILY_WINDOW_DAYS) return `D${day}`
  if (back < WEEKLY_WINDOW_DAYS) return `W${Math.floor((back - DAILY_WINDOW_DAYS) / 7)}`
  return `M${utcDate(at).slice(0, 7)}`
}

/** YYYY-MM-DD in UTC. */
export function utcDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}
