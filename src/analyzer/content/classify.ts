/**
 * FileKind classification.
 *
 * Almost every signal in VDE is a ratio, and almost every ratio is wrong if the
 * denominator is wrong. `testDeficit` compares test lines to source lines;
 * `docBloat` compares doc changes to code changes; `godFiles` measures source
 * lines only. So this module — a few hundred lines of path rules — quietly
 * decides whether the dashboard tells the truth.
 *
 * The rules are ordered and the order is the specification. The first rule that
 * fires wins, and the order encodes a claim about which fact about a file
 * matters most:
 *
 *   1. vendored   — it is not this repository's code at all
 *   2. generated  — nobody wrote it, so nobody should be judged for it
 *   3. test       — it is code, but it is the safety net rather than the product
 *   4. doc        — it is prose
 *   5. config     — it is declarative plumbing
 *   6. asset      — it is opaque bytes
 *   7. data       — it is a payload, not a program
 *   8. source     — everything left with a recognised programming language
 *   9. unknown
 *
 * The two subtle placements: `config` sits above `asset`/`data` so that a JSON
 * fixture is still counted as configuration rather than disappearing into a
 * bucket that scoring ignores, and `data` sits above `source` only for files
 * whose extension is already data-shaped — otherwise a directory called
 * `fixtures/` would swallow the TypeScript that builds the fixtures.
 */

import type { Settings } from '../../shared/types'
import type { FileKind } from '../model'
import {
  baseName,
  detectLanguage,
  extensionOf,
  isSourceLanguage,
  normalizePath,
  pathSegments
} from './language'

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Compiled-glob cache.
 *
 * `classifyFile` runs once per path per snapshot — on the calibration specimen
 * that is 4,227 paths × 11 exclude globs × 180 snapshots, so re-parsing a glob
 * per call would dominate the whole analysis. The key space is bounded by the
 * user's settings, so no eviction is needed.
 */
const GLOB_CACHE = new Map<string, RegExp>()

/** Characters that must be escaped to appear literally in a RegExp. */
const REGEX_SPECIAL = /[.+^$()=!|\\[\]{}]/

/**
 * Compiles a glob to an anchored RegExp.
 *
 * Supported syntax, matching what `Settings.excludeGlobs` documents:
 *   `*`      any run of characters except `/`
 *   `?`      exactly one character except `/`
 *   `**`     as a whole path segment, zero or more segments
 *   `{a,b}`  alternation, nestable
 *
 * `[...]` character classes are deliberately NOT supported: brackets appear in
 * real filenames (Next.js `[slug]` routes above all) far more often than users
 * write character classes, so treating them literally is the safer default.
 */
function globToRegExp(glob: string): RegExp {
  const cached = GLOB_CACHE.get(glob)
  if (cached !== undefined) return cached

  const src = normalizePath(glob)
  const n = src.length
  let re = '^'
  let braceDepth = 0
  let i = 0

  while (i < n) {
    const c = src[i]
    if (c === undefined) break

    if (c === '\\' && i + 1 < n) {
      // Escaped literal.
      const next = src[i + 1]
      if (next !== undefined) re += REGEX_SPECIAL.test(next) || next === '*' || next === '?' ? `\\${next}` : next
      i += 2
      continue
    }

    if (c === '*') {
      let j = i
      while (j < n && src[j] === '*') j++
      const stars = j - i
      const prevIsBoundary = i === 0 || src[i - 1] === '/'
      const nextChar = j < n ? src[j] : undefined
      const nextIsBoundary = nextChar === undefined || nextChar === '/'

      if (stars >= 2 && prevIsBoundary && nextIsBoundary) {
        if (nextChar === '/') {
          // `**/` — zero or more whole segments, so `**/x` matches bare `x`.
          re += '(?:[^/]+/)*'
          i = j + 1
        } else {
          // Trailing `**` — the rest of the path, however deep.
          re += '.*'
          i = j
        }
        continue
      }
      // A `*` inside a segment, or `**` used as `a**b`: single-segment wildcard.
      re += '[^/]*'
      i = j
      continue
    }

    if (c === '?') {
      re += '[^/]'
      i++
      continue
    }

    if (c === '{') {
      braceDepth++
      re += '(?:'
      i++
      continue
    }

    if (c === '}' && braceDepth > 0) {
      braceDepth--
      re += ')'
      i++
      continue
    }

    if (c === ',' && braceDepth > 0) {
      re += '|'
      i++
      continue
    }

    re += REGEX_SPECIAL.test(c) ? `\\${c}` : c
    i++
  }

  // An unbalanced `{` would produce an invalid RegExp; close it rather than
  // throwing, because these strings come from user settings.
  while (braceDepth > 0) {
    re += ')'
    braceDepth--
  }

  re += '$'
  const compiled = new RegExp(re)
  GLOB_CACHE.set(glob, compiled)
  return compiled
}

/** True when `path` matches at least one of `globs`. */
export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return false
  const p = normalizePath(path)
  for (const g of globs) {
    if (g.length === 0) continue
    if (globToRegExp(g).test(p)) return true
  }
  return false
}

/** True when the file is excluded from all content analysis by user settings. */
export function isExcluded(path: string, settings: Settings): boolean {
  return matchesAnyGlob(path, settings.excludeGlobs)
}

// ---------------------------------------------------------------------------
// Rule 1 — vendored
// ---------------------------------------------------------------------------

/**
 * Directory names that mean "someone else's code, checked in".
 *
 * `vendor` is included even though Go modules and PHP Composer are its main
 * producers and both are unambiguous; the false-positive risk is a project that
 * genuinely names a source directory `vendor`, which does not happen.
 */
const VENDOR_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  'vendors',
  'vendored',
  'third_party',
  'thirdparty',
  'third-party',
  'godeps',
  'pods',
  'carthage',
  'site-packages',
  'dist-packages',
  '.venv',
  'venv',
  'virtualenv',
  '.tox',
  '.nox',
  '.bundle',
  '.cargo',
  '.gradle',
  '.yarn',
  '.pnpm-store',
  '.cpanm'
])

// ---------------------------------------------------------------------------
// Rule 2 — generated
// ---------------------------------------------------------------------------

/** Build-output directories. Their contents are always machine-produced. */
const GENERATED_SEGMENTS: ReadonlySet<string> = new Set([
  'dist',
  'build',
  'out',
  'output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.turbo',
  '.parcel-cache',
  '.angular',
  'target',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'coverage',
  'htmlcov',
  '.coverage',
  '.terraform',
  'generated',
  '__generated__',
  '.generated',
  'autogen',
  'codegen'
])

/**
 * Lockfiles whose names do not end in `.lock`. `Settings.generatedGlobs`
 * carries the common ones by default, but a user who narrows that list should
 * not thereby start scoring a 20,000-line lockfile as hand-written code.
 */
const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'poetry.lock',
  'pdm.lock',
  'uv.lock',
  'pipfile.lock',
  'cargo.lock',
  'gemfile.lock',
  'podfile.lock',
  'composer.lock',
  'mix.lock',
  'flake.lock',
  'go.sum',
  'packages.lock.json',
  'gradle.lockfile'
])

/**
 * Filename shapes that only a code generator produces. Ordered by how often
 * they appear so the common cases exit early.
 */
const GENERATED_NAME_RE =
  /(\.min\.(js|css|mjs)$)|(\.map$)|(_pb2(_grpc)?\.pyi?$)|(\.pb(\.go|\.cc|\.h|\.ts)$)|(_pb\.js$)|(\.g\.dart$)|(\.freezed\.dart$)|(\.g\.cs$)|(\.designer\.cs$)|(\.generated\.[a-z0-9]+$)|(\.gen\.[a-z0-9]+$)|(_generated\.[a-z0-9]+$)|(\.pb\.gw\.go$)|(_string\.go$)|(\.pyc$)/i

/** Ambient type bundles that are emitted, not authored. */
const GENERATED_EXACT_NAMES: ReadonlySet<string> = new Set([
  'schema.d.ts',
  'graphql.d.ts',
  'route-types.d.ts',
  'routetree.gen.ts',
  'generated.ts',
  'swagger.json',
  'openapi.gen.ts'
])

/**
 * Header markers agreed on across ecosystems (`@generated` is Go's and Meta's,
 * "Code generated by ... DO NOT EDIT" is the gofmt convention, Django and
 * Alembic both stamp their migrations).
 */
const GENERATED_HEADER_RE =
  /(@generated\b)|(code generated by .{0,120}?do not edit)|(do not edit this file)|(automatically generated file)|(auto-?generated by)|(this file (was|is) (auto-?)?generated)|(generated by the protocol buffer compiler)|(generated by django)/i

/** Lines and bytes of a blob's head in which a generated marker is honoured. */
const GENERATED_HEADER_LINES = 6
const GENERATED_HEADER_BYTES = 2048

/**
 * True when a blob's opening lines carry a machine-generated-file marker.
 *
 * The window is deliberately tiny — six lines or 2 KB, whichever comes first.
 * Every generator that stamps its output does so at the very top, whereas prose
 * containing the phrase "do not edit this file" is normal in a contributing
 * guide. Narrowing the window is what keeps that document out of the
 * `generated` bucket, where it would be silently dropped from every score.
 */
export function hasGeneratedHeader(head: Buffer): boolean {
  if (head.length === 0) return false
  let end = head.length > GENERATED_HEADER_BYTES ? GENERATED_HEADER_BYTES : head.length
  let seen = 0
  for (let i = 0; i < end; i++) {
    if (head[i] !== 0x0a) continue
    seen++
    if (seen === GENERATED_HEADER_LINES) {
      end = i
      break
    }
  }
  return GENERATED_HEADER_RE.test(head.toString('utf8', 0, end))
}

// ---------------------------------------------------------------------------
// Rule 3 — test
// ---------------------------------------------------------------------------

const TEST_SEGMENTS: ReadonlySet<string> = new Set([
  'test',
  'tests',
  'spec',
  'specs',
  '__tests__',
  '__test__',
  '__mocks__',
  'e2e',
  'testing'
])

/**
 * Filename conventions across the ecosystems VDE cares about: `test_x.py`,
 * `x_test.go`, `x.test.ts`, `x.spec.ts`, `XTest.java`, `x_spec.rb`.
 *
 * The `Test\.[a-z]+$` arm is case-sensitive on purpose — `FooTest.java` is a
 * test, `latest.json` is not.
 */
const TEST_NAME_RE = /(^test_|_test\.|\.test\.|\.spec\.|Test\.[a-z]+$|Spec\.[a-z]+$|_spec\.)/

const TEST_EXACT_NAMES: ReadonlySet<string> = new Set([
  'conftest.py',
  'jest.setup.ts',
  'jest.setup.js',
  'vitest.setup.ts',
  'test.py',
  'tests.py'
])

// ---------------------------------------------------------------------------
// Rule 4 — doc
// ---------------------------------------------------------------------------

/** Extensions that are prose no matter where they sit. */
const DOC_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'markdown',
  'mdx',
  'rst',
  'adoc',
  'asciidoc',
  'org',
  'textile',
  'rdoc',
  'pod',
  'me',
  'tex'
])

/** Directory names that make a bare `.txt` a document rather than a payload. */
const DOC_SEGMENTS: ReadonlySet<string> = new Set([
  'doc',
  'docs',
  'documentation',
  'guide',
  'guides',
  'manual',
  'manuals',
  'handbook',
  'wiki',
  'adr',
  'adrs',
  'rfc',
  'rfcs',
  'notes',
  'changelog',
  'changelogs',
  'evidence',
  'writeups'
])

/**
 * Files that are documents by name alone, with or without an extension. The
 * optional suffix arm catches the `LICENSE-MIT` / `CHANGELOG.old` family.
 *
 * Only applied when the extension is absent or prose-shaped, so `security.ts`
 * and `install.sh` stay code.
 */
const DOC_STEM_RE =
  /^(readme|licen[cs]e|copying|notice|changelog|changes|history|news|authors|contributors|contributing|code[-_]of[-_]conduct|security|support|maintainers|governance|install|installing|upgrading|migrating|todo|roadmap|acknowledge?ments|patents|credits|faq)([-_.].*)?$/

/** Extensions on which `DOC_STEM_RE` is allowed to fire. */
const DOC_STEM_EXTENSIONS: ReadonlySet<string> = new Set(['', 'txt', 'text', 'html', 'htm', 'in'])

// ---------------------------------------------------------------------------
// Rule 5 — config
// ---------------------------------------------------------------------------

const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([
  'json',
  'json5',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'config',
  'properties',
  'plist',
  'xml',
  'xsd',
  'editorconfig',
  'tf',
  'tfvars',
  'tfstate',
  'hcl',
  'bicep',
  'bicepparam',
  'nomad',
  'cmake',
  'mk',
  'nvmrc',
  'npmrc',
  'yarnrc',
  'babelrc',
  'eslintrc',
  'prettierrc',
  'dockerignore',
  'gitignore',
  'gitattributes',
  'gitmodules',
  'gitkeep',
  'typed',
  'example',
  'template',
  'dist',
  'sample'
])

/** Extension-less or fixed-name configuration files. */
const CONFIG_EXACT_NAMES: ReadonlySet<string> = new Set([
  'makefile',
  'gnumakefile',
  'cmakelists.txt',
  'build',
  'build.bazel',
  'workspace',
  'workspace.bazel',
  'meson.build',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'build.sbt',
  'go.mod',
  'go.work',
  'go.sum',
  'requirements.txt',
  'requirements-dev.txt',
  'constraints.txt',
  'pipfile',
  'brewfile',
  'codeowners',
  'py.typed',
  '.keep',
  'procfile',
  'buildpacks.toml',
  'renovate.json',
  '.mailmap',
  '.editorconfig',
  '.browserslistrc',
  '.nvmrc',
  '.npmrc',
  '.yarnrc',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.gitkeep',
  '.dockerignore',
  '.npmignore',
  '.eslintignore',
  '.prettierignore',
  '.env'
])

/**
 * Dotfile conventions: `.somethingrc` (with or without a format suffix) and
 * `.somethingignore`. Written as patterns rather than a list because the set
 * grows with every new tool and the shape is completely stable.
 */
const DOTFILE_RC_RE = /^\.[a-z0-9_.-]*rc(\.[a-z0-9]+)?$/
const DOTFILE_IGNORE_RE = /^\.[a-z0-9_-]*ignore$/
const DOTFILE_VERSION_RE = /^\.[a-z0-9_-]+-version$/

/**
 * Tool configuration that happens to be written in a programming language.
 * These are matched before the source rule so a repo is not credited with
 * "TypeScript" for its `vite.config.ts`.
 */
const CONFIG_STEM_PREFIXES: readonly string[] = [
  'eslint.config',
  'prettier.config',
  'stylelint.config',
  'tsconfig',
  'jsconfig',
  'jest.config',
  'vite.config',
  'vitest.config',
  'webpack.config',
  'rollup.config',
  'esbuild.config',
  'babel.config',
  'tailwind.config',
  'postcss.config',
  'next.config',
  'nuxt.config',
  'svelte.config',
  'astro.config',
  'remix.config',
  'metro.config',
  'playwright.config',
  'cypress.config',
  'karma.conf',
  'commitlint.config',
  'lint-staged.config',
  'release.config',
  'drizzle.config',
  'knexfile',
  'nodemon',
  'setup.py',
  'setup.cfg',
  'turbo.json',
  'lerna.json',
  'nx.json',
  'pnpm-workspace',
  'docker-compose',
  'compose.yaml',
  'compose.yml',
  'azure-pipelines',
  'serverless',
  'netlify',
  'vercel'
]

// ---------------------------------------------------------------------------
// Rule 6 — asset
// ---------------------------------------------------------------------------

/**
 * Extensions that are opaque payloads for a *reader*. This is deliberately a
 * different set from `isBinaryExtension`: columnar and serialisation formats
 * are binary but are data, and SVG is text but is an asset.
 */
const ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'ico', 'icns', 'webp', 'avif',
  'heic', 'heif', 'psd', 'psb', 'ai', 'eps', 'xcf', 'sketch', 'fig', 'svg', 'svgz',
  'tga', 'dds', 'exr',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'ttc',
  // archives & packages
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'jar', 'war', 'ear',
  'aar', 'apk', 'ipa', 'whl', 'egg', 'deb', 'rpm', 'dmg', 'iso', 'pkg', 'msi',
  'nupkg',
  // office documents. `.dot` is absent on purpose: Word templates are extinct
  // and Graphviz source is not, so `.dot` is treated as the language it is.
  'doc', 'docx', 'docm', 'dotx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'xlt',
  'ppt', 'pptx', 'pps', 'ppsx', 'pdf', 'odt', 'ods', 'odp', 'odg', 'pages',
  'numbers', 'key', 'vsd', 'vsdx', 'mpp', 'epub', 'mobi', 'djvu', 'rtf',
  // audio & video
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aac', 'm4a', 'wma', 'aiff', 'mid',
  'midi', 'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'mpg', 'mpeg',
  '3gp', 'ogv',
  // compiled artefacts
  'exe', 'dll', 'so', 'dylib', 'a', 'lib', 'o', 'obj', 'elf', 'class', 'pyc',
  'pyo', 'pyd', 'beam', 'wasm', 'node', 'rlib', 'pdb', 'nib',
  // 3D and other opaque payloads
  'blend', 'fbx', 'glb', 'stl', 'unity', 'uasset', 'pak', 'bundle'
])

// ---------------------------------------------------------------------------
// Rule 7 — data
// ---------------------------------------------------------------------------

const DATA_EXTENSIONS: ReadonlySet<string> = new Set([
  'csv',
  'tsv',
  'psv',
  'jsonl',
  'ndjson',
  'parquet',
  'avro',
  'orc',
  'arrow',
  'feather',
  'npy',
  'npz',
  'pkl',
  'pickle',
  'h5',
  'hdf5',
  'mat',
  'sav',
  'dta',
  'rds',
  'rdata',
  'db',
  'sqlite',
  'sqlite3',
  'mdb',
  'accdb',
  'dump',
  'bak',
  'snap',
  'vcr',
  'har',
  'pcap',
  'jwt'
])

/**
 * Directories whose contents are inputs to a program rather than part of it.
 * These only downgrade files that are not already recognised source — see the
 * module header for why.
 */
const DATA_SEGMENTS: ReadonlySet<string> = new Set([
  'fixtures',
  '__fixtures__',
  'fixture',
  'testdata',
  'test-data',
  'test_data',
  'testfiles',
  'corpus',
  'corpora',
  'golden',
  'goldens',
  '__snapshots__',
  'seeds',
  'seed-data',
  'dataset',
  'datasets',
  'dumps',
  'samples'
])

/** SQL that is a payload rather than a schema definition. */
const SQL_DUMP_RE = /(dump|backup|seed|fixture|snapshot|export)/i

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Strips the extension from a basename, preserving leading-dot filenames. */
function stemOf(base: string): string {
  const i = base.lastIndexOf('.')
  if (i <= 0) return base
  return base.slice(0, i)
}

function hasSegment(segments: readonly string[], set: ReadonlySet<string>): boolean {
  // The final segment is the filename, so it is excluded from directory tests.
  for (let i = 0; i < segments.length - 1; i++) {
    const s = segments[i]
    if (s !== undefined && set.has(s.toLowerCase())) return true
  }
  return false
}

/**
 * Assigns a file to exactly one kind.
 *
 * `head` is optional; when supplied (the first couple of kilobytes of the blob)
 * it enables generated-header detection, which is the only classification fact
 * that cannot be read off the path. Callers that have not read the blob yet may
 * omit it — the path rules alone catch the great majority of generated files.
 */
export function classifyFile(path: string, settings: Settings, head?: Buffer): FileKind {
  const norm = normalizePath(path)
  const base = baseName(norm)
  if (base.length === 0) return 'unknown'

  const lower = base.toLowerCase()
  const ext = extensionOf(lower)
  const stem = stemOf(lower)
  const segments = pathSegments(norm)

  // --- 1. vendored ---------------------------------------------------------
  if (hasSegment(segments, VENDOR_SEGMENTS)) return 'vendored'

  // --- 2. generated --------------------------------------------------------
  if (matchesAnyGlob(norm, settings.generatedGlobs)) return 'generated'
  if (hasSegment(segments, GENERATED_SEGMENTS)) return 'generated'
  if (ext === 'lock' || LOCKFILE_NAMES.has(lower)) return 'generated'
  if (GENERATED_EXACT_NAMES.has(lower)) return 'generated'
  if (GENERATED_NAME_RE.test(lower)) return 'generated'
  if (head !== undefined && hasGeneratedHeader(head)) return 'generated'

  // --- 3. test -------------------------------------------------------------
  if (hasSegment(segments, TEST_SEGMENTS)) return 'test'
  if (TEST_EXACT_NAMES.has(lower)) return 'test'
  // Case-sensitive: the `Test.java` / `Spec.scala` arms depend on capitalisation.
  if (TEST_NAME_RE.test(base)) return 'test'

  // --- 4. doc --------------------------------------------------------------
  if (DOC_EXTENSIONS.has(ext)) return 'doc'
  if (DOC_STEM_EXTENSIONS.has(ext) && DOC_STEM_RE.test(stem)) return 'doc'
  if ((ext === 'txt' || ext === 'text') && hasSegment(segments, DOC_SEGMENTS)) return 'doc'

  // --- 5. config -----------------------------------------------------------
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.') || lower.endsWith('.dockerfile')) return 'config'
  if (lower === 'containerfile' || lower.startsWith('containerfile.')) return 'config'
  if (lower.startsWith('.env')) return 'config'
  if (CONFIG_EXACT_NAMES.has(lower)) return 'config'
  if (lower.startsWith('makefile.') || lower.startsWith('gnumakefile.')) return 'config'
  if (lower.charCodeAt(0) === 46 /* '.' */) {
    if (DOTFILE_RC_RE.test(lower) || DOTFILE_IGNORE_RE.test(lower) || DOTFILE_VERSION_RE.test(lower)) return 'config'
    if (lower === '.tool-versions' || lower === '.flake8' || lower === '.gitconfig') return 'config'
  }
  if (CONFIG_EXTENSIONS.has(ext)) return 'config'
  for (const prefix of CONFIG_STEM_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}.`)) return 'config'
  }

  // --- 6. asset ------------------------------------------------------------
  if (ASSET_EXTENSIONS.has(ext)) return 'asset'

  // --- 7. data -------------------------------------------------------------
  if (DATA_EXTENSIONS.has(ext)) return 'data'
  if (ext === 'sql' && (hasSegment(segments, DATA_SEGMENTS) || SQL_DUMP_RE.test(stem))) return 'data'

  // --- 8. source -----------------------------------------------------------
  // Resolved before the remaining data rule so that a `.ts` helper living in
  // `fixtures/` is still counted as the code it is.
  const language = detectLanguage(norm, head)
  if (isSourceLanguage(language)) return 'source'

  // --- 7b. data, for non-source files sitting in a data directory ----------
  if (hasSegment(segments, DATA_SEGMENTS)) return 'data'

  // --- 9. unknown ----------------------------------------------------------
  return 'unknown'
}

/** Exposed for tests. */
export const __testing = {
  globToRegExp,
  VENDOR_SEGMENTS,
  GENERATED_SEGMENTS,
  TEST_SEGMENTS,
  DOC_EXTENSIONS,
  CONFIG_EXTENSIONS,
  ASSET_EXTENSIONS,
  DATA_EXTENSIONS
}
