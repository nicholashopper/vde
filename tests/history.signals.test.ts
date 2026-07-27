import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'

import {
  accretionSignal,
  blastRadiusSignal,
  cadenceSignal,
  commitHygieneSignal,
  fileThrashSignal,
  historySignals,
  reworkSignal,
  unreviewedBulkSignal
} from '../src/analyzer/signals/history'
import type { AnalysisContext, CommitRecord, FileChange, FileKind, FileStats } from '../src/analyzer/model'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { buildContext } from './history.harness'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)

// ---------------------------------------------------------------------------
// Synthetic context helpers
// ---------------------------------------------------------------------------

function change(path: string, ins: number, del: number, oldPath?: string): FileChange {
  const c: FileChange = { path, status: oldPath ? 'R' : 'M', insertions: ins, deletions: del, binary: false }
  if (oldPath !== undefined) c.oldPath = oldPath
  return c
}

let shaCounter = 0
function commit(opts: {
  at: number
  subject?: string
  files?: FileChange[]
  merge?: boolean
  sha?: string
}): CommitRecord {
  shaCounter++
  const sha = opts.sha ?? `${shaCounter}`.padStart(40, 'a')
  return {
    sha,
    parents: opts.merge ? ['p1', 'p2'] : ['p1'],
    authorName: 'Agent',
    authorEmail: 'agent@example.com',
    authoredAt: opts.at,
    committedAt: opts.at,
    subject: opts.subject ?? 'feat(core): a perfectly reasonable subject line',
    files: opts.files ?? [],
    isMerge: opts.merge === true
  }
}

function fileStats(partial: Partial<FileStats> & { path: string }): FileStats {
  return {
    commits: 1,
    authors: new Set(['agent@example.com']),
    firstAt: T0,
    lastAt: T0,
    added: 0,
    deleted: 0,
    alive: true,
    formerPaths: [],
    touchedBy: [],
    ...partial
  }
}

function ctxOf(partial: Partial<AnalysisContext>): AnalysisContext {
  const commits = partial.history?.commits ?? []
  const times = commits.map((c) => c.authoredAt)
  return {
    repoId: 'test',
    repoPath: '/tmp/test',
    settings: DEFAULT_SETTINGS,
    headSha: commits[0]?.sha ?? '',
    now: times.length > 0 ? Math.max(...times) : T0,
    history: {
      commits,
      firstAt: times.length > 0 ? Math.min(...times) : T0,
      lastAt: times.length > 0 ? Math.max(...times) : T0,
      authors: new Map([['agent@example.com', 'Agent']])
    },
    window: commits.filter((c) => !c.isMerge),
    windowDays: 90,
    tree: [],
    blobs: new Map(),
    kinds: new Map<string, FileKind>(),
    fileStats: new Map<string, FileStats>(),
    dirFileCounts: new Map(),
    clusters: [],
    megaThreshold: 25,
    ...partial
  }
}

// ---------------------------------------------------------------------------
// 1. accretion
// ---------------------------------------------------------------------------

describe('accretion', () => {
  it('is 100 - deleted/added as a percentage', () => {
    const commits = [
      commit({ at: T0, files: [change('src/a.ts', 1000, 100)] }),
      commit({ at: T0 - DAY, files: [change('src/b.ts', 1000, 0)] })
    ]
    const r = accretionSignal.compute(ctxOf({ history: { commits, firstAt: T0 - DAY, lastAt: T0, authors: new Map() } }))
    expect(r.value).toBeCloseTo(95, 6) // 100 * (1 - 100/2000)
    expect(r.headline).toContain('1 line removed for every 20 added')
  })

  it('is 0 when nothing was added', () => {
    const r = accretionSignal.compute(ctxOf({}))
    expect(r.value).toBe(0)
  })

  it('clamps when more was deleted than added', () => {
    const commits = [commit({ at: T0, files: [change('src/a.ts', 10, 900)] })]
    const r = accretionSignal.compute(ctxOf({ history: { commits, firstAt: T0, lastAt: T0, authors: new Map() } }))
    expect(r.value).toBe(0)
  })

  it('ignores directories under the 200-line floor', () => {
    const commits = [
      commit({
        at: T0,
        files: [change('big/a.ts', 5000, 500), change('tiny/b.ts', 40, 0)]
      })
    ]
    const r = accretionSignal.compute(ctxOf({ history: { commits, firstAt: T0, lastAt: T0, authors: new Map() } }))
    expect(r.drivers.map((d) => d.path)).toEqual(['big'])
  })

  it('excludes merge commits', () => {
    const commits = [
      commit({ at: T0, files: [change('src/a.ts', 100, 50)] }),
      commit({ at: T0, merge: true, files: [change('src/a.ts', 100, 50)] })
    ]
    const ctx = ctxOf({ history: { commits, firstAt: T0, lastAt: T0, authors: new Map() } })
    ctx.window = commits // deliberately including the merge, to prove it is filtered
    const r = accretionSignal.compute(ctx)
    expect(r.value).toBeCloseTo(50, 6)
  })
})

// ---------------------------------------------------------------------------
// 2. blastRadius
// ---------------------------------------------------------------------------

describe('blastRadius', () => {
  it('takes the nearest-rank p95', () => {
    // 100 commits: 95 touching 1 file, 5 touching 200. Nearest-rank p95 is the
    // 95th of 100 sorted ascending → still 1.
    const commits: CommitRecord[] = []
    for (let i = 0; i < 95; i++) commits.push(commit({ at: T0 - i * 1000, files: [change('a.ts', 1, 0)] }))
    for (let i = 0; i < 5; i++) {
      const files = Array.from({ length: 200 }, (_, k) => change(`f${k}.ts`, 1, 0))
      commits.push(commit({ at: T0 - (100 + i) * 1000, files }))
    }
    const r = blastRadiusSignal.compute(
      ctxOf({ history: { commits, firstAt: T0 - 200_000, lastAt: T0, authors: new Map() } })
    )
    expect(r.value).toBe(1)
    expect(r.drivers[0]?.value).toBe(200)
  })

  it('reports p95 for a simple ladder', () => {
    const commits = Array.from({ length: 20 }, (_, i) =>
      commit({ at: T0 - i * 1000, files: Array.from({ length: i + 1 }, (_, k) => change(`f${k}.ts`, 1, 0)) })
    )
    const r = blastRadiusSignal.compute(
      ctxOf({ history: { commits, firstAt: T0 - 20_000, lastAt: T0, authors: new Map() } })
    )
    // sizes 1..20, ceil(0.95*20) = 19 → 19th smallest = 19
    expect(r.value).toBe(19)
  })

  it('raises a finding for commits above 10x the median', () => {
    const commits: CommitRecord[] = []
    for (let i = 0; i < 20; i++) commits.push(commit({ at: T0 - i * 1000, files: [change('a.ts', 1, 0), change('b.ts', 1, 0)] }))
    commits.push(
      commit({
        at: T0 - 99_000,
        subject: 'chore(repo): the dump',
        files: Array.from({ length: 300 }, (_, k) => change(`x${k}.ts`, 1, 0))
      })
    )
    const r = blastRadiusSignal.compute(
      ctxOf({ history: { commits, firstAt: T0 - 200_000, lastAt: T0, authors: new Map() } })
    )
    expect(r.findings?.length).toBe(1)
    expect(r.findings?.[0]?.metric.value).toBe(300)
  })

  it('is 0 for an empty window', () => {
    const r = blastRadiusSignal.compute(ctxOf({}))
    expect(r.value).toBe(0)
    expect(r.drivers).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. unreviewedBulk
// ---------------------------------------------------------------------------

describe('unreviewedBulk', () => {
  it('attributes surviving lines proportionally to mega-commit added lines', () => {
    // one live file of 1,000 lines; 3,000 lines added over its life, 900 of them
    // in a mega-commit → 30% of its surviving lines counted as unreviewed.
    const mega = commit({
      at: T0 - 2 * DAY,
      subject: 'feat(all): the big bang',
      files: [change('src/a.ts', 900, 0), ...Array.from({ length: 40 }, (_, k) => change(`src/pad${k}.ts`, 1, 0))]
    })
    const small = commit({ at: T0, files: [change('src/a.ts', 2100, 0)] })
    const ctx = ctxOf({
      history: { commits: [small, mega], firstAt: T0 - 2 * DAY, lastAt: T0, authors: new Map() },
      tree: [{ path: 'src/a.ts', sha: 'blob1', size: 100, mode: '100644' }],
      blobs: new Map([
        [
          'blob1',
          {
            sha: 'blob1',
            bytes: 100,
            lines: 1000,
            codeLines: null,
            language: null,
            binary: false,
            functions: null,
            totalComplexity: null,
            maxComplexity: null,
            complexFunctions: null,
            simhash: null
          }
        ]
      ]),
      kinds: new Map<string, FileKind>([['src/a.ts', 'source']]),
      megaThreshold: 25
    })
    const r = unreviewedBulkSignal.compute(ctx)
    expect(r.value).toBeCloseTo(30, 6)
    expect(r.drivers[0]?.sha).toBe(mega.sha)
    expect(r.drivers[0]?.value).toBe(300)
  })

  it('follows renames when attributing', () => {
    const mega = commit({
      at: T0 - 2 * DAY,
      files: [change('src/old.ts', 500, 0), ...Array.from({ length: 40 }, (_, k) => change(`src/pad${k}.ts`, 1, 0))]
    })
    const renamed = commit({ at: T0, files: [change('src/new.ts', 0, 0, 'src/old.ts')] })
    const ctx = ctxOf({
      history: { commits: [renamed, mega], firstAt: T0 - 2 * DAY, lastAt: T0, authors: new Map() },
      tree: [{ path: 'src/new.ts', sha: 'b', size: 10, mode: '100644' }],
      blobs: new Map([
        [
          'b',
          {
            sha: 'b',
            bytes: 10,
            lines: 500,
            codeLines: null,
            language: null,
            binary: false,
            functions: null,
            totalComplexity: null,
            maxComplexity: null,
            complexFunctions: null,
            simhash: null
          }
        ]
      ]),
      kinds: new Map<string, FileKind>([['src/new.ts', 'source']]),
      fileStats: new Map([
        ['src/new.ts', fileStats({ path: 'src/new.ts', formerPaths: ['src/old.ts'], added: 500 })],
        ['src/old.ts', fileStats({ path: 'src/old.ts', alive: false })]
      ])
    })
    const r = unreviewedBulkSignal.compute(ctx)
    expect(r.value).toBeCloseTo(100, 6)
  })

  it('is 0 when there are no live source lines', () => {
    expect(unreviewedBulkSignal.compute(ctxOf({})).value).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. fileThrash
// ---------------------------------------------------------------------------

describe('fileThrash', () => {
  it('counts dead files over ever-created', () => {
    const ctx = ctxOf({
      fileStats: new Map([
        ['a.ts', fileStats({ path: 'a.ts', alive: true })],
        ['b.ts', fileStats({ path: 'b.ts', alive: false, added: 10 })],
        ['c.ts', fileStats({ path: 'c.ts', alive: true })],
        ['d.ts', fileStats({ path: 'd.ts', alive: false, added: 10 })]
      ])
    })
    expect(fileThrashSignal.compute(ctx).value).toBe(50)
  })

  it('does not count a renamed-away path as thrash', () => {
    const ctx = ctxOf({
      fileStats: new Map([
        ['new.ts', fileStats({ path: 'new.ts', alive: true, formerPaths: ['old.ts'] })],
        ['old.ts', fileStats({ path: 'old.ts', alive: false, added: 10 })],
        ['keep.ts', fileStats({ path: 'keep.ts', alive: true })]
      ])
    })
    const r = fileThrashSignal.compute(ctx)
    expect(r.value).toBe(0)
    expect(r.headline).toContain('0 of 2 files ever created')
  })

  it('folds a multi-hop rename chain into one file', () => {
    const ctx = ctxOf({
      fileStats: new Map([
        ['c.ts', fileStats({ path: 'c.ts', alive: true, formerPaths: ['b.ts', 'a.ts'] })],
        ['b.ts', fileStats({ path: 'b.ts', alive: false, formerPaths: ['a.ts'] })],
        ['a.ts', fileStats({ path: 'a.ts', alive: false })]
      ])
    })
    const r = fileThrashSignal.compute(ctx)
    expect(r.value).toBe(0)
    expect(r.headline).toContain('0 of 1 files ever created')
  })

  it('does not fold a path that was vacated and then recreated', () => {
    // `a.ts` was renamed to `b.ts`, and a new `a.ts` exists today. Two files.
    const ctx = ctxOf({
      fileStats: new Map([
        ['b.ts', fileStats({ path: 'b.ts', alive: false, formerPaths: ['a.ts'], added: 10 })],
        ['a.ts', fileStats({ path: 'a.ts', alive: true })]
      ])
    })
    const r = fileThrashSignal.compute(ctx)
    expect(r.value).toBe(50)
  })

  it('ranks the shortest-lived files first', () => {
    const ctx = ctxOf({
      fileStats: new Map([
        ['slow.ts', fileStats({ path: 'slow.ts', alive: false, added: 100, firstAt: T0, lastAt: T0 + 10 * DAY })],
        ['fast.ts', fileStats({ path: 'fast.ts', alive: false, added: 100, firstAt: T0, lastAt: T0 + HOURS(2) })]
      ])
    })
    const r = fileThrashSignal.compute(ctx)
    expect(r.drivers[0]?.path).toBe('fast.ts')
    expect(r.drivers[0]?.value).toBeCloseTo(2, 6)
  })
})

function HOURS(n: number): number {
  return n * 3_600_000
}

// ---------------------------------------------------------------------------
// 5. rework
// ---------------------------------------------------------------------------

describe('rework', () => {
  it('is the share of substantial live source files with deleted/added >= 0.5', () => {
    const ctx = ctxOf({
      kinds: new Map<string, FileKind>([
        ['a.ts', 'source'],
        ['b.ts', 'source'],
        ['c.ts', 'source'],
        ['d.ts', 'source']
      ]),
      fileStats: new Map([
        ['a.ts', fileStats({ path: 'a.ts', added: 2449, deleted: 2424 })],
        ['b.ts', fileStats({ path: 'b.ts', added: 500, deleted: 250 })],
        ['c.ts', fileStats({ path: 'c.ts', added: 500, deleted: 10 })],
        ['d.ts', fileStats({ path: 'd.ts', added: 199, deleted: 199 })] // below the floor
      ])
    })
    const r = reworkSignal.compute(ctx)
    expect(r.value).toBeCloseTo((2 / 3) * 100, 6)
    expect(r.drivers.map((d) => d.path)).toEqual(['a.ts', 'b.ts'])
    expect(r.drivers[0]?.label).toContain('+2,449 / -2,424')
  })

  it('ignores non-source and dead files', () => {
    const ctx = ctxOf({
      kinds: new Map<string, FileKind>([
        ['docs/x.md', 'doc'],
        ['dead.ts', 'source']
      ]),
      fileStats: new Map([
        ['docs/x.md', fileStats({ path: 'docs/x.md', added: 900, deleted: 900 })],
        ['dead.ts', fileStats({ path: 'dead.ts', added: 900, deleted: 900, alive: false })]
      ])
    })
    expect(reworkSignal.compute(ctx).value).toBe(0)
  })

  it('is 0 when nothing is substantial', () => {
    expect(reworkSignal.compute(ctxOf({})).value).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. cadence
// ---------------------------------------------------------------------------

describe('cadence', () => {
  function repoOver(days: number, ratePerDay: (dayIndex: number) => number): CommitRecord[] {
    const commits: CommitRecord[] = []
    const now = T0
    for (let d = 0; d < days; d++) {
      const n = ratePerDay(d)
      for (let k = 0; k < n; k++) {
        commits.push(commit({ at: now - d * DAY - k * 60_000 }))
      }
    }
    return commits
  }

  it('is 0 while accelerating', () => {
    // 10/day in the last week, 2/day before it.
    const commits = repoOver(60, (d) => (d < 7 ? 10 : 2))
    const r = cadenceSignal.compute(
      ctxOf({ history: { commits, firstAt: T0 - 60 * DAY, lastAt: T0, authors: new Map() } })
    )
    expect(r.value).toBe(0)
    expect(r.headline).toContain('no decay')
  })

  it('measures the drop against the preceding 28 days', () => {
    const commits = repoOver(60, (d) => (d < 7 ? 2 : 8))
    const r = cadenceSignal.compute(
      ctxOf({ history: { commits, firstAt: T0 - 60 * DAY, lastAt: T0, authors: new Map() } })
    )
    expect(r.value).toBeCloseTo(75, 0) // 2/day against 8/day
  })

  it('is 100 with no commits in the recent window', () => {
    const commits = repoOver(60, (d) => (d < 8 ? 0 : 8))
    const ctx = ctxOf({ history: { commits, firstAt: T0 - 60 * DAY, lastAt: T0 - 8 * DAY, authors: new Map() } })
    ctx.now = T0
    const r = cadenceSignal.compute(ctx)
    expect(r.value).toBe(100)
    expect(r.headline).toContain('the work has stopped')
  })

  it('scales its windows for a repo younger than 35 days and says so', () => {
    const commits = repoOver(14, (d) => (d < 3 ? 1 : 20))
    const ctx = ctxOf({ history: { commits, firstAt: T0 - 14 * DAY, lastAt: T0, authors: new Map() } })
    ctx.now = T0
    const r = cadenceSignal.compute(ctx)
    expect(r.headline).toContain('windows scaled')
    expect(r.value).toBeGreaterThan(50)
  })

  it('reports multi-day gaps as drivers', () => {
    const commits = repoOver(40, (d) => (d >= 10 && d <= 13 ? 0 : 5))
    const ctx = ctxOf({ history: { commits, firstAt: T0 - 40 * DAY, lastAt: T0, authors: new Map() } })
    ctx.now = T0
    const r = cadenceSignal.compute(ctx)
    expect(r.drivers.some((d) => d.label.includes('days with no commits'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. commitHygiene
// ---------------------------------------------------------------------------

describe('commitHygiene', () => {
  function withSubjects(subjects: string[]): AnalysisContext {
    const commits = subjects.map((s, i) => commit({ at: T0 - i * 3600_000, subject: s }))
    return ctxOf({ history: { commits, firstAt: T0 - subjects.length * 3600_000, lastAt: T0, authors: new Map() } })
  }

  it('flags short, long and lazy subjects', () => {
    const r = commitHygieneSignal.compute(
      withSubjects([
        'fix',
        'wip on the thing that broke earlier today',
        'update stuff and other bits of the system',
        `x${'y'.repeat(120)}`,
        'Rewrite the upload retry logic so timeouts back off'
      ])
    )
    expect(r.value).toBeCloseTo(80, 6)
    expect(r.drivers.length).toBe(4)
  })

  it('does not punish a well-formed conventional fix:', () => {
    const subjects = [
      'fix(upload): back off on gateway timeouts instead of retrying hot',
      'feat(api): expose the response identifier on the list endpoint',
      'refactor(core): split the scheduler out of the worker loop',
      'docs(readme): describe the local development bootstrap'
    ]
    const r = commitHygieneSignal.compute(withSubjects(subjects))
    expect(r.value).toBe(0)
  })

  it('flags a conventional prefix with a trivial body', () => {
    const r = commitHygieneSignal.compute(
      withSubjects([
        'refactor(core): refactor',
        'fix(upload): back off on gateway timeouts instead of retrying hot',
        'feat(api): expose the response identifier on the list endpoint'
      ])
    )
    expect(r.drivers[0]?.detail).toContain('nothing after it')
    expect(r.value).toBeCloseTo(100 / 3, 6)
  })

  it('only penalises non-conventional subjects once a convention is established', () => {
    // 1 conventional in 5 = 20% → no convention, so plain subjects are fine.
    const loose = commitHygieneSignal.compute(
      withSubjects([
        'feat(api): expose the response identifier on the list endpoint',
        'Rewrite the upload retry logic so timeouts back off',
        'Teach the scheduler about weekend maintenance windows',
        'Remove the last of the synchronous database calls',
        'Give the queue page a description of what it is showing'
      ])
    )
    expect(loose.value).toBe(0)
    expect(loose.headline).toContain('no convention is enforced')

    // 3 conventional in 5 = 60% → convention established, the other two count.
    const drifting = commitHygieneSignal.compute(
      withSubjects([
        'feat(api): expose the response identifier on the list endpoint',
        'fix(upload): back off on gateway timeouts instead of retrying hot',
        'refactor(core): split the scheduler out of the worker loop',
        'Teach the scheduler about weekend maintenance windows',
        'Remove the last of the synchronous database calls'
      ])
    )
    expect(drifting.value).toBeCloseTo(40, 6)
    expect(drifting.drivers.every((d) => (d.detail ?? '').includes('convention'))).toBe(true)
  })

  it('ignores merge commits', () => {
    const commits = [
      commit({ at: T0, subject: 'wip', merge: true }),
      commit({ at: T0 - 1000, subject: 'Rewrite the upload retry logic so timeouts back off' })
    ]
    const ctx = ctxOf({ history: { commits, firstAt: T0 - 1000, lastAt: T0, authors: new Map() } })
    ctx.window = commits
    expect(commitHygieneSignal.compute(ctx).value).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('historySignals', () => {
  it('exports all seven, each with a distinct id', () => {
    expect(historySignals.length).toBe(7)
    expect(new Set(historySignals.map((s) => s.id)).size).toBe(7)
  })

  it('every computer survives an empty repository', () => {
    const ctx = ctxOf({})
    for (const s of historySignals) {
      const r = s.compute(ctx)
      expect(Number.isFinite(r.value)).toBe(true)
      expect(r.value).toBeGreaterThanOrEqual(0)
      expect(r.headline.length).toBeGreaterThan(0)
      expect(r.drivers.length).toBeLessThanOrEqual(50)
    }
  })
})

// ---------------------------------------------------------------------------
// Calibration against the reference specimen
// ---------------------------------------------------------------------------

const SPECIMEN = '/Users/nicholashopper/codebase/apxstream/apx-response'

describe.runIf(existsSync(SPECIMEN))('calibration: apx-response', () => {
  it(
    'reports the seven values',
    async () => {
      const ctx = await buildContext(SPECIMEN)

      const rows: string[] = []
      for (const s of historySignals) {
        const r = s.compute(ctx)
        rows.push(
          `\n${s.id.toUpperCase()}  value=${r.value.toFixed(2)}\n` +
            `  headline: ${r.headline}\n` +
            `  drivers(${r.drivers.length}): ` +
            r.drivers
              .slice(0, 5)
              .map((d) => `\n    [${d.value.toFixed(1)}] ${d.label}${d.detail ? `  — ${d.detail}` : ''}`)
              .join('') +
            `\n  findings: ${(r.findings ?? []).length}` +
            (r.findings ?? []).map((f) => `\n    * ${f.title}`).join('')
        )
      }

      // Context facts, so the numbers below can be audited.
      const nonMerge = ctx.history.commits.filter((c) => !c.isMerge)
      let added = 0
      let deleted = 0
      for (const c of ctx.window) for (const f of c.files) (added += f.insertions), (deleted += f.deletions)

      // Raw (un-folded) file thrash, for comparison with the folded figure.
      let rawEver = 0
      let rawGone = 0
      for (const s of ctx.fileStats.values()) {
        rawEver++
        if (!s.alive) rawGone++
      }

      const conv = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^()\r\n]{1,64}\))?!?: .+$/
      let conventional = 0
      for (const c of nonMerge) if (conv.test(c.subject.trim())) conventional++
      let conventionalAll = 0
      for (const c of ctx.history.commits) if (conv.test(c.subject.trim())) conventionalAll++

      const sizes = nonMerge.map((c) => c.files.length).sort((a, b) => a - b)
      const at = (p: number): number => sizes[Math.min(sizes.length - 1, Math.ceil((p / 100) * sizes.length) - 1)] ?? 0

      console.log(
        [
          '',
          '================ CONTEXT ================',
          `commits: ${ctx.history.commits.length} (non-merge ${nonMerge.length}), window ${ctx.window.length} over ${ctx.windowDays}d`,
          `age: ${((ctx.now - ctx.history.firstAt) / DAY).toFixed(1)} days`,
          `window added ${added.toLocaleString('en-US')} / deleted ${deleted.toLocaleString('en-US')}`,
          `tree files ${ctx.tree.length}, paths ever seen ${ctx.fileStats.size}`,
          `megaThreshold ${ctx.megaThreshold} (p90=${at(90)})`,
          `p50=${at(50)} p90=${at(90)} p95=${at(95)} p99=${at(99)} max=${sizes[sizes.length - 1]}`,
          `RAW file thrash (no rename folding): ${rawGone} of ${rawEver} = ${((100 * rawGone) / rawEver).toFixed(2)}%`,
          `conventional: ${conventional}/${nonMerge.length} non-merge = ${((100 * conventional) / nonMerge.length).toFixed(1)}%`,
          `conventional: ${conventionalAll}/${ctx.history.commits.length} all = ${((100 * conventionalAll) / ctx.history.commits.length).toFixed(1)}%`,
          '================ SIGNALS ================',
          ...rows,
          ''
        ].join('\n')
      )

      for (const s of historySignals) {
        const r = s.compute(ctx)
        expect(Number.isFinite(r.value)).toBe(true)
        expect(r.drivers.length).toBeLessThanOrEqual(50)
        for (const d of r.drivers) expect(Number.isFinite(d.value)).toBe(true)
      }
    },
    600_000
  )
})
