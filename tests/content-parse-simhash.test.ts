/**
 * Verification for src/analyzer/content/parse.ts and simhash.ts.
 *
 * The complexity expectations are hand-counted from the fixture sources rather
 * than captured from a previous run, so a regression in the per-language
 * node-type profiles fails a specific number instead of quietly moving a
 * baseline.
 */

import { describe, expect, it, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MAX_PARSE_CHARS,
  __testing,
  analyzeSource,
  initParser,
  isLanguageSupported,
  preloadLanguages,
  takeWarnings,
  upgradeDylinkSection
} from '../src/analyzer/content/parse'

import {
  hammingDistance,
  hammingDistanceParts,
  parseSimhash,
  similarity,
  simhash64
} from '../src/analyzer/content/simhash'

const HERE = dirname(fileURLToPath(import.meta.url))
const GRAMMAR_DIR = join(HERE, '..', 'node_modules', 'tree-sitter-wasms', 'out')

// ---------------------------------------------------------------------------
// simhash — basics
// ---------------------------------------------------------------------------

describe('simhash64', () => {
  it('returns 16 lowercase hex characters', () => {
    expect(simhash64('the quick brown fox jumps over the lazy dog')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic, with no state leaking between calls', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta'
    const first = simhash64(text)
    simhash64('an entirely unrelated string of words goes here')
    expect(simhash64(text)).toBe(first)
    expect(simhash64(text)).toBe(first)
  })

  it('separates different content', () => {
    expect(simhash64('one two three four')).not.toBe(simhash64('five six seven eight'))
  })

  it('ignores punctuation and ASCII case', () => {
    expect(simhash64('Hello, World! Foo Bar.')).toBe(simhash64('hello world foo bar'))
  })

  it('is order sensitive — shingles, not a bag of words', () => {
    const forward = simhash64('alpha beta gamma delta epsilon zeta eta theta iota kappa')
    const reversed = simhash64('kappa iota theta eta zeta epsilon delta gamma beta alpha')
    expect(forward).not.toBe(reversed)
  })

  it('keeps snake_case identifiers whole', () => {
    // If `_` split tokens, these two would share every shingle.
    expect(simhash64('render_user_card update_user_card delete_user_card')).not.toBe(
      simhash64('render user card update user card delete user card')
    )
  })

  it('handles empty and sub-shingle input without throwing', () => {
    expect(simhash64('')).toBe('0000000000000000')
    expect(simhash64('   \n\t  ---  ')).toBe('0000000000000000')
    expect(simhash64('solo')).toMatch(/^[0-9a-f]{16}$/)
    expect(simhash64('two words')).toMatch(/^[0-9a-f]{16}$/)
    expect(simhash64('solo')).not.toBe(simhash64('two words'))
  })
})

describe('hammingDistance, parseSimhash and similarity', () => {
  it('is zero against itself', () => {
    const h = simhash64('some representative document text goes here')
    expect(hammingDistance(h, h)).toBe(0)
    expect(similarity(h, h)).toBe(1)
  })

  it('counts differing bits exactly', () => {
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64)
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1)
    expect(hammingDistance('0000000000000000', '8000000000000000')).toBe(1)
    expect(hammingDistance('0000000000000000', 'ffffffff00000000')).toBe(32)
    expect(hammingDistance('00000000ffffffff', 'ffffffff00000000')).toBe(64)
    expect(similarity('0000000000000000', 'ffffffff00000000')).toBe(0.5)
  })

  it('unpacks into exact unsigned 32-bit halves', () => {
    expect(parseSimhash('cbf29ce484222325')).toEqual({ hi: 0xcbf29ce4, lo: 0x84222325 })
    expect(parseSimhash('ffffffffffffffff')).toEqual({ hi: 0xffffffff, lo: 0xffffffff })
    const a = parseSimhash('deadbeefcafebabe')
    const b = parseSimhash('deadbeefcafebabf')
    expect(hammingDistanceParts(a.hi, a.lo, b.hi, b.lo)).toBe(1)
  })

  it('agrees with the string form', () => {
    const x = simhash64('first document about ingestion pipelines and retries')
    const y = simhash64('second document about facilities leases and parking')
    const a = parseSimhash(x)
    const b = parseSimhash(y)
    expect(hammingDistanceParts(a.hi, a.lo, b.hi, b.lo)).toBe(hammingDistance(x, y))
  })

  it('accepts uppercase hex but rejects anything malformed', () => {
    expect(hammingDistance('CBF29CE484222325', 'cbf29ce484222325')).toBe(0)
    expect(() => hammingDistance('abc', '0000000000000000')).toThrow(TypeError)
    expect(() => hammingDistance('zzzzzzzzzzzzzzzz', '0000000000000000')).toThrow(TypeError)
    expect(() => parseSimhash('00000000000000000')).toThrow(TypeError)
  })
})

// ---------------------------------------------------------------------------
// simhash — the calibration the sibling-sprawl signal depends on
// ---------------------------------------------------------------------------

/*
 * Fixture sizing is calibrated against the reference specimen rather than
 * guessed. In a real agent-written repository the sibling-sprawl clusters
 * (`docs/qa/enhance-2-bluewater-*.md`, `prompts/extract_table_questions@v12`
 * vs `@v13`) are 3–8 KB documents that score 0.906, 0.953 and 0.984 against
 * their siblings, while the bulk of unrelated document pairs sit in a tight
 * band around 0.50 with only 1.7% of pairs above 0.65.
 *
 * That relationship is inherent to SimHash: a fixed-size edit is a smaller
 * fraction of a larger document, so similarity rises with length. The document
 * below is therefore a realistic ~5 KB spec, not a toy paragraph — with a
 * 300-character document, replacing a paragraph is replacing a sixth of the
 * text, which is not what "near-identical" means.
 */
const SHARED_BODY = `
# Bluewater ingestion enhancement plan

This document describes the plan for enhancing the bluewater ingestion pipeline.
The pipeline reads records from the upstream queue, validates them against the
canonical schema, enriches them with reference data, and writes the result to
the warehouse. Each stage is independently retryable and emits structured logs
carrying the correlation identifier of the record that produced them.

## Intake

Intake subscribes to the upstream topic with a consumer group per environment.
Offsets are committed only after the record has been durably handed to the
validation stage, so a crash between receipt and validation replays rather than
drops. Duplicate delivery is expected and is resolved downstream by the
idempotency key rather than by the intake stage itself.

## Validation

Validation rejects any record missing a correlation identifier or carrying a
timestamp outside the acceptable clock skew window. Rejected records are routed
to the dead letter topic with the failing rule attached. The rule set is loaded
from configuration at startup and reloaded on a signal, so tightening a rule
does not require a deployment.

## Enrichment

Enrichment joins each record against the customer dimension and the product
dimension. Both lookups are cached in process with a five minute expiry. A cache
miss falls through to the reference service, which is rate limited per consumer
and returns a stale value in preference to failing when its own upstream is
unavailable.

## Warehouse writes

Warehouse writes are batched at one thousand records or five seconds, whichever
comes first. Batches are written transactionally so a partial failure never
leaves the warehouse in an inconsistent state. Batch size and flush interval are
tunable per environment without a rebuild.

## Backfill

Backfill replays a bounded time range through the same stages as live traffic,
writing to a shadow table that is swapped in once the range is verified. The
replay runs at a throttled rate so it cannot starve live ingestion, and it is
resumable from the last committed offset.

## Schema evolution

Schema evolution is additive only. A new optional field may be introduced at any
time; removing or retyping a field requires a versioned topic and a migration
window during which both versions are consumed. The canonical schema is held in
the registry and every producer validates against it before publishing.

## Failure handling

Transient failures are retried with exponential backoff and full jitter, capped
at six attempts. A record that exhausts its attempts is written to the dead
letter topic together with the exception class and the stage that raised it.
Dead letter volume is itself a monitored metric, because a rising dead letter
rate is usually the first visible symptom of an upstream schema change.

## Monitoring

Every stage exports queue depth, processing latency and error rate. Alerts fire
when queue depth exceeds the configured ceiling for more than ten minutes, or
when the error rate over a five minute window exceeds one percent. Dashboards
break each metric down by stage and by environment.

## Ordering guarantees

Ordering is guaranteed only within a partition, and the partition key is the
account identifier. Consumers that need a global ordering must derive it from
the event timestamp and tolerate the skew documented in the validation section.
Nothing in the pipeline reorders records within a partition.

## Capacity

Steady state is roughly four thousand records per second at the intake stage,
with a daily peak of eleven thousand during the overnight reconciliation window.
The enrichment cache absorbs most of that peak; the reference service sees
fewer than two hundred requests per second even at the peak.

## Security

Records carry no direct identifiers beyond the account reference, which is
already pseudonymous. The reference service is reachable only from within the
service mesh and requires a workload identity. Dead letter contents are subject
to the same retention policy as the warehouse itself.

## Testing

Each stage has a contract test against a recorded fixture set, and the pipeline
as a whole has a replay test that runs a captured hour of production traffic and
asserts the warehouse output byte for byte. The replay test is the gate for any
change to validation or enrichment.

## Open questions

Whether the enrichment cache should be shared across replicas is unresolved. A
shared cache raises the hit rate but introduces a failure domain the pipeline
does not currently have. The decision is deferred until the capacity numbers
above have been observed in production for a full quarter.

## Rollout

Rollout proceeds environment by environment with a one week soak in each. The
previous pipeline runs in parallel and its output is compared record for record
until the difference rate falls below the agreed threshold. Only then is the
previous pipeline decommissioned and its infrastructure released.
`

const ORIGINAL_PARAGRAPH = `Warehouse writes are batched at one thousand records or five seconds, whichever
comes first. Batches are written transactionally so a partial failure never
leaves the warehouse in an inconsistent state. Batch size and flush interval are
tunable per environment without a rebuild.`

const REPLACEMENT_PARAGRAPH = `Warehouse writes now use the streaming ingest endpoint instead of batching. Each
record is acknowledged individually and the transactional guarantee comes from
the destination table rather than from the writer process. Throughput is lower
but the end to end latency is roughly halved.`

const UNRELATED_DOC = `
# Quarterly facilities report

The east campus lease renews in November. Parking utilisation averaged sixty
one percent through the quarter, down from seventy four percent a year earlier,
which the facilities team attributes to the revised hybrid attendance policy.

## Catering

Catering spend fell after the vendor consolidation. Two of the three cafeterias
now operate on a reduced weekday schedule. Feedback scores were unchanged, and
the committee recommends no further change before the lease review.

## Maintenance

The chiller on the north roof was replaced in August. Remaining deferred
maintenance items are the loading dock resurfacing and the lobby glazing, both
of which are held pending the outcome of the lease negotiation.

## Grounds

Landscaping moved to the drought tolerant planting scheme across both campuses.
Irrigation draw fell by roughly a third against the same months last year.

## Security

Badge reader firmware was updated across all doors. Two tailgating incidents
were recorded and reviewed with the affected teams. No access was granted in
error and no credential was reissued.

## Reception

Reception hours were shortened by one hour at each end of the day following the
attendance review. Visitor volume was unaffected. The parcel locker pilot ran
for eight weeks and will be extended to the west campus.

## Next quarter

The facilities committee will review the east campus lease options and report a
recommendation before the end of the following quarter.
`

describe('simhash near-duplicate calibration', () => {
  const edited = SHARED_BODY.replace(ORIGINAL_PARAGRAPH, REPLACEMENT_PARAGRAPH)

  it('actually replaced the paragraph, in a realistically sized document', () => {
    expect(edited).not.toBe(SHARED_BODY)
    expect(edited).toContain('streaming ingest endpoint')
    // Comparable to the specimen's real near-duplicate docs (3.4–7.5 KB).
    expect(SHARED_BODY.length).toBeGreaterThan(4500)
  })

  it('scores documents differing by one paragraph above 0.85', () => {
    const score = similarity(simhash64(SHARED_BODY), simhash64(edited))
    expect(score).toBeGreaterThan(0.85)
  })

  it('scores unrelated documents below 0.65', () => {
    const score = similarity(simhash64(SHARED_BODY), simhash64(UNRELATED_DOC))
    expect(score).toBeLessThan(0.65)
  })

  it('separates the two cases by a wide margin', () => {
    const near = similarity(simhash64(SHARED_BODY), simhash64(edited))
    const far = similarity(simhash64(SHARED_BODY), simhash64(UNRELATED_DOC))
    expect(near - far).toBeGreaterThan(0.25)
  })

  it('detects a one-line edit inside a large source file', () => {
    const lines: string[] = []
    for (let i = 0; i < 500; i++) {
      lines.push(`export function handler${i}(request: Request): Response {`)
      lines.push(`  if (request.id === ${i}) { return respond(${i}) }`)
      lines.push(`  return respond(0)`)
      lines.push(`}`)
    }
    const before = lines.join('\n')
    const after = before.replace('  return respond(0)\n}', '  return respond(1)\n}')
    expect(after).not.toBe(before)
    expect(similarity(simhash64(before), simhash64(after))).toBeGreaterThan(0.9)
  })
})

/*
 * Anchors the synthetic thresholds above to real agent-written data. Skipped
 * when the read-only calibration specimen is not on the machine, so the suite
 * stays green anywhere.
 */
const SPECIMEN = join(homedir(), 'codebase', 'apxstream', 'apx-response')

describe.skipIf(!existsSync(SPECIMEN))('simhash against the reference specimen', () => {
  const read = (relative: string): string => readFileSync(join(SPECIMEN, relative), 'utf8')

  const SIBLINGS: ReadonlyArray<readonly [string, string]> = [
    ['docs/qa/enhance-2-bluewater-clean-final-reproof.md', 'docs/qa/enhance-2-bluewater-clean-final-reproof-2.md'],
    ['services/harness/prompts/extract_table_questions@v12.md', 'services/harness/prompts/extract_table_questions@v13.md'],
    ['docs/qa/enhance-4-ashgrove-exit-1.md', 'docs/qa/enhance-4-ashgrove-exit-2.md']
  ]

  /*
   * 0.75, not 0.85. SimHash samples a document pair's true similarity with about
   * ±4 bits (±0.06) of noise that depends on the hash function, so pinning a
   * specific real pair to a tight threshold overfits the test to one hash. The
   * separation is what matters and it is enormous: measured over all 57,970
   * pairs of the specimen's 341 documents, similarity is mean 0.503 with sd
   * 0.065 and only 1.28% of pairs clear 0.65, while every pair below is a known
   * sibling-sprawl duplicate scoring 0.83 or better.
   */
  it('scores real sibling-sprawl pairs well above the unrelated band', () => {
    for (const [left, right] of SIBLINGS) {
      if (!existsSync(join(SPECIMEN, left)) || !existsSync(join(SPECIMEN, right))) continue
      const score = similarity(simhash64(read(left)), simhash64(read(right)))
      console.log(`specimen ${score.toFixed(3)}  ${left.split('/').pop()} vs ${right.split('/').pop()}`)
      expect(score).toBeGreaterThan(0.75)
    }
  })

  it('keeps genuinely unrelated specimen documents below 0.65', () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['docs/TECH_DEBT.md', 'docs/respond-web-ui-spec.md'],
      ['README.md', 'docs/thumbnails-grooming.md']
    ]
    for (const [left, right] of pairs) {
      if (!existsSync(join(SPECIMEN, left)) || !existsSync(join(SPECIMEN, right))) continue
      expect(similarity(simhash64(read(left)), simhash64(read(right)))).toBeLessThan(0.65)
    }
  })
})

describe('simhash performance', () => {
  it('fingerprints a 6000-line file in well under 50ms', () => {
    const lines: string[] = []
    for (let i = 0; i < 6000; i++) {
      lines.push(`const value${i} = computeSomething(alpha, beta, gamma, ${i}) // trailing note ${i}`)
    }
    const source = lines.join('\n')
    expect(source.split('\n').length).toBe(6000)

    simhash64(source) // warm up; measure steady state, not first-call tiering

    const runs = 5
    const started = performance.now()
    for (let i = 0; i < runs; i++) simhash64(source)
    const perRun = (performance.now() - started) / runs

    console.log(`simhash64: ${source.length} chars over 6000 lines, ${perRun.toFixed(2)}ms per run`)
    expect(perRun).toBeLessThan(50)
  })
})

// ---------------------------------------------------------------------------
// The dylink compatibility shim
// ---------------------------------------------------------------------------

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]

describe('upgradeDylinkSection', () => {
  it('leaves a module whose first section is not custom alone', () => {
    const module = new Uint8Array([...WASM_HEADER, 0x01, 0x02, 0x00, 0x00])
    expect(upgradeDylinkSection(module)).toBe(module)
  })

  it('leaves an already-standard dylink.0 module alone', () => {
    const name = [8, 0x64, 0x79, 0x6c, 0x69, 0x6e, 0x6b, 0x2e, 0x30]
    const module = new Uint8Array([...WASM_HEADER, 0x00, name.length, ...name])
    expect(upgradeDylinkSection(module)).toBe(module)
  })

  it('rewrites a legacy dylink header into dylink.0, byte for byte', () => {
    // The exact payload shape the shipped grammars use: name, then
    // memorysize/memoryalign/tablesize/tablealign, then a needed-count of zero.
    const payload = [6, 0x64, 0x79, 0x6c, 0x69, 0x6e, 0x6b, 0x84, 0xd7, 0x19, 0x04, 0x02, 0x00, 0x00]
    const tail = [0x01, 0x04, 0x01, 0x60, 0x00, 0x00]
    const module = new Uint8Array([...WASM_HEADER, 0x00, payload.length, ...payload, ...tail])

    const out = upgradeDylinkSection(module)
    expect(out).not.toBe(module)
    expect([...out.subarray(0, 8)]).toEqual(WASM_HEADER)
    expect(out[8]).toBe(0x00) // still a custom section, still first

    const sectionSize = out[9] ?? 0
    expect(out[10]).toBe(8)
    expect(String.fromCharCode(...out.subarray(11, 19))).toBe('dylink.0')

    // Subsection 1 (mem info) carries the original six bytes verbatim.
    expect(out[19]).toBe(0x01)
    expect(out[20]).toBe(6)
    expect([...out.subarray(21, 27)]).toEqual([0x84, 0xd7, 0x19, 0x04, 0x02, 0x00])
    // Subsection 2 (needed) carries the single count byte.
    expect(out[27]).toBe(0x02)
    expect(out[28]).toBe(1)
    expect(out[29]).toBe(0x00)

    // The declared section size matches what was actually written.
    expect(sectionSize).toBe(30 - 10)
    // The module body after the section survives untouched.
    expect([...out.subarray(10 + sectionSize)]).toEqual(tail)
  })

  it('does not throw on a truncated module', () => {
    expect(() => upgradeDylinkSection(new Uint8Array([0x00, 0x61, 0x73]))).not.toThrow()
    expect(() => upgradeDylinkSection(new Uint8Array([...WASM_HEADER, 0x00, 0x7f, 0x06]))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

describe('analyzeSource', () => {
  beforeAll(async () => {
    await initParser(GRAMMAR_DIR)
    // Preload up front so a grammar that will not load fails here loudly rather
    // than turning into a mystery null inside an assertion.
    await preloadLanguages(['typescript', 'python', 'go', 'rust', 'java', 'c', 'ruby', 'kotlin'])
    takeWarnings()
  })

  it('resolves grammar names, aliases and unknowns', () => {
    expect(__testing.resolveGrammar('typescript')).toBe('typescript')
    expect(__testing.resolveGrammar('TypeScript')).toBe('typescript')
    expect(__testing.resolveGrammar('ts')).toBe('typescript')
    expect(__testing.resolveGrammar('C#')).toBe('c_sharp')
    expect(__testing.resolveGrammar('c++')).toBe('cpp')
    expect(__testing.resolveGrammar('  Python  ')).toBe('python')
    expect(__testing.resolveGrammar('brainfuck')).toBeNull()
    expect(__testing.resolveGrammar('')).toBeNull()
  })

  it('refuses the quarantined grammars', () => {
    // These are present on disk but unusable. `swift` in particular aborts the
    // host process from a V8 compiler thread, so refusing it is load-bearing:
    // no try/catch downstream can recover from parsing with it.
    for (const grammar of ['swift', 'elm', 'ql', 'yaml']) {
      expect(__testing.QUARANTINED_GRAMMARS.has(grammar)).toBe(true)
      expect(isLanguageSupported(grammar)).toBe(false)
    }
    expect(isLanguageSupported('TypeScript')).toBe(true)
  })

  it('returns null rather than throwing for unusable input', async () => {
    expect(await analyzeSource('anything at all', 'brainfuck')).toBeNull()
    expect(await analyzeSource('func f() {}', 'swift')).toBeNull()
    expect(await analyzeSource('', 'typescript')).toBeNull()

    const huge = 'const x = 1\n'.repeat(Math.ceil(MAX_PARSE_CHARS / 12) + 10)
    expect(huge.length).toBeGreaterThan(MAX_PARSE_CHARS)
    expect(await analyzeSource(huge, 'typescript')).toBeNull()
  })

  /*
   * Hand count for TS_FIXTURE:
   *   simple   1
   *   branchy  1 + if + && + else-if + || + ternary        = 6
   *   loops    1 + for-of + while + do + case + case + catch = 7
   *   arrow    1 + ternary                                  = 2
   *   render   1   (?. and ?? are not decisions)            = 1
   * functions 5, total 17, max 7, complex 0
   */
  const TS_FIXTURE = `
export function simple(a: number): number {
  return a + 1
}

export function branchy(a: number, b: string): number {
  if (a > 0 && b.length > 0) return 1
  else if (a < 0 || b === 'x') return 2
  return a > 5 ? 3 : 4
}

export function loops(a: number, items: string[]): number {
  for (const item of items) {
    while (a > 0) { a-- }
  }
  do { a++ } while (a < 3)
  try {
    switch (a) {
      case 1: return 1
      case 2: return 2
      default: return 0
    }
  } catch (e) {
    return -1
  }
}

export const arrow = (n: number): string => (n > 1 ? 'big' : 'small')

class Widget {
  render(props?: { title?: string }): string {
    return props?.title ?? 'untitled'
  }
}
`

  it('measures TypeScript structure exactly', async () => {
    expect(await analyzeSource(TS_FIXTURE, 'typescript')).toEqual({
      functions: 5,
      totalComplexity: 17,
      maxComplexity: 7,
      complexFunctions: 0
    })
  })

  it('counts neither optional chaining nor nullish coalescing', async () => {
    const withSugar = await analyzeSource('function f(a?: {b?: {c?: number}}) { return a?.b?.c ?? 0 }', 'typescript')
    expect(withSugar).toEqual({ functions: 1, totalComplexity: 1, maxComplexity: 1, complexFunctions: 0 })
  })

  it('counts every && and || separately', async () => {
    expect((await analyzeSource('function f(a: boolean) { return a }', 'typescript'))?.totalComplexity).toBe(1)
    expect((await analyzeSource('function f(a: boolean) { return a && a || a && a }', 'typescript'))?.totalComplexity).toBe(4)
  })

  it('charges a closure’s branches to the closure, not to its parent', async () => {
    const result = await analyzeSource(
      `function outer(xs: number[]) {
         if (xs.length) {
           return xs.map((x) => (x > 0 ? x : -x))
         }
         return []
       }`,
      'typescript'
    )
    // outer: 1 + if = 2. arrow: 1 + ternary = 2. Neither absorbs the other.
    expect(result).toEqual({ functions: 2, totalComplexity: 4, maxComplexity: 2, complexFunctions: 0 })
  })

  it('flags functions past the complexity threshold', async () => {
    const conditions = Array.from({ length: 14 }, (_, i) => `  if (a === ${i}) return ${i}`).join('\n')
    const result = await analyzeSource(`function big(a: number): number {\n${conditions}\n  return -1\n}`, 'typescript')
    expect(result).toEqual({ functions: 1, totalComplexity: 15, maxComplexity: 15, complexFunctions: 1 })
  })

  it('does not flag a function sitting exactly on the threshold', async () => {
    const conditions = Array.from({ length: 9 }, (_, i) => `  if (a === ${i}) return ${i}`).join('\n')
    const result = await analyzeSource(`function edge(a: number): number {\n${conditions}\n  return -1\n}`, 'typescript')
    expect(result?.maxComplexity).toBe(10)
    expect(result?.complexFunctions).toBe(0)
  })

  /*
   * Python: elif is its own clause rather than a nested if; and/or are keyword
   * tokens; comprehension for/if clauses count; else and finally do not.
   *   f    1 + if + and + elif + for + while + except + comp-for + comp-if + ternary = 10
   *   lam  1
   * functions 2, total 11, max 10
   */
  const PY_FIXTURE = `
def f(x, y):
    if x and y:
        pass
    elif y:
        pass
    else:
        pass
    for i in range(3):
        while x:
            break
    try:
        pass
    except ValueError:
        pass
    finally:
        pass
    z = [i for i in range(3) if i]
    return 1 if x else 2

lam = lambda a: a
`

  it('measures Python structure exactly', async () => {
    expect(await analyzeSource(PY_FIXTURE, 'python')).toEqual({
      functions: 2,
      totalComplexity: 11,
      maxComplexity: 10,
      complexFunctions: 0
    })
  })

  /*
   * Go: the default arm is a `default_case` and must not count; `else if` nests
   * a second if_statement.
   *   f  1 + if + else-if + for-clause + bare-for + case + if + && + || = 9
   *   g  1 (func literal)
   *   M  1
   * functions 3, total 11, max 9.
   * If `default_case` were counted this would be 12; if the func literal's body
   * were folded into f it would be 2 functions.
   */
  const GO_FIXTURE = `
package main

func f(x int) int {
  if x > 0 {
    return 1
  } else if x < 0 {
    return 2
  }
  for i := 0; i < 3; i++ {
  }
  for {
    break
  }
  switch x {
  case 1:
  default:
  }
  g := func(y int) int { return y }
  if x > 1 && x < 5 || x == 0 {
  }
  return g(x)
}

type T struct{}

func (t T) M() {}
`

  it('measures Go structure exactly, ignoring the default arm', async () => {
    expect(await analyzeSource(GO_FIXTURE, 'go')).toEqual({
      functions: 3,
      totalComplexity: 11,
      maxComplexity: 9,
      complexFunctions: 0
    })
  })

  it('counts Java case labels but not default', async () => {
    const withDefault = await analyzeSource(
      'class A { int f(int x) { switch (x) { case 1: return 1; case 2: return 2; default: return 0; } } }',
      'java'
    )
    const withoutDefault = await analyzeSource(
      'class A { int f(int x) { switch (x) { case 1: return 1; case 2: return 2; } return 0; } }',
      'java'
    )
    expect(withDefault?.totalComplexity).toBe(3)
    expect(withoutDefault?.totalComplexity).toBe(3)
  })

  it('counts C case labels but not default', async () => {
    expect(
      await analyzeSource('int f(int x) { switch (x) { case 1: return 1; case 2: return 2; default: return 0; } }', 'c')
    ).toEqual({ functions: 1, totalComplexity: 3, maxComplexity: 3, complexFunctions: 0 })
  })

  it('counts Rust match arms alongside if and &&', async () => {
    const result = await analyzeSource(
      `fn f(x: i32) -> i32 {
         if x > 0 && x < 5 { return 1 }
         match x { 1 => 1, 2 => 2, _ => 0 }
       }`,
      'rust'
    )
    // 1 + if + && + three match arms = 6
    expect(result).toEqual({ functions: 1, totalComplexity: 6, maxComplexity: 6, complexFunctions: 0 })
  })

  it('does not double-count Ruby when clauses', async () => {
    // `when` is both a named rule and an anonymous keyword in tree-sitter-ruby.
    // Only the named rule may count; the naive version of this returns 5.
    expect(
      await analyzeSource(
        `def f(x)
           case x
           when 1 then 1
           when 2 then 2
           else 3
           end
         end`,
        'ruby'
      )
    ).toEqual({ functions: 1, totalComplexity: 3, maxComplexity: 3, complexFunctions: 0 })
  })

  it('charges a Ruby block to its enclosing method rather than splitting it out', async () => {
    expect(await analyzeSource('def f(xs)\n  xs.each { |x| x }\nend', 'ruby')).toEqual({
      functions: 1,
      totalComplexity: 2,
      maxComplexity: 2,
      complexFunctions: 0
    })
  })

  it('ignores control flow outside any function', async () => {
    expect(
      await analyzeSource('if (process.env.X) { console.log(1) }\nfor (const a of []) {}', 'typescript')
    ).toEqual({ functions: 0, totalComplexity: 0, maxComplexity: 0, complexFunctions: 0 })
  })

  it('still measures a file containing syntax errors', async () => {
    const result = await analyzeSource(
      `function good(a: number) { if (a) return 1; return 2 }
       function broken(a: number { @@@ this is not valid typescript
       function alsoGood(a: number) { return a > 1 ? 1 : 2 }`,
      'typescript'
    )
    expect(result).not.toBeNull()
    expect(result?.functions).toBeGreaterThanOrEqual(2)
  })

  it('survives pathological nesting without a stack overflow', async () => {
    // A recursive tree walk blows the JS stack well before this depth.
    const depth = 4000
    const result = await analyzeSource(
      `function f(a: number) { return ${'('.repeat(depth)}a${')'.repeat(depth)} }`,
      'typescript'
    )
    expect(result).not.toBeNull()
    expect(result?.functions).toBe(1)
  })

  it('falls back to the generic profile for an unprofiled language', async () => {
    const result = await analyzeSource(
      `fun f(x: Int): Int {
         if (x > 0) { return 1 }
         while (x > 0) { break }
         return x
       }`,
      'kotlin'
    )
    expect(result).not.toBeNull()
    expect(result?.functions).toBeGreaterThanOrEqual(1)
    expect(result?.totalComplexity).toBeGreaterThan(result?.functions ?? 0)
  })

  it('parses a 6000-line TypeScript file at a usable rate', async () => {
    const blocks: string[] = []
    for (let i = 0; i < 800; i++) {
      blocks.push(
        `export function handler${i}(a: number, b: string): number {\n` +
          `  if (a > ${i} && b.length < 3) { return 1 }\n` +
          `  else if (a < 0 || b === 'x') { return 2 }\n` +
          `  for (const c of b) { while (a > 0) { a-- } }\n` +
          `  try { switch (a) { case 1: break; default: break } } catch (e) { return 0 }\n` +
          `  return a > 1 ? 3 : 4\n` +
          `}\n`
      )
    }
    const source = blocks.join('\n')
    expect(source.split('\n').length).toBeGreaterThan(6000)

    await analyzeSource(source, 'typescript') // warm up

    const started = performance.now()
    const result = await analyzeSource(source, 'typescript')
    const elapsed = performance.now() - started

    console.log(`analyzeSource: ${source.split('\n').length} lines, ${source.length} bytes, ${elapsed.toFixed(1)}ms`)
    // Per function: 1 + if + && + else-if + || + for-of + while + case + catch + ternary = 10
    expect(result).toEqual({
      functions: 800,
      totalComplexity: 8000,
      maxComplexity: 10,
      complexFunctions: 0
    })
    expect(elapsed).toBeLessThan(2000)
  })

  it('accumulated no warnings along the healthy path', () => {
    expect(takeWarnings()).toEqual([])
  })
})
