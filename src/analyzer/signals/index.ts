/**
 * The signal registry, and the runner that turns computers into report rows.
 *
 * Two jobs, both about keeping the panel honest.
 *
 * FIRST: a load-time guard. `SIGNAL_ORDER` in shared/signals.ts is what the
 * renderer draws; the computers in ./history and ./tree are what produce the
 * numbers. If those two sets ever drift — a signal added to the registry but
 * never implemented, or implemented twice — the panel silently shows a tile
 * with no data behind it. That failure is invisible in a screenshot and obvious
 * in a stack trace, so this module makes it a stack trace, at import time,
 * before any repository has been touched.
 *
 * SECOND: fault isolation. A scan reads real, arbitrary repositories. One
 * signal throwing on some pathological input must not cost the user the other
 * thirteen, so every computer runs inside its own try/catch and a failure
 * degrades to a zero-valued tile with an explanatory headline plus a warning
 * the report surfaces. Cancellation is the one exception: it is not a failure,
 * so it unwinds the whole run.
 */

import { SIGNALS, SIGNAL_ORDER, statusFor } from '../../shared/signals'
import type { Finding, HealthStatus, SignalDriver, SignalId, SignalValue } from '../../shared/types'
import type { AnalysisContext, SignalComputer } from '../model'
import { Cancelled } from '../model'
import { historySignals } from './history'
import { treeSignals } from './tree'

/** Contractual cap on driver rows — see `SignalValue.drivers`. */
const MAX_DRIVERS = 50

/**
 * Every signal computer VDE knows about. History-shaped first, then
 * tree-shaped, matching how the two modules are organised; the panel's actual
 * display order comes from `SIGNAL_ORDER`, not from this array.
 */
export const ALL_SIGNALS: readonly SignalComputer[] = Object.freeze([...historySignals, ...treeSignals])

function buildRegistry(computers: readonly SignalComputer[]): ReadonlyMap<SignalId, SignalComputer> {
  const byId = new Map<SignalId, SignalComputer>()
  const duplicated: SignalId[] = []

  for (const computer of computers) {
    if (byId.has(computer.id)) duplicated.push(computer.id)
    else byId.set(computer.id, computer)
  }

  const declared = new Set<SignalId>(SIGNAL_ORDER)
  const missing = SIGNAL_ORDER.filter((id) => !byId.has(id))
  const undeclared = [...byId.keys()].filter((id) => !declared.has(id))
  // A signal defined in SIGNALS but left out of SIGNAL_ORDER would never render,
  // which is the same defect wearing a different hat.
  const unordered = (Object.keys(SIGNALS) as SignalId[]).filter((id) => !declared.has(id))

  if (missing.length > 0 || duplicated.length > 0 || undeclared.length > 0 || unordered.length > 0) {
    const problems: string[] = []
    if (missing.length > 0) {
      problems.push(`no computer implements: ${missing.join(', ')}`)
    }
    if (duplicated.length > 0) {
      problems.push(`more than one computer claims: ${duplicated.join(', ')}`)
    }
    if (undeclared.length > 0) {
      problems.push(`computers exist for signals absent from SIGNAL_ORDER: ${undeclared.join(', ')}`)
    }
    if (unordered.length > 0) {
      problems.push(`SIGNALS defines signals absent from SIGNAL_ORDER: ${unordered.join(', ')}`)
    }
    throw new Error(
      `VDE's signal registry is inconsistent with shared/signals.ts (${problems.join('; ')}). ` +
        `Every id in SIGNAL_ORDER must have exactly one computer in analyzer/signals.`
    )
  }

  return byId
}

/** signal id → its computer. Proven total against SIGNAL_ORDER at import time. */
export const SIGNAL_REGISTRY: ReadonlyMap<SignalId, SignalComputer> = buildRegistry(ALL_SIGNALS)

/** Ranking used to order findings worst-first before they reach the UI or brief. */
const SEVERITY_RANK: Record<HealthStatus, number> = { critical: 3, serious: 2, warning: 1, good: 0 }

export interface SignalRun {
  /** One entry per signal, in `SIGNAL_ORDER`. Always complete. */
  values: SignalValue[]
  /** Every finding raised, worst-first. */
  findings: Finding[]
  /** Signals that failed. Empty on a healthy run; surfaced in RepoReport.warnings. */
  warnings: string[]
}

function capDrivers(drivers: readonly SignalDriver[]): SignalDriver[] {
  return drivers.length > MAX_DRIVERS ? drivers.slice(0, MAX_DRIVERS) : [...drivers]
}

/**
 * Runs the whole panel against one context.
 *
 * Values come back in `SIGNAL_ORDER` so the renderer can index positionally and
 * a snapshot's stored signal map is always complete. Finding ids are
 * `<signalId>-<index>` — stable for a given revision, which is what lets the
 * brief's `findingIds` allowlist round-trip through the renderer.
 *
 * Severity is the *signal's* status, not a per-finding judgement: a finding is
 * evidence for its tile, and a tile reading "critical" whose findings all read
 * "warning" would be two answers to the same question.
 */
export function runSignals(ctx: AnalysisContext): SignalRun {
  const values: SignalValue[] = []
  const findings: Finding[] = []
  const warnings: string[] = []

  for (const id of SIGNAL_ORDER) {
    const computer = SIGNAL_REGISTRY.get(id)
    if (computer === undefined) continue // unreachable: buildRegistry proved otherwise

    try {
      const result = computer.compute(ctx)
      // A signal that returns NaN or Infinity would poison statusFor, every
      // delta computed against it, and the stored snapshot. Normalise here
      // rather than trusting fourteen call sites.
      const value = Number.isFinite(result.value) ? result.value : 0
      const status = statusFor(id, value)

      values.push({
        id,
        value,
        status,
        headline: result.headline,
        drivers: capDrivers(result.drivers)
      })

      const raw = result.findings ?? []
      for (let i = 0; i < raw.length; i++) {
        const finding = raw[i]
        if (finding === undefined) continue
        findings.push({
          ...finding,
          id: `${id}-${i}`,
          signalId: id,
          severity: status
        })
      }
    } catch (err) {
      // Cancellation is the user asking us to stop, not a defect. Let it unwind.
      if (err instanceof Cancelled) throw err
      const reason = err instanceof Error ? err.message : String(err)
      warnings.push(`Signal "${SIGNALS[id].label}" failed and was reported as zero: ${reason}`)
      values.push({
        id,
        value: 0,
        status: statusFor(id, 0),
        headline:
          `${SIGNALS[id].label} could not be computed for this revision (${reason}). ` +
          `The value below is a placeholder, not a measurement.`,
        drivers: []
      })
    }
  }

  // Worst-first, ties broken by panel order so the list is deterministic.
  const panelRank = new Map<SignalId, number>(SIGNAL_ORDER.map((id, i) => [id, i]))
  findings.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (panelRank.get(a.signalId) ?? 0) - (panelRank.get(b.signalId) ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )

  return { values, findings, warnings }
}

/** Exposed for tests. */
export const __testing = { buildRegistry, MAX_DRIVERS }
