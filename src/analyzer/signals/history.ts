/**
 * History-shaped signals.
 *
 * Seven of VDE's fourteen measurements read the repository's *history* rather
 * than its current contents: what was added and never taken back, how wide each
 * commit reached, how much of the live code arrived in an unreviewable dump,
 * what was written and thrown away, what was rewritten without converging,
 * whether the work is slowing down, and whether the commit log still says
 * anything useful.
 *
 * Every computer here is a pure function of {@link AnalysisContext}. Nothing in
 * this module shells out, touches the filesystem, or mutates the context — the
 * history has already been parsed exactly once by the time we run.
 *
 * Three conventions hold throughout:
 *
 *   1. `value` is always higher-is-worse and, for the percent-unit signals,
 *      always on 0–100. The thresholds in `shared/signals.ts` were calibrated
 *      against these exact definitions, so the definitions are load-bearing:
 *      changing one silently re-bands every repository VDE has ever scored.
 *   2. Drivers are ranked worst-first and capped at {@link MAX_DRIVERS}. Each
 *      carries a pre-computed human label, because the renderer must never need
 *      to know how a signal was derived in order to draw it.
 *   3. Merge commits are skipped everywhere. Their diffs restate work already
 *      counted on the branch side, and counting both would roughly double every
 *      volume-based signal on a repository that merges rather than rebases.
 */

import { SIGNALS } from '../../shared/signals'
import type { SignalDriver } from '../../shared/types'
import type {
  AnalysisContext,
  CommitRecord,
  FileStats,
  RawFinding,
  SignalComputer,
  SignalResult
} from '../model'

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** Contractual cap on driver rows (see SignalValue.drivers). */
const MAX_DRIVERS = 50

/** Longest commit subject we will paste into a driver label before eliding. */
const LABEL_SUBJECT_CHARS = 72

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return n < lo ? lo : n > hi ? hi : n
}

/** Integer with thousands separators. Locale is pinned so both processes agree. */
function num(x: number): string {
  return Math.round(x).toLocaleString('en-US')
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/** Immediate parent directory of a repo-relative path; '' for root-level files. */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function dirLabel(dir: string): string {
  return dir === '' ? '(repo root)' : `${dir}/`
}

function commitLabel(c: CommitRecord): string {
  const subject = c.subject.trim()
  return `${shortSha(c.sha)} ${truncate(subject === '' ? '(no subject)' : subject, LABEL_SUBJECT_CHARS)}`
}

/**
 * Nearest-rank percentile: the smallest observation at or below which at least
 * `p`% of the sample sits. Chosen over linear interpolation because every value
 * we take a percentile of here is a discrete count of files — "the p95 commit
 * touched 41.6 files" is not a sentence anyone should have to read.
 */
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const rank = Math.ceil((p / 100) * sortedAsc.length)
  const idx = clamp(rank - 1, 0, sortedAsc.length - 1)
  return sortedAsc[idx] ?? 0
}

function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  if (ms < 90 * 60_000) return `${Math.max(1, Math.round(ms / 60_000))} min`
  if (ms < 2 * DAY_MS) return `${(ms / HOUR_MS).toFixed(1)}h`
  return `${(ms / DAY_MS).toFixed(1)} days`
}

/** UTC calendar day key. Day bucketing is UTC everywhere so it is reproducible. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function dayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS
}

function take(drivers: SignalDriver[]): SignalDriver[] {
  return drivers.length > MAX_DRIVERS ? drivers.slice(0, MAX_DRIVERS) : drivers
}

/** True when a signal's value has crossed out of its "good" band. */
function beyondWarning(id: keyof typeof SIGNALS, value: number): boolean {
  return value > SIGNALS[id].thresholds.warning
}

// ---------------------------------------------------------------------------
// Rename folding
// ---------------------------------------------------------------------------

/**
 * Renames are the single largest source of error in history-shaped signals. A
 * file renamed from `QueueRail.tsx` to `ReviewList.tsx` appears in `fileStats`
 * under *both* paths: the old one dead, the new one alive. Counted naively that
 * is one abandoned file plus one new file, when in truth it is one file that
 * moved. On the reference specimen there are 1,252 rename records — folding
 * them or not moves File Thrash by several points.
 */
interface RenameFolding {
  /** Any historical path → the path it ultimately became. Identity when unmoved. */
  canonical: Map<string, string>
  /**
   * Paths that were renamed away and so are not files in their own right. These
   * are excluded from "files ever created" and from every per-file signal.
   */
  renamedAway: Set<string>
}

/**
 * Folding depends only on `ctx.fileStats`, which is immutable for the life of a
 * context, so it is memoised per context. Three signals need it and two of them
 * would otherwise rebuild it over tens of thousands of paths.
 */
const foldingCache = new WeakMap<AnalysisContext, RenameFolding>()

function renameFolding(ctx: AnalysisContext): RenameFolding {
  const cached = foldingCache.get(ctx)
  if (cached) return cached

  // Edge list: former path → the path it became. FileStats.formerPaths is
  // ordered most-recent-first and may already be the full chain, but we do not
  // rely on that; the resolver below walks whatever graph we are given.
  const successor = new Map<string, string>()
  for (const [path, stats] of ctx.fileStats) {
    for (const former of stats.formerPaths) {
      if (former === path || former === '') continue
      // A path can be vacated by a rename and then *recreated* as a new file
      // (agents do this constantly: move a module out, write a fresh one back
      // in under the old name). If the old path is alive in the analysed tree
      // it is a real, present file and must not be folded into anything.
      if (ctx.fileStats.get(former)?.alive === true) continue
      if (!successor.has(former)) successor.set(former, path)
    }
  }

  const canonical = new Map<string, string>()
  const renamedAway = new Set<string>()

  const resolve = (start: string): string => {
    const memo = canonical.get(start)
    if (memo !== undefined) return memo
    let cur = start
    // Depth cap rather than a visited-set: chains are short in practice, and a
    // cycle (A→B→A, which git can produce from a swap) must terminate, not throw.
    for (let hops = 0; hops < 32; hops++) {
      const next = successor.get(cur)
      if (next === undefined || next === cur || next === start) break
      cur = next
    }
    canonical.set(start, cur)
    return cur
  }

  for (const former of successor.keys()) {
    if (resolve(former) !== former) renamedAway.add(former)
  }
  for (const path of ctx.fileStats.keys()) resolve(path)

  const folding: RenameFolding = { canonical, renamedAway }
  foldingCache.set(ctx, folding)
  return folding
}

function canonicalPath(folding: RenameFolding, path: string): string {
  return folding.canonical.get(path) ?? path
}

// ---------------------------------------------------------------------------
// 1. Accretion — added lines that were never taken back
// ---------------------------------------------------------------------------

/**
 * Directories below this many added lines are not eligible to be drivers. A
 * folder that received 40 lines and lost none scores 100% accretion, which is
 * true and completely uninteresting; without a floor those rows would crowd out
 * the directories where a million lines actually piled up.
 */
const ACCRETION_MIN_DIR_LINES = 200

interface DirChurn {
  added: number
  deleted: number
  files: Set<string>
}

export const accretionSignal: SignalComputer = {
  id: 'accretion',
  compute(ctx: AnalysisContext): SignalResult {
    let added = 0
    let deleted = 0
    const dirs = new Map<string, DirChurn>()

    for (const c of ctx.window) {
      if (c.isMerge) continue
      for (const f of c.files) {
        if (f.binary) continue
        added += f.insertions
        deleted += f.deletions
        const dir = dirOf(f.path)
        let bucket = dirs.get(dir)
        if (bucket === undefined) {
          bucket = { added: 0, deleted: 0, files: new Set<string>() }
          dirs.set(dir, bucket)
        }
        bucket.added += f.insertions
        bucket.deleted += f.deletions
        bucket.files.add(f.path)
      }
    }

    const value = added === 0 ? 0 : clamp(100 * (1 - deleted / added), 0, 100)

    // Rank directories by their own accretion rate, weighted by volume. The
    // log10 term is deliberate: it lets a directory two orders of magnitude
    // larger outrank a slightly more accretive small one, without letting sheer
    // size bury a genuinely 100%-accretive mid-size folder the way a linear
    // weight would.
    const ranked = [...dirs.entries()]
      .filter(([, d]) => d.added >= ACCRETION_MIN_DIR_LINES)
      .map(([dir, d]) => {
        const frac = d.added === 0 ? 0 : clamp(1 - d.deleted / d.added, 0, 1)
        return { dir, d, frac, score: frac * Math.log10(d.added) }
      })
      .sort((a, b) => b.score - a.score || b.d.added - a.d.added)

    const drivers: SignalDriver[] = take(
      ranked.map((r) => ({
        kind: 'directory' as const,
        path: r.dir,
        label: dirLabel(r.dir),
        value: r.frac * 100,
        detail: `+${num(r.d.added)} / -${num(r.d.deleted)} lines across ${num(r.d.files.size)} files`
      }))
    )

    let headline: string
    if (added === 0) {
      headline = `No lines were added in the last ${ctx.windowDays} days.`
    } else if (deleted === 0) {
      headline = `${num(added)} lines added and not one removed — the codebase only grows.`
    } else {
      const ratio = Math.max(1, Math.round(added / deleted))
      headline =
        `1 line removed for every ${num(ratio)} added ` +
        `(${num(added)} added, ${num(deleted)} removed) — ${value.toFixed(1)}% of everything written is still there.`
    }

    const findings: RawFinding[] = []
    if (value > SIGNALS.accretion.thresholds.serious && ranked.length > 0) {
      const worst = ranked.slice(0, 5)
      findings.push({
        title: `The repository only grows: ${value.toFixed(1)}% of added lines were never removed`,
        detail:
          `Over the last ${ctx.windowDays} days ${num(added)} lines were added and ${num(deleted)} removed, ` +
          `a ratio of ${num(Math.max(1, Math.round(added / Math.max(1, deleted))))}:1. ` +
          `The heaviest accretion is in ${worst
            .slice(0, 3)
            .map((r) => dirLabel(r.dir))
            .join(', ')}. ` +
          `Code that is only ever layered on top of is code nobody has gone back and read.`,
        paths: worst.map((r) => r.dir),
        metric: { label: 'added lines never removed', value, unit: 'percent' },
        remediation:
          `Before adding a new module under ${dirLabel(worst[0]?.dir ?? '')}, find and delete the code it supersedes ` +
          `in the same commit. For each of the listed directories, identify every symbol with no inbound reference ` +
          `and remove it; do not add a replacement without deleting what it replaces. Report the net line count of ` +
          `each change so growth is visible in review.`
      })
    }

    return { value, headline, drivers, findings }
  }
}

// ---------------------------------------------------------------------------
// 2. Blast Radius — how wide a single commit reaches
// ---------------------------------------------------------------------------

/** A commit this many times the median size is called out individually. */
const BLAST_OUTLIER_MULTIPLE = 10

/** Most per-commit findings we will raise; the worst ones by file count. */
const BLAST_MAX_FINDINGS = 5

/** Cap on file paths carried inside one finding, so the brief stays readable. */
const FINDING_PATH_CAP = 25

export const blastRadiusSignal: SignalComputer = {
  id: 'blastRadius',
  compute(ctx: AnalysisContext): SignalResult {
    const commits: CommitRecord[] = []
    for (const c of ctx.window) {
      if (c.isMerge) continue
      commits.push(c)
    }

    if (commits.length === 0) {
      return {
        value: 0,
        headline: `No non-merge commits in the last ${ctx.windowDays} days.`,
        drivers: [],
        findings: []
      }
    }

    const sizes = commits.map((c) => c.files.length).sort((a, b) => a - b)
    const p50 = percentile(sizes, 50)
    const p95 = percentile(sizes, 95)
    const largest = sizes[sizes.length - 1] ?? 0

    const bySize = [...commits].sort((a, b) => b.files.length - a.files.length || b.authoredAt - a.authoredAt)

    const drivers: SignalDriver[] = take(
      bySize.map((c) => {
        let ins = 0
        let del = 0
        for (const f of c.files) {
          ins += f.insertions
          del += f.deletions
        }
        return {
          kind: 'commit' as const,
          sha: c.sha,
          label: commitLabel(c),
          value: c.files.length,
          detail: `${dayKey(c.authoredAt)} · +${num(ins)} / -${num(del)} lines · ${c.authorName}`
        }
      })
    )

    // Outliers are measured against this repo's own median, not an absolute
    // number: a repo whose commits normally touch two files is telling us
    // something different by touching twenty than one that normally touches ten.
    const cutoff = p50 * BLAST_OUTLIER_MULTIPLE
    const outliers = p50 > 0 ? bySize.filter((c) => c.files.length > cutoff) : []

    const findings: RawFinding[] = outliers.slice(0, BLAST_MAX_FINDINGS).map((c) => {
      let ins = 0
      let del = 0
      for (const f of c.files) {
        ins += f.insertions
        del += f.deletions
      }
      const multiple = (c.files.length / Math.max(1, p50)).toFixed(0)
      const others =
        outliers.length > 1
          ? ` It is one of ${num(outliers.length)} commits in the window above ${BLAST_OUTLIER_MULTIPLE}x the median.`
          : ''
      return {
        title: `Commit ${shortSha(c.sha)} touched ${num(c.files.length)} files`,
        detail:
          `"${truncate(c.subject.trim(), 100)}" changed ${num(c.files.length)} files ` +
          `(+${num(ins)} / -${num(del)} lines) in a single commit — ${multiple}x this repository's median of ` +
          `${num(p50)} files.${others} A change of that width cannot have been reviewed as one unit, ` +
          `so whatever it broke was not caught here.`,
        paths: c.files.slice(0, FINDING_PATH_CAP).map((f) => f.path),
        metric: { label: 'files touched', value: c.files.length, unit: 'files' },
        remediation:
          `Audit ${shortSha(c.sha)} after the fact: run \`git show --stat ${c.sha}\` and separate the behavioural ` +
          `changes from the mechanical ones. Going forward, commit mechanical changes (renames, formatting, ` +
          `regenerated output) on their own so a reviewer sees the real diff unmixed, and keep behavioural commits ` +
          `under ${num(Math.max(5, p50 * 3))} files.`
      }
    })

    const headline =
      `Half of commits touch ${num(p50)} file${p50 === 1 ? '' : 's'} or fewer, ` +
      `but 1 in 20 touches ${num(p95)} or more (largest: ${num(largest)}).`

    return { value: p95, headline, drivers, findings }
  }
}

// ---------------------------------------------------------------------------
// 3. Unreviewed Bulk — how much of the LIVE code arrived in an unreadable dump
// ---------------------------------------------------------------------------

/**
 * The question this signal answers is not "how much was dumped" (that is Blast
 * Radius) but "how much of what is still running arrived that way".
 *
 * THE APPROXIMATION, stated plainly, because the number is only trustworthy if
 * the method is:
 *
 *   Exact line survivorship requires blaming every live line back to the commit
 *   that introduced it. On the reference specimen that is 1.16 million lines
 *   across 4,227 files — tens of minutes of `git blame`, per scan, for one tile.
 *   Unaffordable.
 *
 *   Instead, each live source file is attributed *proportionally*. If a file has
 *   1,000 lines today and 3,000 lines were added to it over its life, 900 of
 *   them inside mega-commits, then 30% of its surviving lines are counted as
 *   unreviewed. Summed over every live source file and divided by total live
 *   source lines, that is the reported value.
 *
 *   The assumption is that lines added by a mega-commit are neither more nor
 *   less likely to have survived than lines added by a small one. Where that
 *   fails it fails conservatively in the common shape: agent mega-commits
 *   typically create whole files that then sit untouched, so their lines survive
 *   at an *above*-average rate and the true figure is, if anything, higher than
 *   what we report.
 *
 * Computed over the *whole* history rather than `ctx.window`: a mega-commit from
 * before the window still put lines in the tree, and those lines are still there.
 */
export const unreviewedBulkSignal: SignalComputer = {
  id: 'unreviewedBulk',
  compute(ctx: AnalysisContext): SignalResult {
    const folding = renameFolding(ctx)

    // Live source lines, keyed by present-day path. Tree paths are already
    // canonical — the tree is what exists now.
    const liveLines = new Map<string, number>()
    let totalLive = 0
    for (const entry of ctx.tree) {
      if (ctx.kinds.get(entry.path) !== 'source') continue
      const blob = ctx.blobs.get(entry.sha)
      if (blob === undefined || blob.binary) continue
      liveLines.set(entry.path, blob.lines)
      totalLive += blob.lines
    }

    if (totalLive === 0) {
      return {
        value: 0,
        headline: 'No live source lines to attribute.',
        drivers: [],
        findings: []
      }
    }

    const isMega = (c: CommitRecord): boolean => !c.isMerge && c.files.length > ctx.megaThreshold

    // Pass A — per-file added-line totals, and the mega-commit share of them.
    const addedTotal = new Map<string, number>()
    const addedMega = new Map<string, number>()
    let megaCommits = 0
    for (const c of ctx.history.commits) {
      if (c.isMerge) continue
      const mega = isMega(c)
      if (mega) megaCommits++
      for (const f of c.files) {
        if (f.binary || f.insertions <= 0) continue
        const path = canonicalPath(folding, f.path)
        if (!liveLines.has(path)) continue
        addedTotal.set(path, (addedTotal.get(path) ?? 0) + f.insertions)
        if (mega) addedMega.set(path, (addedMega.get(path) ?? 0) + f.insertions)
      }
    }

    let unreviewed = 0
    const perFile: Array<{ path: string; lines: number; share: number }> = []
    for (const [path, lines] of liveLines) {
      const total = addedTotal.get(path) ?? 0
      if (total <= 0) continue
      const share = clamp((addedMega.get(path) ?? 0) / total, 0, 1)
      if (share <= 0) continue
      unreviewed += lines * share
      perFile.push({ path, lines, share })
    }

    const value = clamp((100 * unreviewed) / totalLive, 0, 100)

    // Pass B — attribute the surviving lines back to individual mega-commits,
    // using the same proportional rule so the drivers sum to the headline.
    const contribution = new Map<string, { commit: CommitRecord; lines: number }>()
    for (const c of ctx.history.commits) {
      if (!isMega(c)) continue
      let sum = 0
      for (const f of c.files) {
        if (f.binary || f.insertions <= 0) continue
        const path = canonicalPath(folding, f.path)
        const lines = liveLines.get(path)
        if (lines === undefined) continue
        const total = addedTotal.get(path) ?? 0
        if (total <= 0) continue
        sum += lines * (f.insertions / total)
      }
      if (sum > 0) contribution.set(c.sha, { commit: c, lines: sum })
    }

    const ranked = [...contribution.values()].sort((a, b) => b.lines - a.lines)

    const drivers: SignalDriver[] = take(
      ranked.map((r) => ({
        kind: 'commit' as const,
        sha: r.commit.sha,
        label: commitLabel(r.commit),
        value: Math.round(r.lines),
        detail:
          `${num(r.commit.files.length)} files in one commit · ` +
          `${((100 * r.lines) / totalLive).toFixed(1)}% of live source still traces to it`
      }))
    )

    const headline =
      megaCommits === 0
        ? `No commit touched more than ${num(ctx.megaThreshold)} files — nothing entered this codebase in bulk.`
        : `${value.toFixed(1)}% of the ${num(totalLive)} live source lines arrived inside ` +
          `${num(megaCommits)} commit${megaCommits === 1 ? '' : 's'} of more than ${num(ctx.megaThreshold)} files.`

    const findings: RawFinding[] = []
    if (beyondWarning('unreviewedBulk', value) && ranked.length > 0) {
      const worstFiles = [...perFile].sort((a, b) => b.lines * b.share - a.lines * a.share).slice(0, 10)
      const top = ranked.slice(0, 3)
      findings.push({
        title: `${value.toFixed(1)}% of live source arrived in commits too large to review`,
        detail:
          `${num(unreviewed)} of ${num(totalLive)} surviving source lines trace back to one of ${num(megaCommits)} ` +
          `mega-commits (more than ${num(ctx.megaThreshold)} files each). The largest contributors are ` +
          `${top.map((r) => shortSha(r.commit.sha)).join(', ')}. ` +
          `This is the share of the running codebase that no human read before it landed.`,
        paths: worstFiles.map((f) => f.path),
        metric: { label: 'live source from mega-commits', value, unit: 'percent' },
        remediation:
          `Treat the listed files as unreviewed code, not as legacy. Read each one and either write tests that pin ` +
          `its current behaviour or delete it if nothing calls it. Start with the files attributed to ` +
          `${shortSha(top[0]?.commit.sha ?? '')}. Do not refactor them until they are covered — there is no ` +
          `evidence anyone knows what they currently do.`
      })
    }

    return { value, headline, drivers, findings }
  }
}

// ---------------------------------------------------------------------------
// 4. File Thrash — work that was written and thrown away
// ---------------------------------------------------------------------------

export const fileThrashSignal: SignalComputer = {
  id: 'fileThrash',
  compute(ctx: AnalysisContext): SignalResult {
    const folding = renameFolding(ctx)

    let everCreated = 0
    let gone = 0
    const dead: FileStats[] = []

    for (const [path, stats] of ctx.fileStats) {
      // A renamed-away path is not a file that was thrown away; it is the same
      // file under an older name. Folding it into its successor is what stops
      // an aggressive refactor from reading as an abandonment spree.
      if (folding.renamedAway.has(path)) continue
      everCreated++
      if (!stats.alive) {
        gone++
        if (stats.added > 0) dead.push(stats)
      }
    }

    const value = everCreated === 0 ? 0 : clamp((100 * gone) / everCreated, 0, 100)

    // Shortest-lived first, as specified: the files that were written and
    // deleted fastest are the clearest evidence of guessing. Ties (files created
    // and deleted inside the same commit, of which there are usually many) break
    // towards the file that cost the most lines to write.
    const shortest = [...dead].sort((a, b) => {
      const la = Math.max(0, a.lastAt - a.firstAt)
      const lb = Math.max(0, b.lastAt - b.firstAt)
      return la - lb || b.added - a.added
    })

    const drivers: SignalDriver[] = take(
      shortest.map((s) => {
        const lifetime = Math.max(0, s.lastAt - s.firstAt)
        return {
          kind: 'file' as const,
          path: s.path,
          label: `${s.path} (lived ${humanDuration(lifetime)})`,
          value: lifetime / HOUR_MS,
          detail: `+${num(s.added)} / -${num(s.deleted)} lines across ${num(s.commits)} commits, deleted ${dayKey(s.lastAt)}`
        }
      })
    )

    const folded = folding.renamedAway.size
    const headline =
      everCreated === 0
        ? 'No files have been created in this repository.'
        : `${num(gone)} of ${num(everCreated)} files ever created no longer exist (${value.toFixed(1)}%)` +
          (folded > 0 ? `, after folding ${num(folded)} renamed paths into their successors.` : '.')

    const findings: RawFinding[] = []
    if (beyondWarning('fileThrash', value) && shortest.length > 0) {
      const wastedLines = dead.reduce((acc, s) => acc + s.added, 0)
      // Which directory absorbed the most abandoned work? That is where the
      // agent was guessing hardest, and it is the actionable unit.
      const byDir = new Map<string, number>()
      for (const s of dead) byDir.set(dirOf(s.path), (byDir.get(dirOf(s.path)) ?? 0) + s.added)
      const worstDir = [...byDir.entries()].sort((a, b) => b[1] - a[1])[0]
      findings.push({
        title: `${num(gone)} of ${num(everCreated)} files ever created have been deleted`,
        detail:
          `${value.toFixed(1)}% of everything ever written here was later thrown away, ${num(wastedLines)} lines ` +
          `of it, and renames are already excluded from that count. ` +
          (worstDir
            ? `The most churned area is ${dirLabel(worstDir[0])}, which absorbed ${num(worstDir[1])} deleted lines. `
            : '') +
          `The shortest-lived files survived ${humanDuration(Math.max(0, (shortest[0]?.lastAt ?? 0) - (shortest[0]?.firstAt ?? 0)))}.`,
        paths: shortest.slice(0, 10).map((s) => s.path),
        metric: { label: 'files created then deleted', value, unit: 'percent' },
        remediation:
          `Stop writing speculative files. Before creating a new file under ${dirLabel(worstDir?.[0] ?? '')}, ` +
          `state in the commit message which existing file could not be extended and why. Where a directory has ` +
          `seen repeated create-then-delete cycles, settle its interface first — write the type signatures and the ` +
          `tests, then the implementation.`
      })
    }

    return { value, headline, drivers, findings }
  }
}

// ---------------------------------------------------------------------------
// 5. Rework Churn — rewritten in place, without converging
// ---------------------------------------------------------------------------

/** A file has to have received this many lines before its rewrite rate means anything. */
const REWORK_SUBSTANTIAL_LINES = 200

/** deleted/added at or above this is a rewrite rather than an edit. */
const REWORK_RATIO = 0.5

export const reworkSignal: SignalComputer = {
  id: 'rework',
  compute(ctx: AnalysisContext): SignalResult {
    const folding = renameFolding(ctx)

    let substantial = 0
    let rewritten = 0
    const rows: Array<{ stats: FileStats; ratio: number }> = []

    for (const [path, stats] of ctx.fileStats) {
      if (folding.renamedAway.has(path)) continue
      // Deleted files are excluded on purpose. A file's final deletion charges
      // its whole length to `deleted`, so every deleted file scores a ratio near
      // 1.0 by construction — that is File Thrash, measured over there, and
      // counting it here would report the same pathology twice.
      if (!stats.alive) continue
      if (ctx.kinds.get(path) !== 'source') continue
      if (stats.added < REWORK_SUBSTANTIAL_LINES) continue

      substantial++
      const ratio = stats.deleted / stats.added
      if (ratio >= REWORK_RATIO) {
        rewritten++
        rows.push({ stats, ratio })
      }
    }

    const value = substantial === 0 ? 0 : clamp((100 * rewritten) / substantial, 0, 100)

    rows.sort((a, b) => b.ratio - a.ratio || b.stats.added - a.stats.added)

    const drivers: SignalDriver[] = take(
      rows.map(({ stats, ratio }) => ({
        kind: 'file' as const,
        path: stats.path,
        label: `${stats.path} +${num(stats.added)} / -${num(stats.deleted)}`,
        value: clamp(ratio * 100, 0, 1000),
        detail: `${num(stats.commits)} commits · last touched ${dayKey(stats.lastAt)}`
      }))
    )

    const headline =
      substantial === 0
        ? `No source file has received ${REWORK_SUBSTANTIAL_LINES} lines yet — nothing substantial enough to score.`
        : `${num(rewritten)} of ${num(substantial)} substantial source files have been rewritten in place ` +
          `(${value.toFixed(1)}%) — half or more of every line added to them was later deleted.`

    const findings: RawFinding[] = []
    if (beyondWarning('rework', value) && rows.length > 0) {
      const worst = rows.slice(0, 10)
      const first = worst[0]
      findings.push({
        title: `${num(rewritten)} substantial source files have been rewritten in place`,
        detail:
          `${value.toFixed(1)}% of the ${num(substantial)} source files with more than ` +
          `${REWORK_SUBSTANTIAL_LINES} added lines have had at least half of those lines deleted again. ` +
          (first
            ? `The worst is ${first.stats.path} at +${num(first.stats.added)} / -${num(first.stats.deleted)} over ` +
              `${num(first.stats.commits)} commits. `
            : '') +
          `Repeated in-place rewriting means the problem was never understood, only re-attempted.`,
        paths: worst.map((r) => r.stats.path),
        metric: { label: 'substantial files rewritten', value, unit: 'percent' },
        remediation:
          `Do not rewrite ${first?.stats.path ?? 'these files'} again. First write characterisation tests that ` +
          `capture the behaviour it is supposed to have, then change it in small, reviewable steps against those ` +
          `tests. If the requirements themselves are unclear, write them down before touching the file — another ` +
          `full rewrite will produce another full rewrite.`
      })
    }

    return { value, headline, drivers, findings }
  }
}

// ---------------------------------------------------------------------------
// 6. Velocity Decay — is the work slowing down?
// ---------------------------------------------------------------------------

const CADENCE_RECENT_DAYS = 7
const CADENCE_BASELINE_DAYS = 28
const CADENCE_SPAN_DAYS = CADENCE_RECENT_DAYS + CADENCE_BASELINE_DAYS

/** A run of this many consecutive commit-free days is reported as a gap. */
const CADENCE_GAP_DAYS = 2

interface DayBucket {
  commits: number
  lastSha: string | null
}

export const cadenceSignal: SignalComputer = {
  id: 'cadence',
  compute(ctx: AnalysisContext): SignalResult {
    const now = ctx.now
    const ageDays = Math.max(0, (now - ctx.history.firstAt) / DAY_MS)

    // A three-week-old repository has no trailing month to compare against, but
    // it can still be decaying — and for agent-built repos, which are often days
    // old, that is the interesting case. Scale both windows by the same factor
    // so the 1:4 recent-to-baseline shape is preserved, and say so in the
    // headline rather than quietly reporting a number of a different kind.
    const scaled = ageDays < CADENCE_SPAN_DAYS
    const factor = scaled ? Math.max(0, ageDays) / CADENCE_SPAN_DAYS : 1
    const recentDays = scaled ? Math.max(1, CADENCE_RECENT_DAYS * factor) : CADENCE_RECENT_DAYS
    const baselineDays = scaled ? Math.max(1, CADENCE_BASELINE_DAYS * factor) : CADENCE_BASELINE_DAYS

    const recentStart = now - recentDays * DAY_MS
    const baseStart = recentStart - baselineDays * DAY_MS

    let recentCount = 0
    let baseCount = 0
    const days = new Map<string, DayBucket>()

    for (const c of ctx.history.commits) {
      if (c.isMerge) continue
      const t = c.authoredAt
      if (t > now || t <= baseStart) continue
      if (t > recentStart) recentCount++
      else baseCount++
      const key = dayKey(t)
      const bucket = days.get(key)
      if (bucket === undefined) days.set(key, { commits: 1, lastSha: c.sha })
      else bucket.commits++
    }

    const recentRate = recentCount / recentDays
    const baseRate = baseCount / baselineDays

    let value: number
    if (recentCount === 0) {
      // Nothing at all in the recent window. Whatever the baseline was, the
      // work has stopped; this is the terminal reading for this signal.
      value = 100
    } else if (baseRate <= 0) {
      // No baseline to decay from — a repository that started this week is not
      // slowing down, it is starting.
      value = 0
    } else {
      value = clamp(100 * (1 - recentRate / baseRate), 0, 100)
    }

    // ---- drivers -------------------------------------------------------
    // Two kinds of row: days in the recent window that came in under the
    // trailing average, and any run of two or more days with nothing at all.
    // Both are expressed in the same unit — commits missed against the trailing
    // rate — so the list can be ranked as one.
    const drivers: SignalDriver[] = []
    const gapDays = new Set<string>()

    const firstDay = dayStart(Math.max(baseStart, ctx.history.firstAt))
    const lastDay = dayStart(now)
    let runStart: number | null = null
    let runLength = 0

    const flushRun = (endExclusive: number): void => {
      if (runStart !== null && runLength >= CADENCE_GAP_DAYS) {
        const from = dayKey(runStart)
        const to = dayKey(endExclusive - DAY_MS)
        for (let d = runStart; d < endExclusive; d += DAY_MS) gapDays.add(dayKey(d))
        drivers.push({
          kind: 'commit',
          label: `${runLength} days with no commits (${from} to ${to})`,
          value: baseRate * runLength,
          detail: `${(baseRate * runLength).toFixed(1)} commits missed against the trailing ${baseRate.toFixed(1)}/day`
        })
      }
      runStart = null
      runLength = 0
    }

    for (let d = firstDay; d <= lastDay; d += DAY_MS) {
      const count = days.get(dayKey(d))?.commits ?? 0
      if (count === 0) {
        if (runStart === null) runStart = d
        runLength++
      } else {
        flushRun(d)
      }
    }
    flushRun(lastDay + DAY_MS)

    const recentFirstDay = dayStart(recentStart)
    for (let d = recentFirstDay; d <= lastDay; d += DAY_MS) {
      const key = dayKey(d)
      if (gapDays.has(key)) continue // already reported as part of a gap
      const bucket = days.get(key)
      const count = bucket?.commits ?? 0
      const drop = baseRate - count
      if (drop <= 0) continue
      const driver: SignalDriver = {
        kind: 'commit',
        label: `${key} — ${count} commit${count === 1 ? '' : 's'} against a trailing ${baseRate.toFixed(1)}/day`,
        value: drop,
        detail: `${drop.toFixed(1)} commits below the preceding ${baselineDays.toFixed(0)}-day average`
      }
      const sha = bucket?.lastSha
      if (sha) driver.sha = sha
      drivers.push(driver)
    }

    drivers.sort((a, b) => b.value - a.value)

    // ---- headline ------------------------------------------------------
    const scaleNote = scaled
      ? ` (windows scaled to this ${ageDays.toFixed(0)}-day-old repository: the last ${recentDays.toFixed(1)} days ` +
        `against the preceding ${baselineDays.toFixed(1)})`
      : ''

    let headline: string
    if (recentCount === 0) {
      headline =
        `No commits in the last ${recentDays.toFixed(1)} days, against ${baseRate.toFixed(1)}/day over the ` +
        `preceding ${baselineDays.toFixed(0)} — the work has stopped${scaleNote}.`
    } else if (baseRate <= 0) {
      headline = `${recentRate.toFixed(1)} commits/day and no earlier history to compare against${scaleNote}.`
    } else if (value <= 0) {
      headline =
        `Commit rate is up, from ${baseRate.toFixed(1)}/day to ${recentRate.toFixed(1)}/day — ` +
        `no decay${scaleNote}.`
    } else {
      headline =
        `Commit rate fell from ${baseRate.toFixed(1)}/day to ${recentRate.toFixed(1)}/day — ` +
        `a ${value.toFixed(0)}% drop${scaleNote}.`
    }

    const findings: RawFinding[] = []
    if (beyondWarning('cadence', value)) {
      findings.push({
        title:
          recentCount === 0
            ? 'The repository has stopped receiving commits'
            : `Commit rate has fallen ${value.toFixed(0)}%`,
        detail:
          `The last ${recentDays.toFixed(1)} days produced ${num(recentCount)} commits ` +
          `(${recentRate.toFixed(1)}/day) against ${num(baseCount)} over the preceding ` +
          `${baselineDays.toFixed(0)} days (${baseRate.toFixed(1)}/day). ` +
          (gapDays.size > 0 ? `${num(gapDays.size)} days in the window saw no commits at all. ` : '') +
          `Projects like this stall rather than fail; a falling rate is usually the first measurable sign that ` +
          `the codebase has become harder to change than it is worth.`,
        paths: [],
        metric: { label: 'drop in commit rate', value, unit: 'percent' },
        remediation:
          `Find out what the last few sessions got stuck on: read the most recent commits and any half-finished ` +
          `work in the tree. If the blocker is a file that resists change, address that file specifically — split ` +
          `it, test it, or delete it. Do not start new features until the existing ones can be modified at the ` +
          `rate they used to be.`
      })
    }

    return { value, headline, drivers: take(drivers), findings }
  }
}

// ---------------------------------------------------------------------------
// 7. Commit Hygiene — can anyone read this log?
// ---------------------------------------------------------------------------

const SUBJECT_MIN_CHARS = 15
const SUBJECT_MAX_CHARS = 100

/**
 * Conventional-commit grammar: `type(optional-scope)!: description`.
 *
 * The type set is deliberately CLOSED to the eleven types of
 * @commitlint/config-conventional. The written specification permits any noun as
 * a type, but accepting anything would defeat the point of this signal: on the
 * reference specimen, 78% of subjects match an open `word:` pattern while only
 * 46% use a real conventional type, and the gap is entirely commits that drifted
 * from `feat(kb): …` to `kb: …` — a scope promoted to a type. That drift is the
 * pathology, so the grammar has to be able to see it.
 */
const CONVENTIONAL_TYPES = 'build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test'
const CONVENTIONAL = new RegExp(`^(${CONVENTIONAL_TYPES})(?:\\(([^()\\r\\n]{1,64})\\))?(!)?: (.+)$`)

/** Subjects that begin with one of these say nothing about what changed. */
const LAZY_PREFIX =
  /^(wip|fix|fixes|update|updates|changes|stuff|misc|tweak|tweaks|cleanup|more|test|tmp|asdf|\.+)\b/i

/** Descriptions that restate the type instead of describing the change. */
const TRIVIAL_WORDS = new Set([
  'fix',
  'fixes',
  'fixed',
  'update',
  'updates',
  'updated',
  'change',
  'changes',
  'changed',
  'wip',
  'stuff',
  'misc',
  'things',
  'it',
  'this',
  'that',
  'cleanup',
  'clean up',
  'tweak',
  'tweaks',
  'more',
  'test',
  'tests',
  'tmp',
  'temp',
  'bug',
  'bugs',
  'typo',
  'typos',
  'lint',
  'format',
  'formatting',
  'refactor',
  'minor',
  'small',
  'various',
  'etc',
  'again',
  'final',
  'done',
  'asdf'
])

/**
 * The convention-drift threshold. Below this share, a repository has no
 * convention and non-conventional subjects are not penalised; at or above it,
 * the convention is established and departing from it is inconsistency.
 */
const CONVENTION_ESTABLISHED = 0.4

/**
 * Below this many commits in the window, the window is too small to establish
 * a convention on its own and the whole history is used to decide instead.
 */
const CONVENTION_MIN_SAMPLE = 20

type HygieneReason = 'too-short' | 'too-long' | 'lazy-prefix' | 'empty-body' | 'off-convention'

const REASON_TEXT: Record<HygieneReason, string> = {
  'too-short': 'shorter than 15 characters',
  'too-long': 'longer than 100 characters',
  'lazy-prefix': 'starts with a filler word',
  'empty-body': 'a conventional prefix with nothing after it',
  'off-convention': 'does not follow the convention the rest of the repo uses'
}

interface ConventionalParts {
  type: string
  description: string
}

function parseConventional(subject: string): ConventionalParts | null {
  const m = CONVENTIONAL.exec(subject)
  if (m === null) return null
  const type = m[1]
  const description = m[4]
  if (type === undefined || description === undefined) return null
  return { type, description }
}

function isTrivialDescription(type: string, description: string): boolean {
  const d = description.trim().toLowerCase().replace(/[.!\s]+$/, '')
  if (d.length === 0) return true
  if (d === type) return true
  if (TRIVIAL_WORDS.has(d)) return true
  // A single short token is a label, not a description ("feat: auth").
  return !d.includes(' ') && d.length < 6
}

/**
 * Why the lazy-prefix regex is applied to the *description* of a conventional
 * commit rather than to the raw subject:
 *
 *   `\b` matches between a word character and a colon, so a literal application
 *   of /^(wip|fix|...)\b/i to "fix: correct the retry backoff" matches — the
 *   rule would condemn every well-formed `fix:` and `test:` commit in a
 *   conventional repository, which is the opposite of what it is for. The rule
 *   exists to catch subjects that *lead with a filler word instead of saying
 *   something*, so it is applied to the part of the subject that is supposed to
 *   say something: the description after the prefix, when there is one, and the
 *   whole subject when there is not. "fix: wip" is still caught; "fix: correct
 *   the retry backoff" is not.
 */
function hygieneReason(subject: string, enforceConvention: boolean): HygieneReason | null {
  const s = subject.trim()
  if (s.length < SUBJECT_MIN_CHARS) return 'too-short'
  if (s.length > SUBJECT_MAX_CHARS) return 'too-long'

  const conv = parseConventional(s)
  const effective = conv === null ? s : conv.description
  if (LAZY_PREFIX.test(effective)) return 'lazy-prefix'
  if (conv !== null && isTrivialDescription(conv.type, conv.description)) return 'empty-body'
  // CONVENTION DRIFT: a non-conventional subject is only a defect once the
  // repository has demonstrably adopted the convention. A repo that has never
  // used conventional commits is consistent, and consistency is the thing being
  // measured; a repo that used them for 400 commits and then stopped is not.
  if (conv === null && enforceConvention) return 'off-convention'
  return null
}

export const commitHygieneSignal: SignalComputer = {
  id: 'commitHygiene',
  compute(ctx: AnalysisContext): SignalResult {
    const scored: CommitRecord[] = []
    for (const c of ctx.window) {
      if (c.isMerge) continue
      scored.push(c)
    }

    if (scored.length === 0) {
      return {
        value: 0,
        headline: `No non-merge commits in the last ${ctx.windowDays} days.`,
        drivers: [],
        findings: []
      }
    }

    // Establish the convention over the window, unless the window is too thin
    // to say anything — in which case fall back to the repository's whole log.
    const conventionSample =
      scored.length >= CONVENTION_MIN_SAMPLE ? scored : ctx.history.commits.filter((c) => !c.isMerge)
    let conventionalCount = 0
    for (const c of conventionSample) {
      if (parseConventional(c.subject.trim()) !== null) conventionalCount++
    }
    const conventionalShare = conventionSample.length === 0 ? 0 : conventionalCount / conventionSample.length
    const enforceConvention = conventionalShare >= CONVENTION_ESTABLISHED

    // ctx.window is newest-first, and the spec for this signal wants offenders
    // newest-first too: recent sloppiness is what you can still do something
    // about. No re-sort.
    const offenders: Array<{ commit: CommitRecord; reason: HygieneReason }> = []
    for (const c of scored) {
      const reason = hygieneReason(c.subject, enforceConvention)
      if (reason !== null) offenders.push({ commit: c, reason })
    }

    const value = clamp((100 * offenders.length) / scored.length, 0, 100)

    const drivers: SignalDriver[] = take(
      offenders.map(({ commit, reason }) => ({
        kind: 'commit' as const,
        sha: commit.sha,
        label: commitLabel(commit),
        value: commit.subject.trim().length,
        detail: `${dayKey(commit.authoredAt)} · ${REASON_TEXT[reason]}`
      }))
    )

    const conventionNote = enforceConvention
      ? `${(conventionalShare * 100).toFixed(0)}% of the log follows conventional commits, so the ones that do not are counted against it.`
      : `Only ${(conventionalShare * 100).toFixed(0)}% of the log is conventional, so no convention is enforced.`

    const headline =
      offenders.length === 0
        ? `All ${num(scored.length)} commit subjects are usable. ${conventionNote}`
        : `${num(offenders.length)} of ${num(scored.length)} commit subjects are unusable ` +
          `(${value.toFixed(1)}%). ${conventionNote}`

    const findings: RawFinding[] = []
    if (beyondWarning('commitHygiene', value) && offenders.length > 0) {
      const counts = new Map<HygieneReason, number>()
      for (const o of offenders) counts.set(o.reason, (counts.get(o.reason) ?? 0) + 1)
      const breakdown = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, n]) => `${num(n)} ${REASON_TEXT[reason]}`)
        .join(', ')
      findings.push({
        title: `${value.toFixed(1)}% of commit subjects are unusable`,
        detail:
          `${num(offenders.length)} of ${num(scored.length)} non-merge commits in the last ${ctx.windowDays} days ` +
          `have subjects that do not say what changed: ${breakdown}. ${conventionNote} ` +
          `History is the only documentation that cannot drift, and this one has stopped being readable.`,
        paths: [],
        metric: { label: 'unusable commit subjects', value, unit: 'percent' },
        remediation:
          (enforceConvention
            ? `Write every subject as \`type(scope): what changed\`, matching the convention already used by ` +
              `${(conventionalShare * 100).toFixed(0)}% of this log. `
            : `Adopt one subject format and hold to it — \`type(scope): what changed\` is the obvious choice. `) +
          `A subject must name the behaviour that changed, not the activity: "fix the retry backoff on upload ` +
          `timeouts", never "fix" or "update stuff". Keep it between 15 and 100 characters.`
      })
    }

    return { value, headline, drivers, findings }
  }
}

// ---------------------------------------------------------------------------

/** Every history-shaped signal, in panel order. */
export const historySignals: SignalComputer[] = [
  accretionSignal,
  blastRadiusSignal,
  unreviewedBulkSignal,
  fileThrashSignal,
  reworkSignal,
  cadenceSignal,
  commitHygieneSignal
]
