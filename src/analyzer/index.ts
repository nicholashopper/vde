/**
 * The analyzer utility process.
 *
 * VDE's engine runs here, in its own Node context with no window and no DOM, so
 * that a multi-minute history walk or a tree-sitter parse storm cannot stall the
 * UI or the main process event loop. Everything below is wiring: message in,
 * handler, message out. The analysis itself lives in the modules this file
 * imports.
 *
 * Four properties this process guarantees.
 *
 *  1. IT NEVER TAKES THE APP DOWN. Every handler wraps its failure into an
 *     `{ ok: false }` reply, and `uncaughtException` / `unhandledRejection` are
 *     reported rather than fatal. A crashed analyzer means a spinner that never
 *     stops and a user who has to restart VDE; an error reply means a message on
 *     screen.
 *
 *  2. IT NEVER WRITES TO THE REPOSITORY. Every git call goes through the
 *     read-only gateway, and every scan brackets its work with a fingerprint of
 *     the repository's mutable state. If those fingerprints differ the scan
 *     fails loudly. That tripwire is not decoration: it is the auditable half of
 *     the promise the product is sold on, and it runs on every single scan.
 *
 *  3. IT CAN BE STOPPED. Each in-flight scan owns an `AbortController`, so
 *     'cancel' unwinds it promptly — the git gateway kills its child processes
 *     on abort and the content loop checks between batches.
 *
 *  4. IT REPORTS PROGRESS. Long operations push `AnalyzerEvent` messages with
 *     id -1 so the window can show something moving. Requests and events share a
 *     port, which is why events carry a reserved id rather than a flag.
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

import type { AnalyzerEvent, AnalyzerRequest, AnalyzerResponse } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { AnalysisPhase, AnalysisProgress, RepoRef, RepoReport, Settings } from '../shared/types'
import { generateBrief } from './brief'
import { disposeParsers, initParser } from './content/parse'
import { Db, openDb } from './db'
import { assertUnchanged, fingerprint } from './git/exec'
import { readHistory } from './git/log'
import { assertRepoPresent, validateRepo } from './git/repo'
import { Cancelled } from './model'
import { buildReport } from './report'
import { backfill } from './snapshots/backfill'

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/**
 * Electron types `process.parentPort` as always present, which is true inside a
 * utility process and false everywhere else. The widening keeps the guard below
 * honest without reaching for a non-null assertion.
 */
type ParentPort = typeof process.parentPort
const parentPort: ParentPort | undefined = process.parentPort

function post(message: AnalyzerResponse | AnalyzerEvent): void {
  parentPort?.postMessage(message)
}

function describe(err: unknown): { error: string; stack?: string } {
  if (err instanceof Error) {
    return { error: err.message || err.name, stack: err.stack }
  }
  return { error: String(err) }
}

// ---------------------------------------------------------------------------
// Process state
// ---------------------------------------------------------------------------

let db: Db | null = null
/** Set once 'init' has run; grammar loading is lazy from there on. */
let parserReady = false

/**
 * repoId → every cancellable operation currently running against it.
 *
 * A set rather than a single controller because a report can legitimately be
 * building while a scan runs, and 'cancel' means "stop working on this
 * repository", not "stop the scan and leave the report spinning".
 */
const inFlight = new Map<string, Set<AbortController>>()

function register(repoId: string): AbortController {
  const controller = new AbortController()
  const existing = inFlight.get(repoId)
  if (existing === undefined) inFlight.set(repoId, new Set([controller]))
  else existing.add(controller)
  return controller
}

function release(repoId: string, controller: AbortController): void {
  const set = inFlight.get(repoId)
  if (set === undefined) return
  set.delete(controller)
  if (set.size === 0) inFlight.delete(repoId)
}

function cancelAll(repoId: string): void {
  const set = inFlight.get(repoId)
  if (set === undefined) return
  for (const controller of set) controller.abort()
  inFlight.delete(repoId)
}

function requireDb(): Db {
  if (db === null || !db.isOpen) {
    throw new Error(
      'The analyzer database is not open. This is a wiring bug: send an "init" request before anything else.'
    )
  }
  return db
}

function settingsOf(partial: Settings | undefined): Settings {
  // A malformed settings payload must not be able to disable exclusion globs and
  // send VDE walking node_modules.
  if (partial === undefined || typeof partial !== 'object') return DEFAULT_SETTINGS
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    excludeGlobs: Array.isArray(partial.excludeGlobs) ? partial.excludeGlobs : DEFAULT_SETTINGS.excludeGlobs,
    generatedGlobs: Array.isArray(partial.generatedGlobs)
      ? partial.generatedGlobs
      : DEFAULT_SETTINGS.generatedGlobs
  }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** Weight of each phase in the 0–1 overall bar. Ordered as they actually run. */
const PHASE_WEIGHTS: ReadonlyArray<readonly [AnalysisPhase, number]> = [
  ['validating', 0.02],
  ['reading-history', 0.18],
  ['backfilling', 0.72],
  ['computing-signals', 0.08]
]

function overallFor(phase: AnalysisPhase, fraction: number): number {
  let before = 0
  for (const [name, weight] of PHASE_WEIGHTS) {
    if (name === phase) {
      const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
      return Math.min(1, before + weight * clamped)
    }
    before += weight
  }
  return phase === 'done' ? 1 : before
}

class ProgressReporter {
  private readonly startedAt = new Date().toISOString()
  private last = 0

  constructor(private readonly repoId: string) {}

  /**
   * Pushes a progress event, throttled to ~12/second.
   *
   * Terminal phases and the first event of a phase always go out: a bar that
   * stops one tick short of done is a bar the user does not trust.
   */
  report(phase: AnalysisPhase, message: string, current: number, total: number): void {
    const now = Date.now()
    const terminal = phase === 'done' || phase === 'error' || phase === 'cancelled'
    if (!terminal && current > 0 && now - this.last < 80) return
    this.last = now

    const payload: AnalysisProgress = {
      repoId: this.repoId,
      phase,
      message,
      current,
      total,
      overall: overallFor(phase, total > 0 ? current / total : 0),
      startedAt: this.startedAt
    }
    post({ id: -1, event: 'progress', payload })
  }

  fail(message: string, error: string): void {
    post({
      id: -1,
      event: 'progress',
      payload: {
        repoId: this.repoId,
        phase: 'error',
        message,
        current: 0,
        total: 0,
        overall: 1,
        startedAt: this.startedAt,
        error
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Parser initialisation
// ---------------------------------------------------------------------------

/**
 * Locates web-tree-sitter's own runtime binary.
 *
 * The host passes the grammar directory; the runtime wasm sits next to the
 * grammars in a packaged build and inside its own package in development.
 * Failing to find it is not fatal — VDE simply reports no complexity data —
 * because a repository's other thirteen signals are still worth having.
 */
function runtimeWasmCandidates(wasmPath: string): string[] {
  const candidates: string[] = [join(wasmPath, 'web-tree-sitter.wasm')]

  const fromEnv = process.env.VDE_WEB_TREE_SITTER_PATH
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    candidates.push(join(fromEnv, 'web-tree-sitter.wasm'))
  }

  try {
    const require = createRequire(import.meta.url)
    candidates.push(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
  } catch {
    // Bundled, or packed with a different layout. The other candidates cover it.
  }

  return candidates
}

async function initParsers(wasmPath: string): Promise<void> {
  if (parserReady) return
  const candidates = runtimeWasmCandidates(wasmPath)
  let lastError: unknown = null

  for (const runtimeWasmPath of candidates) {
    try {
      await initParser(wasmPath, { runtimeWasmPath })
      parserReady = true
      return
    } catch (err) {
      lastError = err
    }
  }

  // Degraded, not broken: complexityDrift reports zero and every other signal is
  // unaffected. Say so on stderr, which the host mirrors into its own log.
  console.error(
    `[analyzer] tree-sitter could not be initialised from ${wasmPath}; ` +
      `complexity analysis is disabled for this session. ${describe(lastError).error}`
  )
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleInit(req: Extract<AnalyzerRequest, { kind: 'init' }>): Promise<null> {
  if (db === null || !db.isOpen) db = openDb(req.userDataPath)
  await initParsers(req.wasmPath)
  return null
}

async function handleValidate(req: Extract<AnalyzerRequest, { kind: 'validate' }>): Promise<RepoRef> {
  const store = requireDb()
  const warnings: string[] = []
  const ref = await validateRepo(req.path, { onWarning: (m) => warnings.push(m) })
  for (const message of warnings) console.warn(`[analyzer] ${message}`)

  // An already-known repository keeps the date the user added it and its last
  // scan; a new one is inserted with the defaults validateRepo produced.
  const existing = store.getRepo(ref.id)
  const merged: RepoRef = existing === null ? ref : { ...ref, addedAt: existing.addedAt, lastScanAt: existing.lastScanAt }
  store.upsertRepo(merged)
  return merged
}

async function handleScan(req: Extract<AnalyzerRequest, { kind: 'scan' }>): Promise<null> {
  await assertRepoPresent(req.path)
  const store = requireDb()
  const settings = settingsOf(req.settings)
  const progress = new ProgressReporter(req.repoId)

  // A second scan of the same repository replaces the first rather than racing
  // it: two backfills writing the same snapshot rows is wasted work at best.
  cancelAll(req.repoId)
  const controller = register(req.repoId)
  const signal = controller.signal

  try {
    progress.report('validating', 'Checking the repository', 0, 0)

    // THE TRIPWIRE, half one. Everything between here and the second capture is
    // read-only by construction; this proves it rather than asserting it.
    const before = await fingerprint(req.path)

    const ref = await validateRepo(req.path, {
      signal,
      onWarning: (message) => console.warn(`[analyzer] ${message}`)
    })
    const existing = store.getRepo(ref.id)
    store.upsertRepo(existing === null ? ref : { ...ref, addedAt: existing.addedAt, lastScanAt: existing.lastScanAt })

    progress.report('reading-history', 'Reading commit history', 0, ref.commitCount)
    const history = await readHistory(req.path, {
      signal,
      onProgress: (n) => progress.report('reading-history', `Read ${n} commits`, n, ref.commitCount)
    })

    progress.report('backfilling', 'Reconstructing snapshots', 0, 0)
    const result = await backfill(
      req.path,
      ref.id,
      history,
      store,
      settings,
      (current, total, revision) =>
        progress.report('backfilling', `Snapshot ${current + 1} of ${total} (${revision.date})`, current, total),
      signal,
      { force: req.opts?.force === true, maxSnapshots: req.opts?.maxSnapshots ?? settings.maxSnapshots }
    )

    for (const message of result.warnings) console.warn(`[analyzer] ${message}`)
    console.log(
      `[analyzer] ${ref.name}: ${result.computed} snapshots computed, ${result.skipped} cached, ` +
        `blob cache ${(result.cacheHitRate * 100).toFixed(1)}% hit ` +
        `(${result.cache.hits} hits / ${result.cache.misses} misses) in ${(result.elapsedMs / 1000).toFixed(1)}s`
    )

    // THE TRIPWIRE, half two. A difference here is a bug in VDE, never in the
    // user's repository, and it must be impossible to miss.
    const after = await fingerprint(req.path)
    assertUnchanged(before, after, req.path)

    const scannedAt = new Date().toISOString()
    store.upsertRepo({ ...ref, lastScanAt: scannedAt, addedAt: existing?.addedAt ?? ref.addedAt })
    store.setScanState(ref.id, { lastHead: ref.head, lastScannedAt: scannedAt })

    progress.report('done', 'Scan complete', 1, 1)
    return null
  } catch (err) {
    if (err instanceof Cancelled || signal.aborted) {
      progress.report('cancelled', 'Scan cancelled', 0, 0)
      return null
    }
    const { error } = describe(err)
    progress.fail('Scan failed', error)
    throw err
  } finally {
    release(req.repoId, controller)
  }
}

function handleCancel(req: Extract<AnalyzerRequest, { kind: 'cancel' }>): null {
  cancelAll(req.repoId)
  return null
}

async function handleReport(req: Extract<AnalyzerRequest, { kind: 'report' }>): Promise<RepoReport> {
  await assertRepoPresent(req.path)
  const store = requireDb()
  const progress = new ProgressReporter(req.repoId)
  // Usually fast — after a scan every blob is cached — but the first report on a
  // cold database does the full content pass, and that has to be interruptible.
  const controller = register(req.repoId)
  try {
    const report = await buildReport(
      req.repoId,
      req.path,
      req.baseline,
      req.ref,
      store,
      settingsOf(req.settings),
      controller.signal,
      { onProgress: (phase, message, current, total) => progress.report(phase, message, current, total) }
    )
    return report
  } catch (err) {
    if (!(err instanceof Cancelled)) progress.fail('Could not build the report', describe(err).error)
    throw err
  } finally {
    release(req.repoId, controller)
  }
}

async function handleBrief(req: Extract<AnalyzerRequest, { kind: 'brief' }>): Promise<string> {
  await assertRepoPresent(req.path)
  const store = requireDb()
  const controller = register(req.repoId)
  try {
    // The brief is rendered from a report rather than from stored findings:
    // findings carry drivers and evidence that are deliberately not persisted,
    // so rebuilding is the only way to produce a brief that is current. The
    // baseline is irrelevant here — the brief renders no deltas — so 'first' is
    // used because it always resolves without a date lookup.
    const report = await buildReport(
      req.repoId,
      req.path,
      'first',
      undefined,
      store,
      settingsOf(req.settings),
      controller.signal
    )
    return generateBrief(report, req.findingIds)
  } finally {
    release(req.repoId, controller)
  }
}

function handleForget(req: Extract<AnalyzerRequest, { kind: 'forget' }>): null {
  const store = requireDb()
  cancelAll(req.repoId)
  store.removeRepo(req.repoId)
  return null
}

function handleReposList(): RepoRef[] {
  return requireDb().listRepos()
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * `AnalyzerResponse` is a discriminated union over `kind`, so each branch must
 * construct its own reply object for the types to line up. The repetition is
 * what makes a mismatched payload a compile error rather than a renderer crash.
 */
async function dispatch(req: AnalyzerRequest): Promise<AnalyzerResponse> {
  switch (req.kind) {
    case 'init':
      return { id: req.id, ok: true, kind: 'init', result: await handleInit(req) }
    case 'validate':
      return { id: req.id, ok: true, kind: 'validate', result: await handleValidate(req) }
    case 'scan':
      return { id: req.id, ok: true, kind: 'scan', result: await handleScan(req) }
    case 'cancel':
      return { id: req.id, ok: true, kind: 'cancel', result: handleCancel(req) }
    case 'report':
      return { id: req.id, ok: true, kind: 'report', result: await handleReport(req) }
    case 'brief':
      return { id: req.id, ok: true, kind: 'brief', result: await handleBrief(req) }
    case 'forget':
      return { id: req.id, ok: true, kind: 'forget', result: handleForget(req) }
    case 'repos-list':
      return { id: req.id, ok: true, kind: 'repos-list', result: handleReposList() }
    default:
      // Exhaustive today; a future request kind reaches here instead of hanging
      // the caller's promise forever.
      return {
        id: (req as { id?: number }).id ?? -2,
        ok: false,
        error: `Unknown analyzer request kind: ${String((req as { kind?: unknown }).kind)}`
      }
  }
}

function isRequest(value: unknown): value is AnalyzerRequest {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { id?: unknown; kind?: unknown }
  return typeof candidate.id === 'number' && typeof candidate.kind === 'string'
}

async function onMessage(raw: unknown): Promise<void> {
  if (!isRequest(raw)) {
    console.error('[analyzer] ignoring a message that is not an AnalyzerRequest')
    return
  }
  try {
    post(await dispatch(raw))
  } catch (err) {
    if (err instanceof Cancelled) {
      post({ id: raw.id, ok: false, error: 'cancelled' })
      return
    }
    const { error, stack } = describe(err)
    console.error(`[analyzer] ${raw.kind} failed: ${error}`)
    post({ id: raw.id, ok: false, error, stack })
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (parentPort === undefined) {
  console.error(
    '[analyzer] no parent port: this entry point is meant to run inside an Electron utility process.'
  )
} else {
  parentPort.on('message', (event) => {
    // Electron types MessageEvent.data as `any`; narrow it immediately so
    // nothing downstream inherits that.
    const data: unknown = event.data
    void onMessage(data)
  })
}

/**
 * A crash here would leave every pending request unanswered and the UI spinning
 * forever. Report and keep serving: the next request usually succeeds, and if it
 * does not the user sees a real error instead of a hang.
 */
process.on('uncaughtException', (err) => {
  console.error('[analyzer] uncaught exception:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[analyzer] unhandled rejection:', reason)
})

process.on('exit', () => {
  disposeParsers()
  db?.close()
})

/** Exposed for tests. */
export const __testing = { dispatch, overallFor, settingsOf, isRequest }
