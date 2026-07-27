import type { HealthStatus, SignalDef, SignalId } from './types'

/**
 * The signal registry.
 *
 * Fourteen measurements, each targeting a pathology that shows up in
 * agent-written repositories and that conventional tooling cannot see. A linter
 * reads one file at a time; every signal here reads the repository's *history*
 * or its *shape*, which is where vibecoded rot actually lives.
 *
 * Thresholds were calibrated against a real specimen: a 740-commit, 19-day,
 * single-author agent-built monorepo (4,227 files). Where that repo scored, the
 * observed value is quoted in the comment so the bands are auditable rather
 * than invented.
 *
 * INVARIANT: every signal is higherIsWorse and reported on a 0–100 scale unless
 * its unit says otherwise. Thresholds ascend.
 */
export const SIGNALS: Record<SignalId, SignalDef> = {
  accretion: {
    id: 'accretion',
    label: 'Accretion',
    measures: 'share of added lines that were never removed again',
    why: 'Agents add; they rarely delete. A codebase that only grows has stopped being edited and started being layered. This is the defining signature of slop, and no linter reports it.',
    unit: 'percent',
    precision: 1,
    // Specimen: 1,207,450 added vs 42,157 deleted → 96.5%.
    thresholds: { good: 60, warning: 75, serious: 88 },
    displayMax: 100,
    driverNoun: 'directory'
  },
  blastRadius: {
    id: 'blastRadius',
    label: 'Blast Radius',
    measures: '95th-percentile files touched per commit',
    why: 'A commit nobody could review is a commit nobody did review. Agent sessions produce sprawling multi-file dumps that hide real changes among mechanical ones.',
    unit: 'files',
    precision: 0,
    // Specimen: p50 4, p90 17, p99 164, max 2,098.
    thresholds: { good: 10, warning: 25, serious: 60 },
    displayMax: 120,
    driverNoun: 'commit'
  },
  siblingSprawl: {
    id: 'siblingSprawl',
    label: 'Sibling Sprawl',
    measures: 'share of files sitting in near-duplicate filename clusters',
    why: 'The signature agent failure: writing report-final.md, report-final-2.md, report-final-v3.md instead of editing one file. Each is valid on its own; together they are landfill.',
    unit: 'percent',
    precision: 1,
    // Specimen: docs/qa held 101 md files including four "…-final-…-reproof" variants
    // and ashgrove-p3/p4/p5/p6.
    thresholds: { good: 2, warning: 6, serious: 12 },
    displayMax: 30,
    driverNoun: 'cluster'
  },
  fileThrash: {
    id: 'fileThrash',
    label: 'File Thrash',
    measures: 'share of files ever created that were deleted outright',
    why: 'Work that was written and then thrown away. Renames are folded into their successor and never counted — moving a file is not abandoning it — so this measures genuine discard, not reorganisation.',
    unit: 'percent',
    precision: 1,
    // Specimen: 4,254 paths ever added, 1,252 of them renamed away, and only
    // 32 deleted outright → 0.8%. An earlier calibration read 15.2% by counting
    // renamed-away paths as abandoned; git's own --diff-filter=D disagrees, and
    // the low true figure reinforces rather than contradicts the accretion
    // finding: this repository essentially never deletes anything.
    thresholds: { good: 3, warning: 8, serious: 15 },
    displayMax: 30,
    driverNoun: 'file'
  },
  godFiles: {
    id: 'godFiles',
    label: 'God Files',
    measures: 'share of source lines living in files over 800 lines',
    why: 'Agents append rather than restructure, because appending always works and restructuring might break something. Files grow monotonically until they exceed what any reader — or any context window — can hold.',
    unit: 'percent',
    precision: 1,
    // Specimen: api.py 6,261 · schema.d.ts 5,983 · handlers.ts 4,169.
    thresholds: { good: 10, warning: 25, serious: 40 },
    displayMax: 80,
    driverNoun: 'file'
  },
  writeOnce: {
    id: 'writeOnce',
    label: 'Write-Once Code',
    measures: 'share of source files committed exactly once and never revisited',
    why: 'Code written in a single pass and never touched again is either finished or forgotten, and at scale it is mostly forgotten. This is where dead code hides when there are no TODOs to find it by.',
    unit: 'percent',
    precision: 1,
    // Specimen: 351 of 767 source files have exactly one commit → 45.8%.
    thresholds: { good: 15, warning: 30, serious: 45 },
    displayMax: 80,
    driverNoun: 'file'
  },
  rework: {
    id: 'rework',
    label: 'Rework Churn',
    measures: 'share of substantial files rewritten in place without converging',
    why: 'A file with as many deleted lines as added lines has been rewritten, not improved. Repeated in-place rewrites mean the agent is circling a problem it has not understood.',
    unit: 'percent',
    precision: 1,
    // Specimen: responses.new.tsx +2,449 / −2,424 — ~100% rewritten in place.
    thresholds: { good: 5, warning: 12, serious: 22 },
    displayMax: 40,
    driverNoun: 'file'
  },
  cadence: {
    id: 'cadence',
    label: 'Velocity Decay',
    measures: 'drop in recent commit rate against the trailing month',
    why: 'Vibecoded projects do not usually fail loudly; they stall. A decaying commit rate is the earliest measurable sign that the codebase has become harder to change than it is worth.',
    unit: 'percent',
    precision: 0,
    // Specimen: 80 commits/day peak on day 4 → 10–23/day by day 19, with a dead day.
    thresholds: { good: 20, warning: 40, serious: 60 },
    displayMax: 100,
    driverNoun: 'day'
  },
  commitHygiene: {
    id: 'commitHygiene',
    label: 'Commit Hygiene',
    measures: 'share of commits with unusable subjects',
    why: 'History is the only documentation that cannot drift. Subjects like "fix" or "update stuff" destroy the ability to bisect, review, or explain what happened — and convention adherence decays as a repo ages.',
    unit: 'percent',
    precision: 1,
    // Specimen: 342 of 740 commits conventional → 53.8% non-conforming.
    thresholds: { good: 15, warning: 35, serious: 55 },
    displayMax: 100,
    driverNoun: 'commit'
  },
  docBloat: {
    id: 'docBloat',
    label: 'Doc Bloat',
    measures: 'share of file changes landing on documentation rather than code',
    why: 'Agents write documentation to demonstrate progress. When docs churn harder than source, the project is producing narrative about work instead of work.',
    unit: 'percent',
    precision: 1,
    // Specimen: docs/qa/campaign.md was the single most-churned file in the repo
    // (68 commits) — above every source file. docs/TECH_DEBT.md ranked 8th.
    thresholds: { good: 15, warning: 30, serious: 45 },
    displayMax: 70,
    driverNoun: 'file'
  },
  testDeficit: {
    id: 'testDeficit',
    label: 'Test Deficit',
    measures: 'shortfall against a 0.4 test-to-source line ratio',
    why: 'Tests are the only thing standing between an agent and a silent regression. This signal is scored as a shortfall so that, like every other tile, lower is better — a well-tested repo reads as zero.',
    unit: 'percent',
    precision: 1,
    // Specimen scored well here: py 177 test / 267 src files, ts 146 / 177.
    // The panel must be able to say "this part is fine".
    thresholds: { good: 25, warning: 50, serious: 75 },
    displayMax: 100,
    driverNoun: 'directory'
  },
  complexityDrift: {
    id: 'complexityDrift',
    label: 'Complexity Drift',
    measures: 'share of functions above cyclomatic complexity 10',
    why: 'Generated code branches more than written code, because a model hedges where a human would decide. Complexity is measured from the parse tree, so it is exact rather than estimated from line counts.',
    unit: 'percent',
    precision: 1,
    thresholds: { good: 5, warning: 12, serious: 20 },
    displayMax: 40,
    driverNoun: 'function'
  },
  directorySprawl: {
    id: 'directorySprawl',
    label: 'Directory Sprawl',
    measures: 'share of directories holding fewer than three files',
    why: 'Agents create a folder per idea. The tree ends up deep, wide and almost empty, which makes everything harder to find and makes the project look larger than it is.',
    unit: 'percent',
    precision: 1,
    // Specimen: 862 directories for 4,227 files, max depth 8.
    thresholds: { good: 20, warning: 35, serious: 50 },
    displayMax: 80,
    driverNoun: 'directory'
  },
  unreviewedBulk: {
    id: 'unreviewedBulk',
    label: 'Unreviewed Bulk',
    measures: 'share of surviving source lines that arrived inside mega-commits',
    why: 'Not how much was dumped, but how much of it is still running. This is the fraction of your live codebase that entered in a commit too large for anyone to have actually read.',
    unit: 'percent',
    precision: 1,
    thresholds: { good: 15, warning: 35, serious: 55 },
    displayMax: 100,
    driverNoun: 'commit'
  }
}

/** Panel order. Grouped: history-shaped signals first, then shape-of-tree. */
export const SIGNAL_ORDER: readonly SignalId[] = [
  'accretion',
  'blastRadius',
  'unreviewedBulk',
  'siblingSprawl',
  'fileThrash',
  'rework',
  'godFiles',
  'writeOnce',
  'complexityDrift',
  'docBloat',
  'testDeficit',
  'commitHygiene',
  'cadence',
  'directorySprawl'
] as const

export function statusFor(id: SignalId, value: number): HealthStatus {
  const t = SIGNALS[id].thresholds
  if (value <= t.good) return 'good'
  if (value <= t.warning) return 'warning'
  if (value <= t.serious) return 'serious'
  return 'critical'
}

/** Formats a signal value for display. Pure, so both processes agree. */
export function formatSignal(id: SignalId, value: number): string {
  const def = SIGNALS[id]
  const n = Number.isFinite(value) ? value : 0
  const body = n.toFixed(def.precision)
  switch (def.unit) {
    case 'percent':
      return `${body}%`
    case 'files':
      return `${body}`
    case 'days':
      return `${body}d`
    case 'ratio':
      return `${body}×`
    default:
      return body
  }
}

/** Short unit suffix for axis and tile chrome. */
export function unitSuffix(id: SignalId): string {
  switch (SIGNALS[id].unit) {
    case 'percent':
      return '%'
    case 'files':
      return ' files'
    case 'days':
      return ' days'
    case 'lines':
      return ' lines'
    default:
      return ''
  }
}
