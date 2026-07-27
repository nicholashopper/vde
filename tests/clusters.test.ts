import { describe, expect, it } from 'vitest'

import {
  buildClusters,
  jaccard,
  normaliseTokens,
  simhashSimilarity,
  splitExtension,
  tokenise
} from '../src/analyzer/content/clusters'
import type { FileKind } from '../src/analyzer/model'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO = '0000000000000000'

/** A 64-bit hex hash that differs from ZERO in exactly `bits` positions. */
function hashAtDistance(bits: number): string {
  let v = 0n
  for (let i = 0; i < bits; i += 1) v |= 1n << BigInt(i)
  return v.toString(16).padStart(16, '0')
}

/** Every path gets the same content hash unless overridden. */
function sameContent(paths: readonly string[], hex = ZERO): Map<string, string> {
  return new Map(paths.map((p) => [p, hex]))
}

function linesFor(paths: readonly string[], n = 200): Map<string, number> {
  return new Map(paths.map((p) => [p, n]))
}

/** Distinct, far-apart hashes so content similarity never fires by accident. */
function distinctContent(paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  paths.forEach((p, i) => {
    // Spread bits widely; any two of these differ in well over 9 positions.
    const v = (BigInt(i + 1) * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn
    out.set(p, v.toString(16).padStart(16, '0'))
  })
  return out
}

function stems(clusters: ReadonlyArray<{ stem: string }>): string[] {
  return clusters.map((c) => c.stem)
}

// ---------------------------------------------------------------------------
// Normalisation primitives
// ---------------------------------------------------------------------------

describe('normalisation', () => {
  it('strips the extension but keeps dotfile names intact', () => {
    expect(splitExtension('report-final.md')).toEqual({ stem: 'report-final', ext: '.md' })
    expect(splitExtension('surface.pending.json')).toEqual({
      stem: 'surface.pending',
      ext: '.json'
    })
    expect(splitExtension('.gitignore')).toEqual({ stem: '.gitignore', ext: '' })
    expect(splitExtension('Makefile')).toEqual({ stem: 'Makefile', ext: '' })
  })

  it('splits camelCase and PascalCase so naming conventions do not matter', () => {
    expect(tokenise('UserServiceV2')).toEqual(['user', 'service', 'v2'])
    expect(tokenise('HTTPServerConfig')).toEqual(['http', 'server', 'config'])
    expect(tokenise('enhance-2-bluewater')).toEqual(['enhance', '2', 'bluewater'])
  })

  it('removes version-ish tokens', () => {
    const set = (s: string): string[] => [...normaliseTokens(s)].sort()
    expect(set('report-final')).toEqual(['report'])
    expect(set('report-final-2')).toEqual(['report'])
    expect(set('report-final-v3')).toEqual(['report'])
    expect(set('report-final-REALLY')).toEqual(['report'])
    expect(set('report-copy')).toEqual(['report'])
    expect(set('report.backup')).toEqual(['report'])
    expect(set('handler-updated')).toEqual(['handler'])
    expect(set('UserServiceV2')).toEqual(['service', 'user'])
    // ashgrove-p3 → the "p3" is a version marker.
    expect(set('enhance-2-cohort-ashgrove-p3')).toEqual(['ashgrove', 'cohort', 'enhance'])
    // Trailing digits fused to the word.
    expect(set('aurelia-surface2')).toEqual(['aurelia', 'surface'])
  })

  it('does NOT strip digits that are part of an identifier', () => {
    // Bit widths and algorithm names must survive, or a crypto utils directory
    // becomes a false positive.
    expect([...normaliseTokens('sha256')]).toEqual(['sha256'])
    expect([...normaliseTokens('crc32')]).toEqual(['crc32'])
    expect([...normaliseTokens('base64')]).toEqual(['base64'])
    expect([...normaliseTokens('md5')]).toEqual(['md5'])
    // Short letter+digit identifiers are feature ids, not revisions.
    expect([...normaliseTokens('enhance-4-f10-proof')].sort()).toEqual(['enhance', 'f10', 'proof'])
  })

  it('never produces an empty token set', () => {
    // Everything about this name is a version marker; keeping the raw tokens
    // is the only safe answer, since an empty set matches every other empty set.
    expect(normaliseTokens('v2').size).toBeGreaterThan(0)
    expect([...normaliseTokens('final')]).toEqual(['final'])
  })

  it('computes Jaccard over token sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['a', 'b']))).toBeCloseTo(2 / 3)
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0)
    expect(jaccard(new Set<string>(), new Set(['a']))).toBe(0)
  })

  it('computes SimHash similarity as 1 minus normalised Hamming distance', () => {
    expect(simhashSimilarity(ZERO, ZERO)).toBe(1)
    expect(simhashSimilarity(ZERO, hashAtDistance(8))).toBeCloseTo(1 - 8 / 64)
    expect(simhashSimilarity(ZERO, hashAtDistance(64))).toBe(0)
    expect(simhashSimilarity(ZERO, 'not-a-hash')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The two real specimens. These are the acceptance criteria.
// ---------------------------------------------------------------------------

describe('real specimen: docs/qa reproof pile', () => {
  // Observed verbatim in ~/codebase/apxstream/apx-response.
  const pile = [
    'docs/qa/enhance-2-bluewater-clean-final-reproof.md',
    'docs/qa/enhance-2-bluewater-clean-final-reproof-2.md',
    'docs/qa/enhance-2-bluewater-clean-final-reproof-3.md',
    'docs/qa/enhance-2-bluewater-final-root-reproof.md',
    'docs/qa/enhance-2-bluewater-final-targeted-reproof.md',
    'docs/qa/enhance-2-bluewater-single-reproof.md',
    'docs/qa/enhance-2-bluewater-reproof.md'
  ]
  // Neighbours in the same directory that must NOT be swept in.
  const neighbours = [
    'docs/qa/enhance-2-bluewater-f72-annual-reproof.md',
    'docs/qa/enhance-2-cohort-aurelia.md',
    'docs/qa/enhance-2-preflight.md',
    'docs/qa/golden-review.md',
    'docs/qa/campaign.md'
  ]

  it('groups all seven variants into one cluster', () => {
    const paths = [...pile, ...neighbours]
    const clusters = buildClusters(paths, distinctContent(paths), { lines: linesFor(paths) })

    const found = clusters.find((c) => c.members.length === 7)
    expect(found).toBeDefined()
    expect(found?.members).toEqual([...pile].sort())
  })

  it('labels the cluster with the shared stem, as a human would', () => {
    const clusters = buildClusters(pile, distinctContent(pile), { lines: linesFor(pile) })
    expect(stems(clusters)).toEqual(['docs/qa/enhance-2-bluewater'])
    expect(clusters[0]?.basis).toBe('name')
    // Mean pairwise cohesion: the pile is real but not uniform.
    expect(clusters[0]?.similarity).toBeGreaterThan(0.6)
    expect(clusters[0]?.similarity).toBeLessThan(0.85)
  })

  it('leaves the f72-annual variant out — it is a different report', () => {
    const paths = [...pile, ...neighbours]
    const clusters = buildClusters(paths, distinctContent(paths), { lines: linesFor(paths) })
    for (const c of clusters) {
      expect(c.members).not.toContain('docs/qa/enhance-2-bluewater-f72-annual-reproof.md')
    }
  })
})

describe('real specimen: ashgrove cohort pages', () => {
  const pile = [
    'docs/qa/enhance-2-cohort-ashgrove.md',
    'docs/qa/enhance-2-cohort-ashgrove-p3.md',
    'docs/qa/enhance-2-cohort-ashgrove-p4.md',
    'docs/qa/enhance-2-cohort-ashgrove-p5.md',
    'docs/qa/enhance-2-cohort-ashgrove-p6.md'
  ]
  const neighbours = [
    'docs/qa/enhance-2-cohort-aurelia.md',
    'docs/qa/enhance-2-final-ashgrove.md',
    'docs/qa/enhance-2-final-aurelia.md',
    'docs/qa/enhance-2-final-bluewater.md'
  ]

  it('groups the five ashgrove pages and nothing else', () => {
    const paths = [...pile, ...neighbours]
    const clusters = buildClusters(paths, distinctContent(paths), { lines: linesFor(paths) })
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.members).toEqual([...pile].sort())
    expect(clusters[0]?.stem).toBe('docs/qa/enhance-2-cohort-ashgrove')
  })

  it('keeps aurelia separate from ashgrove', () => {
    const paths = [...pile, ...neighbours]
    const clusters = buildClusters(paths, distinctContent(paths), { lines: linesFor(paths) })
    expect(clusters.some((c) => c.members.includes('docs/qa/enhance-2-cohort-aurelia.md'))).toBe(
      false
    )
  })
})

// ---------------------------------------------------------------------------
// False-positive traps. Being wrong here costs the user real files.
// ---------------------------------------------------------------------------

describe('false-positive trap: locale bundles', () => {
  const inLocaleDir = [
    'src/locales/en.json',
    'src/locales/fr.json',
    'src/locales/de.json',
    'src/locales/pt-BR.json',
    'src/locales/zh_Hans.json'
  ]

  it('ignores files under a locales/ directory even when byte-identical', () => {
    const clusters = buildClusters(inLocaleDir, sameContent(inLocaleDir), {
      lines: linesFor(inLocaleDir)
    })
    expect(clusters).toEqual([])
  })

  it('ignores language-tag filenames outside a locales/ directory', () => {
    // The directory name gives nothing away, so the cluster-level veto has to
    // catch it. These would otherwise cluster on content: translation bundles
    // share a key structure and hash almost identically.
    const loose = ['src/strings/en.json', 'src/strings/fr.json', 'src/strings/de.json']
    const clusters = buildClusters(loose, sameContent(loose), { lines: linesFor(loose) })
    expect(clusters).toEqual([])
  })

  it('still catches genuine sprawl sitting beside locale files', () => {
    const paths = [
      'src/strings/en.json',
      'src/strings/fr.json',
      'src/strings/de.json',
      'src/strings/messages.json',
      'src/strings/messages-final.json',
      'src/strings/messages-final-2.json'
    ]
    const clusters = buildClusters(paths, distinctContent(paths), { lines: linesFor(paths) })
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.members).toEqual([
      'src/strings/messages-final-2.json',
      'src/strings/messages-final.json',
      'src/strings/messages.json'
    ])
  })
})

describe('false-positive trap: one index.ts per module', () => {
  const paths = [
    'src/user/index.ts',
    'src/order/index.ts',
    'src/product/index.ts',
    'src/billing/index.ts'
  ]

  it('never clusters identically-named files in different directories', () => {
    // Byte-identical barrels across modules are correct, common, and must not
    // be reported. Directory scoping is the only thing preventing it.
    const clusters = buildClusters(paths, sameContent(paths), { lines: linesFor(paths) })
    expect(clusters).toEqual([])
  })

  it('does not cluster a module with its own test and types siblings', () => {
    const siblings = [
      'src/user/index.ts',
      'src/user/index.test.ts',
      'src/user/types.ts',
      'src/user/helpers.ts'
    ]
    const clusters = buildClusters(siblings, distinctContent(siblings), {
      lines: linesFor(siblings)
    })
    expect(clusters).toEqual([])
  })
})

describe('other exclusions', () => {
  it('ignores numbered database migrations', () => {
    const paths = [
      'services/kb/migrations/0001_baseline.sql',
      'services/kb/migrations/0002_response_pairs_scope.sql',
      'services/kb/migrations/0003_thumbnails.sql',
      'services/kb/migrations/0004_confirmed_working_source.sql'
    ]
    const clusters = buildClusters(paths, sameContent(paths), { lines: linesFor(paths) })
    expect(clusters).toEqual([])
  })

  it('ignores a zero-padded sequence even outside a migrations directory', () => {
    const paths = ['db/steps/0001_init.sql', 'db/steps/0002_users.sql', 'db/steps/0003_index.sql']
    const clusters = buildClusters(paths, sameContent(paths), { lines: linesFor(paths) })
    expect(clusters).toEqual([])
  })

  it('ignores snapshots, fixtures and corpora', () => {
    for (const dir of ['__snapshots__', 'fixtures', 'testdata', 'corpus', 'cassettes']) {
      const paths = [`pkg/${dir}/case.json`, `pkg/${dir}/case-2.json`, `pkg/${dir}/case-3.json`]
      const clusters = buildClusters(paths, sameContent(paths), { lines: linesFor(paths) })
      expect(clusters, dir).toEqual([])
    }
  })

  it('ignores alembic/versions but not a bare versions/ directory', () => {
    const alembic = [
      'app/alembic/versions/abc_add_users.py',
      'app/alembic/versions/abc_add_users-2.py',
      'app/alembic/versions/abc_add_users-3.py'
    ]
    expect(buildClusters(alembic, sameContent(alembic), { lines: linesFor(alembic) })).toEqual([])

    const plain = [
      'app/versions/notes.md',
      'app/versions/notes-final.md',
      'app/versions/notes-final-2.md'
    ]
    expect(buildClusters(plain, distinctContent(plain), { lines: linesFor(plain) })).toHaveLength(1)
  })

  it('ignores dated and changelog-shaped filenames', () => {
    const dated = [
      'docs/qa/2026-07-21-bench-suite-assessment.md',
      'docs/qa/2026-07-22-bench-suite-assessment.md',
      'docs/qa/2026-07-23-bench-suite-assessment.md'
    ]
    expect(buildClusters(dated, sameContent(dated), { lines: linesFor(dated) })).toEqual([])

    const changelogs = ['CHANGELOG.md', 'CHANGELOG-1.md', 'CHANGELOG-2.md']
    expect(
      buildClusters(changelogs, sameContent(changelogs), { lines: linesFor(changelogs) })
    ).toEqual([])
  })

  it('ignores generated, vendored, asset and data kinds', () => {
    const paths = ['api/schema.ts', 'api/schema-2.ts', 'api/schema-3.ts']
    const kinds = new Map<string, FileKind>([
      ['api/schema.ts', 'generated'],
      ['api/schema-2.ts', 'generated'],
      ['api/schema-3.ts', 'generated']
    ])
    expect(
      buildClusters(paths, distinctContent(paths), { kinds, lines: linesFor(paths) })
    ).toEqual([])

    // Same paths, classified as source, do cluster.
    expect(
      buildClusters(paths, distinctContent(paths), {
        kinds: new Map<string, FileKind>(paths.map((p) => [p, 'source'])),
        lines: linesFor(paths)
      })
    ).toHaveLength(1)
  })

  it('honours a caller-supplied exclusion predicate', () => {
    const paths = ['out/bundle.js', 'out/bundle-2.js', 'out/bundle-3.js', 'x/a.md', 'x/a-2.md', 'x/a-3.md']
    const clusters = buildClusters(paths, distinctContent(paths), {
      lines: linesFor(paths),
      isExcluded: (p) => p.startsWith('x/')
    })
    // out/ is excluded by the built-in directory rule, x/ by the predicate.
    expect(clusters).toEqual([])
  })

  it('does not cluster hash-width siblings', () => {
    // The regression this guards: stripping trailing digits unconditionally
    // turns sha1/sha256/sha512 into one token.
    const paths = ['src/hash/sha1.ts', 'src/hash/sha256.ts', 'src/hash/sha512.ts']
    const clusters = buildClusters(paths, distinctContent(paths), { lines: linesFor(paths) })
    expect(clusters).toEqual([])
  })

  it('does not cluster a medial ordinal used as a naming field', () => {
    // Observed in the specimen. P1/P2/P3 are three separate lanes of work, not
    // three drafts of one document — the ordinal is medial, not a suffix.
    const paths = [
      'docs/epics/vault-service/lane-P1-specs.md',
      'docs/epics/vault-service/lane-P2-specs.md',
      'docs/epics/vault-service/lane-P3-specs.md'
    ]
    expect(buildClusters(paths, distinctContent(paths), { lines: linesFor(paths) })).toEqual([])
  })

  it('does not cluster one test per numbered migration', () => {
    // Observed in the specimen. Each file carries its own long number, so this
    // is an enumeration, not a pile of retries.
    const paths = [
      'services/respond-bff/tests/test_migration_0003.py',
      'services/respond-bff/tests/test_migration_0004.py',
      'services/respond-bff/tests/test_migration_0005.py',
      'services/respond-bff/tests/test_migration_0007.py'
    ]
    expect(buildClusters(paths, sameContent(paths), { lines: linesFor(paths) })).toEqual([])
  })

  it('does not chain a component, its test, and another component test', () => {
    // Observed in the specimen. Without the facet fence these three link up
    // through the shared ".test" token at Jaccard 0.75.
    const paths = [
      'src/components/ResponseTagsEditor.tsx',
      'src/components/ResponseTagsEditor.test.tsx',
      'src/components/TagsEditor.test.tsx'
    ]
    expect(buildClusters(paths, distinctContent(paths), { lines: linesFor(paths) })).toEqual([])
  })

  it('recognises Go and Python test conventions as facets', () => {
    const go = ['pkg/handler.go', 'pkg/handler_test.go', 'pkg/router_test.go']
    expect(buildClusters(go, distinctContent(go), { lines: linesFor(go) })).toEqual([])

    const py = ['app/migration.py', 'app/test_migration.py', 'app/test_router.py']
    expect(buildClusters(py, distinctContent(py), { lines: linesFor(py) })).toEqual([])
  })

  it('does not cluster per-feature proof documents', () => {
    const paths = [
      'docs/qa/enhance-4-f10-proof.md',
      'docs/qa/enhance-4-f11-proof.md',
      'docs/qa/enhance-4-f12-proof.md',
      'docs/qa/enhance-4-f13-proof.md'
    ]
    const clusters = buildClusters(paths, distinctContent(paths), { lines: linesFor(paths) })
    expect(clusters).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Thresholds, content mechanism, ordering
// ---------------------------------------------------------------------------

describe('cluster emission rules', () => {
  it('requires at least three members', () => {
    const two = ['docs/report.md', 'docs/report-final.md']
    expect(buildClusters(two, distinctContent(two), { lines: linesFor(two) })).toEqual([])

    const three = [...two, 'docs/report-final-2.md']
    expect(buildClusters(three, distinctContent(three), { lines: linesFor(three) })).toHaveLength(1)
  })

  it('clusters on content alone when names are unrelated', () => {
    const paths = ['src/api/alpha.ts', 'src/api/bravo.ts', 'src/api/charlie.ts']
    const hashes = new Map<string, string>([
      ['src/api/alpha.ts', ZERO],
      ['src/api/bravo.ts', hashAtDistance(4)],
      ['src/api/charlie.ts', hashAtDistance(8)]
    ])
    const clusters = buildClusters(paths, hashes, { lines: linesFor(paths) })
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.basis).toBe('content')
    expect(clusters[0]?.members).toEqual(paths)
    // No shared name prefix at all, so the label falls back to the directory.
    expect(clusters[0]?.stem).toBe('src/api')
  })

  it('does not cluster content beyond the similarity threshold', () => {
    const paths = ['src/api/alpha.ts', 'src/api/bravo.ts', 'src/api/charlie.ts']
    const hashes = new Map<string, string>([
      ['src/api/alpha.ts', ZERO],
      ['src/api/bravo.ts', hashAtDistance(20)],
      ['src/api/charlie.ts', hashAtDistance(40)]
    ])
    expect(buildClusters(paths, hashes, { lines: linesFor(paths) })).toEqual([])
  })

  it('suppresses content edges between trivially small files', () => {
    const paths = ['src/api/alpha.ts', 'src/api/bravo.ts', 'src/api/charlie.ts']
    const clusters = buildClusters(paths, sameContent(paths), {
      lines: new Map(paths.map((p) => [p, 4]))
    })
    expect(clusters).toEqual([])
  })

  it('reports basis "both" when a name cluster is also near-duplicate content', () => {
    const paths = ['docs/report.md', 'docs/report-final.md', 'docs/report-final-2.md']
    const clusters = buildClusters(paths, sameContent(paths), { lines: linesFor(paths) })
    expect(clusters[0]?.basis).toBe('both')
    expect(clusters[0]?.similarity).toBe(1)
  })

  it('does not cluster across file extensions', () => {
    const paths = ['cfg/settings.ts', 'cfg/settings.json', 'cfg/settings.yaml']
    expect(buildClusters(paths, sameContent(paths), { lines: linesFor(paths) })).toEqual([])
  })

  it('sorts by member count descending then stem ascending, deterministically', () => {
    const big = ['a/z.md', 'a/z-final.md', 'a/z-final-2.md', 'a/z-final-3.md']
    const small = ['b/y.md', 'b/y-final.md', 'b/y-final-2.md']
    const other = ['c/y.md', 'c/y-final.md', 'c/y-final-2.md']
    const paths = [...small, ...other, ...big]

    const first = buildClusters(paths, distinctContent(paths), { lines: linesFor(paths) })
    expect(stems(first)).toEqual(['a/z', 'b/y', 'c/y'])
    expect(first[0]?.members).toHaveLength(4)

    // Shuffling the input must not change the output.
    const shuffled = [...paths].reverse()
    const second = buildClusters(shuffled, distinctContent(shuffled), { lines: linesFor(shuffled) })
    expect(second).toEqual(first)
  })

  it('tolerates missing simhashes and empty input', () => {
    const paths = ['docs/report.md', 'docs/report-final.md', 'docs/report-final-2.md']
    const clusters = buildClusters(paths, new Map(), {})
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.basis).toBe('name')
    expect(buildClusters([], new Map(), {})).toEqual([])
  })

  it('clusters @-versioned prompt files and labels them without the marker', () => {
    // Observed in the specimen: fifteen checked-in revisions of one prompt.
    const paths = [
      'prompts/extract_table_questions@v1.md',
      'prompts/extract_table_questions@v2.md',
      'prompts/extract_table_questions@v10.md',
      'prompts/extract_table_questions@v15.md'
    ]
    const clusters = buildClusters(paths, distinctContent(paths), { lines: linesFor(paths) })
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.members).toHaveLength(4)
    // The literal common prefix is "…questions@v"; the dangling marker is cut.
    expect(clusters[0]?.stem).toBe('prompts/extract_table_questions')
  })

  it('keeps a shared stem that already lands on a word boundary', () => {
    const paths = ['docs/plan.md', 'docs/plan-v2.md', 'docs/plan-v3.md']
    const clusters = buildClusters(paths, distinctContent(paths), { lines: linesFor(paths) })
    expect(clusters[0]?.stem).toBe('docs/plan')
  })

  it('matches a shared stem case-insensitively', () => {
    const paths = ['docs/Report.md', 'docs/report-final.md', 'docs/report-final-2.md']
    const clusters = buildClusters(paths, distinctContent(paths), { lines: linesFor(paths) })
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.stem).toBe('docs/Report')
  })

  it('clusters files at the repository root', () => {
    const paths = ['notes.md', 'notes-final.md', 'notes-final-2.md']
    const clusters = buildClusters(paths, distinctContent(paths), { lines: linesFor(paths) })
    expect(clusters[0]?.stem).toBe('notes')
  })
})
