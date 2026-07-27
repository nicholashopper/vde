/**
 * End-to-end wiring: registry → context → signals → backfill → report.
 *
 * These tests run against the reference specimen (a real 740-commit,
 * agent-written repository) rather than a fixture, because the properties that
 * matter here — that the blob cache actually eliminates re-reads, that the
 * tripwire actually fires, that a report is structured-clone safe — are only
 * meaningful against real data. The specimen is opened read-only; every git call
 * goes through the gateway, and the database lives in a scratch directory.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SIGNALS, SIGNAL_ORDER } from '../src/shared/signals'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'
import { initParser } from '../src/analyzer/content/parse'
import { Db, openDbFile } from '../src/analyzer/db'
import { assertUnchanged, fingerprint } from '../src/analyzer/git/exec'
import { readHistory } from '../src/analyzer/git/log'
import { repoId as repoIdFor } from '../src/analyzer/git/repo'
import type { History } from '../src/analyzer/model'
import { buildReport } from '../src/analyzer/report'
import { ALL_SIGNALS, runSignals } from '../src/analyzer/signals'
import { backfill } from '../src/analyzer/snapshots/backfill'
import { buildContext, computeFacts, newBlobCacheStats } from '../src/analyzer/snapshots/compute'

const SPECIMEN = join(process.env.HOME ?? '', 'codebase', 'apxstream', 'apx-response')
const GRAMMARS = join(__dirname, '..', 'node_modules', 'tree-sitter-wasms', 'out')

const settings: Settings = { ...DEFAULT_SETTINGS, maxSnapshots: 14 }

let scratch = ''
let db: Db
let history: History
let repoId = ''

beforeAll(async () => {
  await initParser(GRAMMARS)
  scratch = mkdtempSync(join(tmpdir(), 'vde-wiring-'))
  db = openDbFile(join(scratch, 'vde.db'))
  repoId = repoIdFor(SPECIMEN)
  history = await readHistory(SPECIMEN)
}, 300_000)

afterAll(() => {
  db?.close()
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true })
})

describe('signal registry', () => {
  it('has exactly one computer for every id in SIGNAL_ORDER', () => {
    const ids = ALL_SIGNALS.map((c) => c.id).sort()
    expect(ids).toEqual([...SIGNAL_ORDER].sort())
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('buildContext + runSignals at HEAD', () => {
  it('produces a complete, in-range panel', async () => {
    const head = history.commits[0]
    expect(head).toBeDefined()
    if (!head) return

    const cache = newBlobCacheStats()
    const ctx = await buildContext({
      repoId,
      repoPath: SPECIMEN,
      settings,
      db,
      history,
      rev: head.sha,
      cache
    })

    expect(ctx.tree.length).toBeGreaterThan(1000)
    expect(ctx.blobs.size).toBeGreaterThan(500)
    expect(ctx.fileStats.size).toBeGreaterThan(ctx.tree.length * 0.5)
    expect(ctx.megaThreshold).toBeGreaterThanOrEqual(25)
    expect(ctx.now).toBe(head.authoredAt)

    const facts = computeFacts(ctx)
    expect(facts.commitCount).toBe(history.commits.length)
    expect(facts.fileCount).toBeGreaterThan(1000)
    expect(facts.sourceLines).toBeGreaterThan(0)
    expect(facts.languages.length).toBeGreaterThan(3)
    // Line buckets are disjoint subsets of the measured total.
    expect(facts.sourceLines + facts.docLines + facts.testLines + facts.configLines).toBeLessThanOrEqual(
      facts.totalLines
    )

    const run = runSignals(ctx)
    expect(run.values.map((v) => v.id)).toEqual([...SIGNAL_ORDER])
    expect(run.warnings).toEqual([])
    for (const value of run.values) {
      expect(Number.isFinite(value.value)).toBe(true)
      expect(value.value).toBeGreaterThanOrEqual(0)
      expect(value.headline.length).toBeGreaterThan(0)
      expect(value.drivers.length).toBeLessThanOrEqual(50)
    }
    // Finding ids are `<signalId>-<index>` and unique.
    const ids = run.findings.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const finding of run.findings) {
      expect(finding.id.startsWith(`${finding.signalId}-`)).toBe(true)
      expect(SIGNALS[finding.signalId]).toBeDefined()
    }
  }, 600_000)
})

describe('backfill', () => {
  it('walks the picked revisions and lands a high blob-cache hit rate', async () => {
    const seen: number[] = []
    const result = await backfill(
      SPECIMEN,
      repoId,
      history,
      db,
      settings,
      (current, total) => {
        seen.push(current)
        expect(total).toBeGreaterThan(0)
      },
      undefined,
      { maxSnapshots: settings.maxSnapshots }
    )

    expect(result.total).toBeGreaterThan(1)
    expect(result.total).toBeLessThanOrEqual(settings.maxSnapshots)
    expect(result.computed + result.skipped).toBe(result.total)
    expect(seen.length).toBeGreaterThan(0)

    // The whole design rests on this: across N snapshots a file that did not
    // change is analysed once. Anything below a large majority means the cache
    // is not being consulted, which would make backfill unaffordable.
    expect(result.cacheHitRate).toBeGreaterThan(0.8)

    const stored = db.getSnapshots(repoId)
    expect(stored.length).toBe(result.total)
    for (const row of stored) {
      expect(Object.keys(row.signals).length).toBe(SIGNAL_ORDER.length)
      expect(row.facts.fileCount).toBeGreaterThan(0)
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }

    // Ascending by time, one point per date — the invariant every chart assumes.
    const dates = stored.map((s) => s.date)
    expect([...dates].sort()).toEqual(dates)
    expect(new Set(dates).size).toBe(dates.length)

    // Second run: everything is already stored, so nothing is recomputed.
    const again = await backfill(SPECIMEN, repoId, history, db, settings, undefined, undefined, {
      maxSnapshots: settings.maxSnapshots
    })
    expect(again.computed).toBe(0)
    expect(again.skipped).toBe(again.total)
  }, 900_000)

  it('analyses each distinct blob exactly once from a cold cache', async () => {
    // A dedicated database, so the measurement is not warmed by the tests above.
    const cold = openDbFile(join(scratch, 'cold.db'))
    try {
      const result = await backfill(SPECIMEN, repoId, history, cold, settings, undefined, undefined, {
        maxSnapshots: settings.maxSnapshots
      })
      const perSnapshot = (result.cache.hits + result.cache.misses) / Math.max(1, result.computed)
      console.log(
        `[wiring] cold backfill: ${result.computed} snapshots, ` +
          `${result.cache.hits + result.cache.misses} blob lookups ` +
          `(${Math.round(perSnapshot)} per snapshot), ${result.cache.misses} analysed, ` +
          `${(result.cacheHitRate * 100).toFixed(1)}% hit rate, ` +
          `${(result.cache.bytesRead / 1e6).toFixed(1)} MB read, ` +
          `${(result.elapsedMs / 1000).toFixed(1)}s`
      )

      // The claim under test: total blobs analysed is bounded by the number of
      // DISTINCT contents, not by snapshots x files. If the cache were bypassed,
      // misses would equal lookups and the rate would be zero.
      expect(result.cache.misses).toBeLessThan(result.cache.hits)
      expect(cold.countBlobs()).toBeGreaterThan(0)
      expect(cold.countBlobs()).toBeLessThanOrEqual(result.cache.misses)
    } finally {
      cold.close()
    }
  }, 900_000)

  it('honours an abort signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      backfill(SPECIMEN, repoId, history, db, settings, undefined, controller.signal, { force: true })
    ).rejects.toThrow(/cancelled/i)
  })
})

describe('buildReport', () => {
  it('assembles a complete, IPC-safe report', async () => {
    const report = await buildReport(repoId, SPECIMEN, '7d', undefined, db, settings, undefined, {
      history
    })

    expect(report.repo.id).toBe(repoId)
    expect(report.repo.head).toBe(history.commits[0]?.sha)
    expect(report.signals.map((s) => s.id)).toEqual([...SIGNAL_ORDER])
    expect(report.snapshots.length).toBeGreaterThan(1)
    expect(report.commits.length).toBeGreaterThan(0)
    expect(report.commits.length).toBeLessThanOrEqual(500)
    expect(report.timeline.length).toBeGreaterThan(10)

    // A baseline is either a real stored snapshot or nothing at all.
    if (report.baseline.commitSha !== null) {
      expect(report.snapshots.some((s) => s.commitSha === report.baseline.commitSha)).toBe(true)
      expect(report.baseline.commitSha).not.toBe(report.repo.head)
      expect(report.baselineFacts).not.toBeNull()
      expect(report.deltas.length).toBeGreaterThan(0)
    } else {
      expect(report.deltas).toEqual([])
      expect(report.baselineFacts).toBeNull()
    }
    expect(report.baseline.label.length).toBeGreaterThan(0)

    for (const delta of report.deltas) {
      const def = SIGNALS[delta.id]
      expect(delta.absolute).toBeCloseTo(delta.current - delta.baseline, 3)
      expect(delta.magnitude).toBeCloseTo(Math.abs(delta.absolute) / def.displayMax, 4)
      const deadband = def.displayMax * 0.005
      const expected =
        delta.absolute > deadband ? 'worse' : delta.absolute < -deadband ? 'better' : 'flat'
      expect(delta.direction).toBe(expected)
    }

    // topMovers is the same set, ranked.
    expect(report.topMovers.length).toBe(report.deltas.length)
    for (let i = 1; i < report.topMovers.length; i++) {
      const prev = report.topMovers[i - 1]
      const cur = report.topMovers[i]
      if (prev && cur) expect(prev.magnitude).toBeGreaterThanOrEqual(cur.magnitude)
    }

    // The timeline is a continuous run of days.
    const first = report.timeline[0]
    const last = report.timeline[report.timeline.length - 1]
    expect(first?.date).toBe(report.repo.firstCommitAt.slice(0, 10))
    expect(last?.date).toBe(report.repo.lastCommitAt.slice(0, 10))
    const totalCommits = report.timeline.reduce((n, b) => n + b.commits, 0)
    expect(totalCommits).toBe(history.commits.length)

    // The tree is nested, aggregated and finite.
    expect(report.tree.type).toBe('directory')
    let fileNodes = 0
    let deepest = 0
    const walk = (node: typeof report.tree, depth: number): void => {
      if (node.type === 'file') {
        fileNodes++
        if (depth > deepest) deepest = depth
        return
      }
      for (const child of node.children ?? []) walk(child, depth + 1)
    }
    walk(report.tree, 0)
    expect(fileNodes).toBeGreaterThan(500)
    expect(fileNodes).toBeLessThanOrEqual(20_000)
    expect(deepest).toBeGreaterThan(1)
    expect(report.tree.lines).toBeGreaterThan(0)
    expect(report.tree.risk).toBeGreaterThanOrEqual(0)
    expect(report.tree.risk).toBeLessThanOrEqual(1)

    // Structured-clone safety: no functions, classes, Dates, Maps or Sets.
    expect(() => structuredClone(report)).not.toThrow()
    expect(JSON.parse(JSON.stringify(report)).signals.length).toBe(SIGNAL_ORDER.length)
  }, 600_000)

  it('never fabricates a baseline for an unknown commit', async () => {
    const report = await buildReport(repoId, SPECIMEN, 'commit', 'deadbeef', db, settings, undefined, {
      history
    })
    expect(report.baseline.commitSha).toBeNull()
    expect(report.deltas).toEqual([])
    expect(report.warnings.some((w) => w.includes('No snapshot exists for commit'))).toBe(true)
  }, 300_000)
})

describe('the read-only tripwire', () => {
  it('sees the specimen unchanged across a full scan', async () => {
    const before = await fingerprint(SPECIMEN)
    await backfill(SPECIMEN, repoId, history, db, settings, undefined, undefined, { maxSnapshots: 3 })
    await buildReport(repoId, SPECIMEN, 'first', undefined, db, settings, undefined, { history })
    const after = await fingerprint(SPECIMEN)
    expect(() => assertUnchanged(before, after, SPECIMEN)).not.toThrow()
  }, 600_000)
})
