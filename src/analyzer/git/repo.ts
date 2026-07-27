/**
 * Repository discovery and validation.
 *
 * This is the front door: the only place VDE turns a path the user pointed at
 * into a {@link RepoRef} the rest of the engine trusts. Everything downstream
 * assumes the path is canonical, is the *root* of a work tree, and has at least
 * one commit — so all of that is established exactly once, here.
 *
 * Every git call goes through the read-only gateway in ./exec. That gateway
 * injects `safe.bareRepository=explicit`, which has a useful side effect for us:
 * a bare repository fails *every* subcommand with a recognisable message, so we
 * can detect and reject it without a dedicated probe.
 */

import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

import type { RepoRef } from '../../shared/types'
import { GitCommandError, run, streamLines } from './exec'

/** Machine-readable reason a path was rejected, for callers that branch on it. */
export type RepoProblem =
  | 'not-found'
  | 'not-a-directory'
  | 'not-a-repo'
  | 'git-dir'
  | 'bare'
  | 'empty'
  | 'ownership'
  | 'git-missing'
  | 'unknown'

/**
 * A path the user chose cannot be analysed. The message is written to be shown
 * verbatim in the UI — it says what is wrong and, where possible, what to do.
 */
export class RepoValidationError extends Error {
  constructor(
    message: string,
    readonly problem: RepoProblem,
    readonly path: string
  ) {
    super(message)
    this.name = 'RepoValidationError'
  }
}

export interface ValidateRepoOptions {
  signal?: AbortSignal
  /**
   * Non-fatal problems, e.g. a shallow clone. Surfaced by the orchestrator into
   * `RepoReport.warnings`; validation still succeeds.
   */
  onWarning?: (message: string) => void
  /**
   * Ceiling for the one full-history walk validation performs. Generous by
   * default: the walk is O(commits) and a very large repository is slow, not
   * broken.
   */
  timeoutMs?: number
}

/** A repository big enough to be slow is still a repository; do not give up early. */
const HISTORY_WALK_TIMEOUT_MS = 10 * 60_000

/** Cheap O(1) probes. If one of these hangs, something is badly wrong. */
const PROBE_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Git reports every failure as `fatal: …` on stderr with exit 128, so the only
 * way to distinguish "not a repo" from "you do not own this" is to read the
 * text. The patterns below are stable across git 2.20+ and are matched
 * case-insensitively against stderr *and* the composed message.
 */
function gitStderr(e: unknown): string {
  if (e instanceof GitCommandError) return `${e.stderr}\n${e.message}`.toLowerCase()
  if (e instanceof Error) return e.message.toLowerCase()
  return String(e).toLowerCase()
}

function isMissingGit(e: unknown): boolean {
  const t = gitStderr(e)
  return t.includes('enoent') && t.includes('git')
}

/**
 * Turns a raw git failure into a user-facing error. `path` is the path the user
 * actually chose, so the remediation we print is copy-pasteable.
 */
function classify(e: unknown, path: string): RepoValidationError {
  const t = gitStderr(e)

  if (t.includes('dubious ownership')) {
    return new RepoValidationError(
      `Git refused to read ${path} because the directory is owned by a different user. ` +
        `To let VDE analyse it, run:\n\n    git config --global --add safe.directory "${path}"\n\n` +
        `then add the repository again.`,
      'ownership',
      path
    )
  }

  // Raised by safe.bareRepository=explicit, which the read-only gateway sets.
  if (t.includes('cannot use bare repository')) {
    return new RepoValidationError(
      `${path} is a bare repository (it has no working tree). VDE analyses working ` +
        `trees — clone it normally and point VDE at the clone.`,
      'bare',
      path
    )
  }

  if (t.includes('not a git repository')) {
    return new RepoValidationError(
      `${path} is not a git repository, and neither is any directory above it.`,
      'not-a-repo',
      path
    )
  }

  if (isMissingGit(e)) {
    return new RepoValidationError(
      `VDE could not run git. Install git, or make sure it is on the PATH that VDE inherits.`,
      'git-missing',
      path
    )
  }

  const detail = e instanceof Error ? e.message : String(e)
  return new RepoValidationError(`Could not read ${path} as a git repository: ${detail}`, 'unknown', path)
}

// ---------------------------------------------------------------------------
// validateRepo
// ---------------------------------------------------------------------------

/**
 * Resolves, validates and describes a repository.
 *
 * Throws {@link RepoValidationError} when the path cannot be analysed at all.
 * Calls `onWarning` for conditions that degrade the analysis without preventing
 * it — currently only shallow clones, whose truncated history makes every
 * history-derived signal an underestimate.
 */
export async function validateRepo(path: string, opts: ValidateRepoOptions = {}): Promise<RepoRef> {
  const requested = isAbsolute(path) ? path : resolve(path)

  // 1. Canonicalise. A repo reached through a symlink must produce the same id
  //    as the same repo reached directly, or it would be added to VDE twice.
  let canonical: string
  try {
    canonical = await realpath(requested)
  } catch {
    throw new RepoValidationError(`${requested} does not exist, or VDE is not allowed to read it.`, 'not-found', requested)
  }

  const st = await stat(canonical).catch(() => null)
  if (!st) {
    throw new RepoValidationError(`${canonical} could not be read.`, 'not-found', canonical)
  }
  if (!st.isDirectory()) {
    throw new RepoValidationError(`${canonical} is a file. Select the repository's folder instead.`, 'not-a-directory', canonical)
  }

  const probe = { signal: opts.signal, timeoutMs: PROBE_TIMEOUT_MS }

  // 2. Confirm we are inside a work tree. This is also where "not a repo",
  //    "bare repo" and "dubious ownership" surface, all as git failures.
  let insideWorkTree: string
  try {
    insideWorkTree = (await run(canonical, ['rev-parse', '--is-inside-work-tree'], probe)).trim()
  } catch (e) {
    throw classify(e, canonical)
  }

  if (insideWorkTree !== 'true') {
    // The remaining way to get a clean `false` is being inside the .git
    // directory itself, which git considers a repository but not a work tree.
    throw new RepoValidationError(
      `${canonical} is git's internal directory, not a working tree. Select the repository folder itself.`,
      'git-dir',
      canonical
    )
  }

  // 3. Snap to the work-tree root, then canonicalise again: git resolves
  //    symlinks differently on some platforms, and the id must not depend on
  //    which subdirectory the user happened to pick.
  let root: string
  try {
    const top = (await run(canonical, ['rev-parse', '--show-toplevel'], probe)).trim()
    if (top.length === 0) throw new GitCommandError('rev-parse --show-toplevel returned nothing', null, '')
    root = await realpath(top).catch(() => resolve(top))
  } catch (e) {
    throw classify(e, canonical)
  }

  // 4. HEAD. On a repository with no commits HEAD points at an unborn branch
  //    and --verify fails; that is our zero-commit detector.
  let head: string
  try {
    head = (await run(root, ['rev-parse', '--verify', 'HEAD'], probe)).trim()
  } catch (e) {
    const t = gitStderr(e)
    if (t.includes('needed a single revision') || t.includes('unknown revision') || t.includes('ambiguous argument')) {
      throw new RepoValidationError(
        `${root} is a git repository but has no commits yet. VDE analyses history, so there is nothing to measure.`,
        'empty',
        root
      )
    }
    throw classify(e, root)
  }

  // 5. Branch. `symbolic-ref` fails on a detached HEAD, which is not an error.
  let branch: string | null = null
  try {
    const b = (await run(root, ['symbolic-ref', '--short', 'HEAD'], probe)).trim()
    branch = b.length > 0 ? b : null
  } catch {
    branch = null
  }

  // 6. Shallow clones are analysable but every history signal is truncated, so
  //    the user has to be told. Never fatal.
  if (await isShallow(root, probe)) {
    opts.onWarning?.(
      `${basename(root)} is a shallow clone, so VDE can only see part of its history. ` +
        `Signals derived from history will read better than the repository really is. ` +
        `Run "git fetch --unshallow" for a complete picture.`
    )
  }

  // 7. Commit count and the history's extent.
  const extent = await readExtent(root, {
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? HISTORY_WALK_TIMEOUT_MS
  })

  return {
    id: repoId(root),
    path: root,
    name: basename(root),
    head,
    branch,
    firstCommitAt: new Date(extent.firstAt).toISOString(),
    lastCommitAt: new Date(extent.lastAt).toISOString(),
    commitCount: extent.count,
    // The persistence layer owns these two for repositories it already knows;
    // the values here are the correct defaults for a repo being added now.
    addedAt: new Date().toISOString(),
    lastScanAt: null
  }
}

/** Stable, path-derived identity. Same repo → same id, forever. */
/**
 * Cheap liveness check for an already-registered repository.
 *
 * A repo can be added, scanned, and then moved or deleted on disk — VDE holds a
 * path, not a handle. Without this, the next scan or report spawns git with a
 * cwd that no longer exists and the user sees "spawn git ENOENT", which names
 * neither the repository nor the problem. One stat at the entry to each
 * long-running operation buys a message they can act on.
 *
 * This is deliberately NOT called per git invocation: a scan issues thousands,
 * and a repository that vanishes mid-scan is caught by the failure itself.
 */
export async function assertRepoPresent(path: string): Promise<void> {
  let info: Stats
  try {
    info = await stat(path)
  } catch {
    throw new RepoValidationError(
      `${path} no longer exists. It was moved or deleted after VDE indexed it — remove it from the sidebar, or re-add it from its new location.`,
      'not-found',
      path
    )
  }
  if (!info.isDirectory()) {
    throw new RepoValidationError(`${path} is no longer a directory.`, 'not-a-directory', path)
  }
}

export function repoId(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function isShallow(root: string, probe: { signal?: AbortSignal; timeoutMs: number }): Promise<boolean> {
  try {
    return (await run(root, ['rev-parse', '--is-shallow-repository'], probe)).trim() === 'true'
  } catch {
    // --is-shallow-repository predates git 2.15; fall back to the marker file.
    // A worktree or submodule keeps its .git elsewhere, so absence here is not
    // proof of a full clone — but it is the best cheap answer available.
    return stat(join(root, '.git', 'shallow')).then(
      () => true,
      () => false
    )
  }
}

interface HistoryExtent {
  count: number
  firstAt: number
  lastAt: number
}

/**
 * Counts commits reachable from HEAD and finds the oldest and newest author
 * timestamps, in a single walk.
 *
 * `rev-list --count` would give the count more cheaply, but the timestamps
 * require a full walk regardless, and one walk that yields all three numbers is
 * strictly less work than two walks that yield them separately. Streaming keeps
 * memory flat no matter how long the history is.
 *
 * Author time (rather than commit time) is used consistently across VDE — it is
 * the only timestamp the renderer contract exposes (`CommitSummary.authoredAt`),
 * so every date the user sees comes from the same clock.
 */
async function readExtent(root: string, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<HistoryExtent> {
  let count = 0
  let firstAt = Number.POSITIVE_INFINITY
  let lastAt = Number.NEGATIVE_INFINITY

  await streamLines(
    root,
    ['log', '--no-color', '--format=%at', 'HEAD', '--'],
    (line) => {
      if (line.length === 0) return
      const secs = Number.parseInt(line, 10)
      if (!Number.isFinite(secs)) return
      count++
      const ms = secs * 1000
      if (ms < firstAt) firstAt = ms
      if (ms > lastAt) lastAt = ms
    },
    opts
  ).catch((e: unknown) => {
    throw classify(e, root)
  })

  if (count === 0) {
    throw new RepoValidationError(
      `${root} is a git repository but has no commits yet. VDE analyses history, so there is nothing to measure.`,
      'empty',
      root
    )
  }

  return { count, firstAt, lastAt }
}
