/**
 * The read-only git gateway.
 *
 * VDE points at other people's repositories. It must be *incapable* of
 * modifying them, not merely uninterested in doing so. Every git invocation in
 * the entire application goes through this module, and this module enforces:
 *
 *   1. An allowlist of subcommands that cannot write. Anything not on the list
 *      throws before a process is spawned.
 *   2. A denylist of argument forms that can turn a read into code execution —
 *      caller-supplied `-c`, `--exec-path`, `-C`, `--upload-pack`, and the
 *      `-w` that makes hash-object write into the object store.
 *   3. Hardened config injected by us, closing the paths by which a *hostile
 *      or merely unlucky* repository can execute code during a read:
 *        core.pager / pager.<cmd>  → arbitrary command on any output
 *        core.fsmonitor            → arbitrary command on any status read
 *        diff.external             → arbitrary command during diff
 *        core.hooksPath            → hooks (belt and braces; reads don't fire them)
 *   4. GIT_OPTIONAL_LOCKS=0, so git will not even take index.lock to refresh
 *      the index as a side effect of a read.
 *
 * Git aliases cannot shadow built-in subcommands, so the allowlist cannot be
 * subverted that way.
 *
 * `assertUnchanged` provides the auditable half of the promise: capture the
 * repository's mutable state before a scan, verify it afterwards.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Subcommands that cannot mutate a repository under any argument combination. */
const ALLOWED = new Set([
  'rev-parse',
  'rev-list',
  'log',
  'show',
  'ls-tree',
  'ls-files',
  'cat-file',
  'diff-tree',
  'diff',
  'shortlog',
  'for-each-ref',
  'symbolic-ref',
  'name-rev',
  'describe',
  'merge-base',
  'blame',
  'count-objects',
  'var',
  'config'
])

/**
 * Argument forms rejected regardless of subcommand. `-c` and `--config-env`
 * would let a caller re-open the config holes we close below; `-C`,
 * `--git-dir` and `--work-tree` would let a caller escape the validated repo
 * path; `--exec-path`, `--upload-pack` and `--receive-pack` name programs to
 * run; `-w` makes `hash-object` and `blame` write.
 */
const FORBIDDEN_ARG = /^(-c$|--config-env|--exec-path|-C$|--git-dir|--work-tree|--upload-pack|--receive-pack|-w$|--write)/

/** `git config` is read-only only in these forms. */
const CONFIG_READ_ONLY = /^(--get|--get-all|--get-regexp|--list|-l)$/

/** Config that neutralises every known read-time code-execution path. */
const HARDENING = [
  '-c',
  'core.pager=cat',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'uploadpack.allowFilter=false',
  '-c',
  'safe.bareRepository=explicit'
]

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_ASKPASS: 'true',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  LC_ALL: 'C',
  TZ: 'UTC'
}

export class GitReadOnlyViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitReadOnlyViolation'
  }
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string
  ) {
    super(message)
    this.name = 'GitCommandError'
  }
}

function assertReadOnly(args: readonly string[]): void {
  const sub = args[0]
  if (!sub) throw new GitReadOnlyViolation('git invoked with no subcommand')
  if (!ALLOWED.has(sub)) {
    throw new GitReadOnlyViolation(
      `git subcommand "${sub}" is not on VDE's read-only allowlist. VDE never writes to an analysed repository.`
    )
  }
  for (const a of args.slice(1)) {
    if (FORBIDDEN_ARG.test(a)) {
      throw new GitReadOnlyViolation(`git argument "${a}" is forbidden by the read-only gateway.`)
    }
  }
  if (sub === 'config') {
    const mode = args[1]
    if (!mode || !CONFIG_READ_ONLY.test(mode)) {
      throw new GitReadOnlyViolation(
        `git config is permitted only in read form (--get/--get-all/--get-regexp/--list); received "${mode ?? ''}".`
      )
    }
  }
}

export interface GitRunOptions {
  /** Kill the process after this many milliseconds. */
  timeoutMs?: number
  /** Abort signal, used to cancel an in-flight scan. */
  signal?: AbortSignal
  /** Cap on buffered stdout in bytes. Exceeding it rejects. */
  maxBuffer?: number
}

const DEFAULT_TIMEOUT = 120_000
const DEFAULT_MAX_BUFFER = 512 * 1024 * 1024

/**
 * Runs a read-only git command and buffers stdout.
 *
 * Prefer {@link streamLines} for commands whose output scales with repository
 * history — `git log --numstat` on a large repo can exceed a gigabyte.
 *
 * Declared `async` deliberately: a guard violation must arrive as a REJECTION,
 * not a synchronous throw. A function typed `Promise<T>` that sometimes throws
 * before returning is a trap — a caller using `.catch()` rather than
 * `try/await` would miss the violation entirely.
 */
export async function run(
  cwd: string,
  args: readonly string[],
  opts: GitRunOptions = {}
): Promise<string> {
  assertReadOnly(args)
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER

  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', ...HARDENING, ...args], {
      cwd,
      env: ENV,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const out: Buffer[] = []
    let outLen = 0
    let err = ''
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL')
        settle(() =>
          reject(new GitCommandError(`git ${args[0]} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT}ms`, null, err))
        )
      }
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT)

    const onAbort = (): void => {
      child.kill('SIGKILL')
      settle(() => reject(new GitCommandError('cancelled', null, '')))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    function settle(fn: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      outLen += chunk.length
      if (outLen > maxBuffer) {
        child.kill('SIGKILL')
        settle(() => reject(new GitCommandError(`git ${args[0]} exceeded ${maxBuffer} bytes of output`, null, err)))
        return
      }
      out.push(chunk)
    })
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 64_000) err += c.toString('utf8')
    })
    child.on('error', (e) => settle(() => reject(new GitCommandError(e.message, null, err))))
    child.on('close', (code) => {
      settle(() => {
        if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
        else reject(new GitCommandError(`git ${args.join(' ')} exited ${code}: ${err.trim()}`, code, err))
      })
    })
  })
}

/**
 * Runs a read-only git command, invoking `onLine` for each output line without
 * ever holding the full output in memory. This is how history is read.
 *
 * `separator` defaults to newline; pass '\0' for `-z` output.
 */
export async function streamLines(
  cwd: string,
  args: readonly string[],
  onLine: (line: string) => void,
  opts: GitRunOptions & { separator?: string } = {}
): Promise<void> {
  assertReadOnly(args)
  const sep = opts.separator ?? '\n'

  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', ...HARDENING, ...args], {
      cwd,
      env: ENV,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let carry = ''
    let err = ''
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL')
        settle(() => reject(new GitCommandError(`git ${args[0]} timed out`, null, err)))
      }
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT)

    const onAbort = (): void => {
      child.kill('SIGKILL')
      settle(() => reject(new GitCommandError('cancelled', null, '')))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    function settle(fn: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      carry += chunk
      let i = carry.indexOf(sep)
      while (i !== -1) {
        onLine(carry.slice(0, i))
        carry = carry.slice(i + sep.length)
        i = carry.indexOf(sep)
      }
    })
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 64_000) err += c.toString('utf8')
    })
    child.on('error', (e) => settle(() => reject(new GitCommandError(e.message, null, err))))
    child.on('close', (code) => {
      settle(() => {
        if (carry.length > 0) onLine(carry)
        if (code === 0) resolve()
        else reject(new GitCommandError(`git ${args.join(' ')} exited ${code}: ${err.trim()}`, code, err))
      })
    })
  })
}

/** Reads a blob's raw bytes. Streams so large blobs never sit in a string. */
export async function readBlob(
  cwd: string,
  sha: string,
  opts: GitRunOptions = {}
): Promise<Buffer> {
  const args = ['cat-file', 'blob', sha]
  assertReadOnly(args)
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', ...HARDENING, ...args], {
      cwd,
      env: ENV,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks: Buffer[] = []
    let len = 0
    const cap = opts.maxBuffer ?? 16 * 1024 * 1024
    let err = ''
    child.stdout.on('data', (c: Buffer) => {
      len += c.length
      if (len > cap) {
        child.kill('SIGKILL')
        reject(new GitCommandError(`blob ${sha} exceeds ${cap} bytes`, null, ''))
        return
      }
      chunks.push(c)
    })
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 8000) err += c.toString('utf8')
    })
    child.on('error', (e) => reject(new GitCommandError(e.message, null, err)))
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new GitCommandError(`cat-file blob ${sha} exited ${code}: ${err.trim()}`, code, err))
    )
  })
}

// ---------------------------------------------------------------------------
// The tripwire
// ---------------------------------------------------------------------------

export interface RepoFingerprint {
  head: string
  refs: string
  indexMtimeMs: number | null
  indexSize: number | null
}

/**
 * Captures the repository's mutable state. Compare before and after a scan to
 * prove VDE changed nothing.
 */
export async function fingerprint(repoPath: string): Promise<RepoFingerprint> {
  const head = (await run(repoPath, ['rev-parse', 'HEAD'])).trim()
  const refs = await run(repoPath, ['for-each-ref', '--format=%(refname) %(objectname)'])
  let indexMtimeMs: number | null = null
  let indexSize: number | null = null
  try {
    const s = await stat(join(repoPath, '.git', 'index'))
    indexMtimeMs = s.mtimeMs
    indexSize = s.size
  } catch {
    // Worktrees and bare repos may not have one here; absence is itself stable.
  }
  return {
    head,
    refs: createHash('sha256').update(refs).digest('hex'),
    indexMtimeMs,
    indexSize
  }
}

/**
 * Throws if the repository changed between two fingerprints. A caught throw
 * here is a bug in VDE, not in the user's repository.
 */
export function assertUnchanged(before: RepoFingerprint, after: RepoFingerprint, repoPath: string): void {
  const diffs: string[] = []
  if (before.head !== after.head) diffs.push(`HEAD ${before.head} → ${after.head}`)
  if (before.refs !== after.refs) diffs.push('refs changed')
  if (before.indexMtimeMs !== after.indexMtimeMs) diffs.push('.git/index mtime changed')
  if (before.indexSize !== after.indexSize) diffs.push('.git/index size changed')
  if (diffs.length > 0) {
    throw new GitReadOnlyViolation(
      `VDE detected a change to ${repoPath} during analysis (${diffs.join('; ')}). ` +
        `VDE must never modify an analysed repository. Report this as a bug.`
    )
  }
}

/** Exposed for tests. */
export const __testing = { assertReadOnly, ALLOWED, FORBIDDEN_ARG }
