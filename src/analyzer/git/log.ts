/**
 * History parsing.
 *
 * `git log` output is read exactly twice, both times streamed line by line so a
 * 100k-commit repository never materialises its (multi-gigabyte) log in memory.
 *
 *   Pass 1  --numstat   gives per-file insertion/deletion counts and, because
 *                       rename detection is on, a *combined* path string for
 *                       renames. It does not say whether a file was added or
 *                       deleted: a delete and a "removed every line" edit are
 *                       both `0<TAB>N<TAB>path`.
 *   Pass 2  --name-status gives the A/M/D/R/C/T letter and both sides of a
 *                       rename explicitly, but no line counts.
 *
 * Neither `--numstat` nor `--name-status` can be replaced by `--diff-filter`
 * here: filtering would drop rows we still need to attribute. So both passes
 * run, keyed on (sha, new path), and pass 2's statuses win.
 *
 * The passes run sequentially rather than concurrently. Concurrency would halve
 * wall time but requires buffering one pass's entire output as a side table —
 * on a 100k-commit repository that is hundreds of megabytes of transient
 * garbage. Running pass 2 second lets it write statuses directly into the
 * records pass 1 built, at zero extra retention.
 *
 * ORDERING: records are emitted newest-first, ordered by author time. `git log`
 * is asked for --topo-order (stable, and keeps a branch's commits together);
 * the final sort makes "newest first" literally true, which is what
 * `History.commits` promises and what every windowing consumer assumes.
 */

import type { ChangeStatus, CommitRecord, FileChange, History } from '../model'
import { Cancelled } from '../model'
import { streamLines } from './exec'

/** Record-separator byte. 0x01 cannot appear in a commit message; git strips NULs. */
const REC_CODE = 0x01
/** Field separator inside a record line. */
const FS = '\u001f'
/**
 * Commit header, written with git's own %xNN escapes so the separators are
 * unambiguous bytes in the output rather than literal control characters in
 * this source file.
 */
const LOG_FORMAT = '--format=%x01%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s'

/** How git joins the two halves of a rename in --numstat output. */
const ARROW = ' => '

/**
 * Rename detection threshold. Kept identical across both passes so the two
 * views of a commit describe the same set of paths.
 */
const RENAME_ARGS = ['-M', '--find-renames=50%'] as const

/**
 * A full `git log --numstat` over a very large repository legitimately takes
 * minutes. The gateway's 2-minute default would kill it mid-walk.
 */
const LOG_TIMEOUT_MS = 30 * 60_000

/** Commits between progress callbacks. */
const PROGRESS_EVERY = 1000

/**
 * Above this many files in one commit, pass 2 builds a path index instead of
 * scanning the file list. Agent-written repositories routinely produce commits
 * touching thousands of files, where the linear scan would be quadratic.
 */
const INDEX_THRESHOLD = 32

export interface ReadHistoryOptions {
  signal?: AbortSignal
  /** Called with the running commit count, every 1000 commits and once at the end. */
  onProgress?: (n: number) => void
  /** Overrides the (generous) default walk timeout. */
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Path parsing — the part that is always wrong in hand-rolled git parsers
// ---------------------------------------------------------------------------

export interface NumstatPath {
  path: string
  /** Set when the row describes a rename or copy. */
  oldPath?: string
}

/**
 * Parses the path field of a `--numstat` row.
 *
 * git renders a renamed path in one of two shapes, chosen by `pprint_rename()`
 * in diff.c:
 *
 *   1. `pre{old => new}post` — the compressed form, used when the two paths
 *      share a leading and/or trailing directory component. `pre` is empty or
 *      ends with '/', `post` is empty or starts with '/'.
 *   2. `old => new` — used when there is no common prefix *or* suffix, and
 *      also whenever either side needs C-quoting, because the compressed form
 *      cannot be quoted coherently. Each side is quoted independently, so
 *      `"old" => new` and `old => "new"` are both reachable.
 *
 * A non-rename row is a single path, C-quoted iff it contains a byte outside
 * printable ASCII (git's core.quotePath, on by default and not overridable
 * through the read-only gateway).
 *
 * The one genuinely ambiguous case — a file literally named `a => b` — is
 * unparseable from numstat output by construction; git emits the same bytes for
 * it as for a rename. Every consumer of this format shares that limitation.
 */
export function parseNumstatPath(raw: string): NumstatPath {
  // Shape 2, quoted variant. Detect it first: a leading quote means the
  // compressed form is impossible, so we can trust the quote scanner.
  if (raw.charCodeAt(0) === 0x22) {
    const close = findQuoteEnd(raw, 0)
    if (close > 0) {
      const rest = raw.slice(close + 1)
      if (rest.startsWith(ARROW)) {
        return { path: unquotePath(rest.slice(ARROW.length)), oldPath: unquotePath(raw.slice(0, close + 1)) }
      }
      if (close === raw.length - 1) return { path: unquotePath(raw) }
    }
    // Unterminated quote: malformed. Fall through and treat it as a plain path.
  }

  // Shape 1, the compressed form.
  const brace = BRACE_RENAME.exec(raw)
  if (brace) {
    const pre = brace[1] ?? ''
    const oldMid = brace[2] ?? ''
    const newMid = brace[3] ?? ''
    const post = brace[4] ?? ''
    // Validate git's invariants before trusting the match. A file whose *name*
    // contains braces and " => " would otherwise be misread as a rename.
    const preOk = pre.length === 0 || pre.endsWith('/')
    const postOk = post.length === 0 || post.startsWith('/')
    const compressed = pre.length > 0 || post.length > 0
    if (preOk && postOk && compressed) {
      return { path: joinBraced(pre, newMid, post), oldPath: joinBraced(pre, oldMid, post) }
    }
    // The match is a filename that merely *looks* like the compressed form, so
    // the " => " inside the braces is part of the name, not a separator. Only an
    // arrow outside the brace span could still make this a rename.
    const outer = arrowOutsideBraces(raw, brace)
    if (outer > 0) {
      return {
        path: unquotePath(raw.slice(outer + ARROW.length)),
        oldPath: unquotePath(raw.slice(0, outer))
      }
    }
    return { path: unquotePath(raw) }
  }

  // Shape 2, unquoted variant.
  const arrow = raw.indexOf(ARROW)
  if (arrow > 0) {
    return { path: unquotePath(raw.slice(arrow + ARROW.length)), oldPath: unquotePath(raw.slice(0, arrow)) }
  }

  return { path: unquotePath(raw) }
}

/**
 * Reassembles one side of a compressed rename.
 *
 * When a side of the brace is empty git elides the directory level entirely, so
 * `services/{ => vault}/f.json` is `services/f.json` → `services/vault/f.json`,
 * not `services//f.json`. Dropping the doubled separator is the whole job.
 */
function joinBraced(pre: string, mid: string, post: string): string {
  if (mid.length === 0 && pre.endsWith('/') && post.startsWith('/')) {
    return pre.slice(0, -1) + post
  }
  return pre + mid + post
}

/** Index of a ` => ` lying outside the matched brace span, or -1. */
function arrowOutsideBraces(raw: string, match: RegExpExecArray): number {
  const open = (match[1] ?? '').length
  const close = raw.indexOf('}', open)
  for (let i = raw.indexOf(ARROW); i !== -1; i = raw.indexOf(ARROW, i + 1)) {
    if (i > 0 && (i < open || (close !== -1 && i > close))) return i
  }
  return -1
}

/**
 * `(.*)` is greedy so it binds to the last `{`; the inner groups are lazy so
 * they bind to the first ` => ` and the first `}` after it. That is exactly how
 * git builds the string.
 */
const BRACE_RENAME = /^(.*)\{(.*?) => (.*?)\}(.*)$/

/** Index of the closing quote of the C-quoted token starting at `start`, or -1. */
function findQuoteEnd(s: string, start: number): number {
  for (let i = start + 1; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x5c) {
      i++ // skip the escaped character
      continue
    }
    if (c === 0x22) return i
  }
  return -1
}

function isOctalDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x37
}

/** git's C-quoting escapes, excluding the octal form handled separately. */
const SIMPLE_ESCAPES = new Map<number, number>([
  [0x61, 0x07], // \a
  [0x62, 0x08], // \b
  [0x74, 0x09], // \t
  [0x6e, 0x0a], // \n
  [0x76, 0x0b], // \v
  [0x66, 0x0c], // \f
  [0x72, 0x0d], // \r
  [0x22, 0x22], // \"
  [0x5c, 0x5c] //  \\
])

/**
 * Reverses git's C-style path quoting. Non-ASCII bytes arrive as three-digit
 * octal escapes, so the escapes are decoded to *bytes* and the result is
 * interpreted as UTF-8 — decoding them as characters would mangle every
 * non-Latin path.
 *
 * Exported because ls-tree output needs the same treatment.
 */
export function unquotePath(raw: string): string {
  if (raw.length < 2 || raw.charCodeAt(0) !== 0x22 || raw.charCodeAt(raw.length - 1) !== 0x22) {
    return raw
  }

  const parts: Buffer[] = []
  let plain = ''
  const flush = (): void => {
    if (plain.length > 0) {
      parts.push(Buffer.from(plain, 'utf8'))
      plain = ''
    }
  }

  const end = raw.length - 1
  let i = 1
  while (i < end) {
    if (raw.charCodeAt(i) !== 0x5c) {
      plain += raw.charAt(i)
      i++
      continue
    }
    const d0 = raw.charCodeAt(i + 1)
    const d1 = raw.charCodeAt(i + 2)
    const d2 = raw.charCodeAt(i + 3)
    if (i + 3 < end && isOctalDigit(d0) && isOctalDigit(d1) && isOctalDigit(d2)) {
      flush()
      parts.push(Buffer.from([(((d0 - 0x30) << 6) | ((d1 - 0x30) << 3) | (d2 - 0x30)) & 0xff]))
      i += 4
      continue
    }
    const simple = SIMPLE_ESCAPES.get(d0)
    if (simple !== undefined) {
      flush()
      parts.push(Buffer.from([simple]))
      i += 2
      continue
    }
    // Trailing backslash, or an escape git does not emit: keep it verbatim
    // rather than silently dropping a character from the path.
    plain += Number.isNaN(d0) ? '\\' : raw.charAt(i + 1)
    i += Number.isNaN(d0) ? 1 : 2
  }
  flush()

  return Buffer.concat(parts).toString('utf8')
}

// ---------------------------------------------------------------------------
// readHistory
// ---------------------------------------------------------------------------

/**
 * Reads the complete history reachable from HEAD.
 *
 * Merge commits are included — `CommitRecord.isMerge` marks them — because
 * cadence and authorship need them. Their `files` list is empty, since git
 * reports no diff for a merge without `-m`/`--first-parent`; that is deliberate
 * and is what stops merges double-counting the changes they bring in.
 */
export async function readHistory(repoPath: string, opts: ReadHistoryOptions = {}): Promise<History> {
  throwIfCancelled(opts.signal)

  const timeoutMs = opts.timeoutMs ?? LOG_TIMEOUT_MS
  const commits: CommitRecord[] = []
  const authors = new Map<string, string>()

  // --- Pass 1: numstat -----------------------------------------------------

  let current: CommitRecord | null = null
  let parsed = 0

  const finish = (): void => {
    if (current) commits.push(current)
    current = null
  }

  await guard(
    streamLines(
      repoPath,
      [
        'log',
        '--no-color',
        '--topo-order',
        '--date=raw',
        LOG_FORMAT,
        '--numstat',
        ...RENAME_ARGS,
        'HEAD',
        '--'
      ],
      (line) => {
        if (line.length === 0) return
        if (line.charCodeAt(0) === REC_CODE) {
          finish()
          current = parseRecordLine(line)
          if (current) {
            parsed++
            if (!authors.has(current.authorEmail)) {
              // Newest-first, so the first name seen for an address is the most
              // recent one that author used.
              authors.set(current.authorEmail, current.authorName)
            }
            if (parsed % PROGRESS_EVERY === 0) opts.onProgress?.(parsed)
          }
          return
        }
        if (!current) return
        const change = parseNumstatRow(line)
        if (change) current.files.push(change)
      },
      { signal: opts.signal, timeoutMs }
    ),
    opts.signal
  )
  finish()

  opts.onProgress?.(parsed)

  if (commits.length === 0) {
    return { commits: [], firstAt: 0, lastAt: 0, authors }
  }

  // git's --topo-order is topological, not chronological. Sorting makes the
  // documented "newest first" invariant true; on the common linear history this
  // is a no-op.
  commits.sort(byAuthorTimeDescending)

  // Derive A/R before pass 2. If the name-status walk fails on an exotic git,
  // the history is still broadly correct rather than uniformly 'M'.
  deriveAddStatuses(commits)

  // --- Pass 2: name-status -------------------------------------------------

  throwIfCancelled(opts.signal)

  const bySha = new Map<string, CommitRecord>()
  for (const c of commits) bySha.set(c.sha, c)

  let target: CommitRecord | null = null
  let targetIndex: Map<string, FileChange> | null = null

  await guard(
    streamLines(
      repoPath,
      ['log', '--no-color', '--topo-order', '--format=%x01%H', '--name-status', ...RENAME_ARGS, 'HEAD', '--'],
      (line) => {
        if (line.length === 0) return
        if (line.charCodeAt(0) === REC_CODE) {
          target = bySha.get(line.slice(1)) ?? null
          targetIndex =
            target && target.files.length > INDEX_THRESHOLD ? new Map(target.files.map((f) => [f.path, f])) : null
          return
        }
        if (!target) return
        applyNameStatusRow(line, target, targetIndex)
      },
      { signal: opts.signal, timeoutMs }
    ),
    opts.signal
  )

  // `commits` is sorted descending, so the extremes are the ends of the array.
  const newest = commits[0]
  const oldest = commits[commits.length - 1]

  return {
    commits,
    firstAt: oldest ? oldest.authoredAt : 0,
    lastAt: newest ? newest.authoredAt : 0,
    authors
  }
}

// ---------------------------------------------------------------------------
// Record parsing
// ---------------------------------------------------------------------------

/**
 * Exact ties are left to the sort's stability, which preserves git's
 * --topo-order sequence — the only correct order for commits sharing a
 * timestamp. Agent-written repositories commit several times a second, so this
 * is a common case, not a corner one: any synthetic tiebreak (sha, say) would
 * silently reverse real history. --topo-order is itself deterministic, so the
 * result is still stable across runs, which the snapshot cache relies on.
 */
function byAuthorTimeDescending(a: CommitRecord, b: CommitRecord): number {
  if (b.authoredAt !== a.authoredAt) return b.authoredAt - a.authoredAt
  return b.committedAt - a.committedAt
}

function parseRecordLine(line: string): CommitRecord | null {
  const fields = line.slice(1).split(FS)
  if (fields.length < 7) return null

  const sha = fields[0] ?? ''
  if (sha.length === 0) return null

  const parentField = fields[1] ?? ''
  const parents = parentField.length > 0 ? parentField.split(' ').filter((p) => p.length > 0) : []

  const authoredSecs = Number.parseInt(fields[4] ?? '', 10)
  const committedSecs = Number.parseInt(fields[5] ?? '', 10)

  return {
    sha,
    parents,
    authorName: fields[2] ?? '',
    authorEmail: fields[3] ?? '',
    // git reports epoch seconds; the model is epoch milliseconds throughout.
    authoredAt: Number.isFinite(authoredSecs) ? authoredSecs * 1000 : 0,
    committedAt: Number.isFinite(committedSecs) ? committedSecs * 1000 : 0,
    // A subject containing 0x1f is not possible in practice, but rejoining
    // costs nothing and makes the parse total.
    subject: fields.length > 7 ? fields.slice(6).join(FS) : (fields[6] ?? ''),
    files: [],
    isMerge: parents.length > 1
  }
}

/** Matches '-' (binary) or a run of digits. Anything else is not a numstat row. */
function parseCount(raw: string): number | null {
  if (raw === '-') return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

function parseNumstatRow(line: string): FileChange | null {
  const t1 = line.indexOf('\t')
  if (t1 <= 0) return null
  const t2 = line.indexOf('\t', t1 + 1)
  if (t2 < 0) return null

  const addRaw = line.slice(0, t1)
  const delRaw = line.slice(t1 + 1, t2)
  const binary = addRaw === '-' && delRaw === '-'
  const added = parseCount(addRaw)
  const deleted = parseCount(delRaw)

  // Guards against a stray line (e.g. a pathological multi-line subject) being
  // mistaken for a numstat row.
  if (!binary && (added === null || deleted === null)) return null

  const { path, oldPath } = parseNumstatPath(line.slice(t2 + 1))
  if (path.length === 0) return null

  const change: FileChange = {
    path,
    // Provisional. Pass 2 replaces this with git's own letter.
    status: oldPath === undefined ? 'M' : 'R',
    insertions: added ?? 0,
    deletions: deleted ?? 0,
    binary
  }
  if (oldPath !== undefined) change.oldPath = oldPath
  return change
}

/**
 * Marks the commit in which each path first appears as its 'A'.
 *
 * Walks oldest-to-newest — the only direction in which "first appearance" means
 * creation. Deletions cannot be recognised from numstat alone (a delete and a
 * total rewrite produce identical rows), so a path that is deleted and later
 * recreated stays 'M' on the second creation until pass 2 corrects it.
 */
function deriveAddStatuses(commits: CommitRecord[]): void {
  const seen = new Set<string>()
  for (let i = commits.length - 1; i >= 0; i--) {
    const c = commits[i]
    if (!c) continue
    for (const f of c.files) {
      if (f.oldPath !== undefined) {
        seen.delete(f.oldPath)
        seen.add(f.path)
        continue
      }
      if (!seen.has(f.path)) {
        f.status = 'A'
        seen.add(f.path)
      }
    }
  }
}

function statusLetter(raw: string): ChangeStatus | null {
  // Rename and copy statuses carry a similarity score: R100, C085.
  switch (raw.charAt(0)) {
    case 'A':
      return 'A'
    case 'M':
      return 'M'
    case 'D':
      return 'D'
    case 'R':
      return 'R'
    case 'C':
      return 'C'
    case 'T':
      return 'T'
    default:
      // 'U' (unmerged) and 'X' (a git bug) carry no information we can use.
      return null
  }
}

/**
 * Applies one `--name-status` row to the commit pass 1 built.
 *
 * Rows are `<status>\t<path>` or, for renames and copies,
 * `<status><score>\t<old>\t<new>`. Paths are C-quoted on the same rules as
 * numstat. The key is always the *new* path, which is what pass 1 stored.
 */
function applyNameStatusRow(line: string, commit: CommitRecord, index: Map<string, FileChange> | null): void {
  const parts = line.split('\t')
  const status = statusLetter(parts[0] ?? '')
  if (!status) return

  const isRenameOrCopy = (status === 'R' || status === 'C') && parts.length >= 3
  const pathRaw = isRenameOrCopy ? parts[2] : parts[1]
  if (pathRaw === undefined) return
  const path = unquotePath(pathRaw)

  const change = index ? index.get(path) : commit.files.find((f) => f.path === path)
  // A row with no numstat counterpart cannot happen for identical diff options;
  // dropping it is safer than inventing a FileChange with fabricated counts.
  if (!change) return

  change.status = status
  if (isRenameOrCopy) {
    const oldRaw = parts[1]
    if (oldRaw !== undefined) change.oldPath = unquotePath(oldRaw)
  } else if (change.oldPath !== undefined) {
    // git no longer considers this a rename; do not leave a stale ancestor.
    delete change.oldPath
  }
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Cancelled()
}

/**
 * The gateway kills the child and rejects with a generic error on abort.
 * Translate that into the engine's Cancelled so the orchestrator can unwind
 * without treating a user cancellation as a failure.
 */
async function guard(work: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  try {
    await work
  } catch (e) {
    if (signal?.aborted) throw new Cancelled()
    throw e
  }
}
