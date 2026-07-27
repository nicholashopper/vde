/**
 * Language identification.
 *
 * Every blob VDE looks inside gets a language name, and that name is the key to
 * three downstream decisions: which comment syntax `loc.ts` uses, whether
 * `classify.ts` calls the file source code, and which slice of the language
 * stacked-area chart it lands in.
 *
 * Identification is path-first and content-second. Paths are free — we already
 * have them from `ls-tree` — while content costs a `cat-file`. The optional
 * `head` buffer is consulted only when the path is uninformative, which in
 * practice means extension-less scripts.
 *
 * Names follow GitHub Linguist where Linguist has an opinion, because that is
 * what users have seen elsewhere. Two deliberate departures: `.h` becomes
 * "C/C++ Header" rather than being guessed at, and `.d.ts` becomes "TypeScript
 * Declaration" so that generated ambient types do not inflate a repo's
 * hand-written TypeScript.
 *
 * No colours live here. Colour is a renderer concern; the analyzer emits names.
 */

// ---------------------------------------------------------------------------
// Path helpers
//
// Shared with classify.ts. These are deliberately string-only — `node:path`
// would apply Windows separator rules to what are always POSIX repo-relative
// paths coming out of git.
// ---------------------------------------------------------------------------

/** Strips leading `./` and `/` so glob and segment logic sees a bare repo-relative path. */
export function normalizePath(path: string): string {
  let p = path
  if (p.startsWith('./')) p = p.slice(2)
  while (p.startsWith('/')) p = p.slice(1)
  return p
}

/** Final path component. Returns '' for a path ending in a separator. */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/**
 * Lowercased extension without the dot, or '' when there is none.
 *
 * A leading dot does not begin an extension, so `.gitignore` has no extension
 * while `.env.example` has "example". Only the final segment counts, which is
 * what keeps `report.doc.meta.yml` out of the Word-document bucket.
 */
export function extensionOf(path: string): string {
  const base = baseName(path)
  const i = base.lastIndexOf('.')
  if (i <= 0) return ''
  return base.slice(i + 1).toLowerCase()
}

/** Non-empty path segments, in order. */
export function pathSegments(path: string): string[] {
  return normalizePath(path).split('/').filter((s) => s.length > 0)
}

// ---------------------------------------------------------------------------
// Extension → language
// ---------------------------------------------------------------------------

/**
 * The bulk of identification. Keys are lowercase and dot-free.
 *
 * Where an extension is genuinely ambiguous across ecosystems the entry picks
 * the overwhelmingly more common meaning and the comment records the loser:
 * `.m` is Objective-C (not MATLAB — MATLAB code is far rarer in git repos and
 * usually ships as `.mlx`), `.r` is R (not Rebol), `.pl` is Perl (not Prolog),
 * `.v` is Verilog (not Coq or V — Verilog wins on volume).
 */
const EXT_LANGUAGE: Record<string, string> = {
  // --- JavaScript / TypeScript ---------------------------------------------
  ts: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  jsx: 'JSX',
  coffee: 'CoffeeScript',
  // --- Web ------------------------------------------------------------------
  html: 'HTML',
  htm: 'HTML',
  xhtml: 'HTML',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
  css: 'CSS',
  scss: 'SCSS',
  sass: 'Sass',
  less: 'Less',
  styl: 'Stylus',
  hbs: 'Handlebars',
  handlebars: 'Handlebars',
  mustache: 'Mustache',
  ejs: 'EJS',
  pug: 'Pug',
  jade: 'Pug',
  liquid: 'Liquid',
  twig: 'Twig',
  njk: 'Jinja',
  jinja: 'Jinja',
  jinja2: 'Jinja',
  erb: 'ERB',
  // --- Python ---------------------------------------------------------------
  py: 'Python',
  pyi: 'Python',
  pyw: 'Python',
  pyx: 'Cython',
  pxd: 'Cython',
  ipynb: 'Jupyter Notebook',
  // --- Systems --------------------------------------------------------------
  go: 'Go',
  rs: 'Rust',
  zig: 'Zig',
  c: 'C',
  h: 'C/C++ Header',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  'c++': 'C++',
  hpp: 'C++ Header',
  hh: 'C++ Header',
  hxx: 'C++ Header',
  ino: 'C++',
  m: 'Objective-C',
  mm: 'Objective-C++',
  d: 'D',
  nim: 'Nim',
  odin: 'Odin',
  cr: 'Crystal',
  vala: 'Vala',
  hx: 'Haxe',
  asm: 'Assembly',
  s: 'Assembly',
  wat: 'WebAssembly Text',
  // --- JVM / .NET -----------------------------------------------------------
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  scala: 'Scala',
  sc: 'Scala',
  sbt: 'Scala',
  groovy: 'Groovy',
  gradle: 'Gradle',
  clj: 'Clojure',
  cljs: 'ClojureScript',
  cljc: 'Clojure',
  edn: 'EDN',
  cs: 'C#',
  fs: 'F#',
  fsx: 'F#',
  fsi: 'F#',
  vb: 'Visual Basic',
  // --- Mobile / apps --------------------------------------------------------
  swift: 'Swift',
  dart: 'Dart',
  // --- Scripting ------------------------------------------------------------
  rb: 'Ruby',
  rake: 'Ruby',
  gemspec: 'Ruby',
  php: 'PHP',
  phtml: 'PHP',
  pl: 'Perl',
  pm: 'Perl',
  lua: 'Lua',
  tcl: 'Tcl',
  awk: 'Awk',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  ksh: 'Shell',
  dash: 'Shell',
  // nginx / docker-entrypoint.d convention: a sourced shell fragment.
  envsh: 'Shell',
  fish: 'Fish',
  nu: 'Nushell',
  ps1: 'PowerShell',
  psm1: 'PowerShell',
  psd1: 'PowerShell',
  bat: 'Batch',
  cmd: 'Batch',
  // --- Functional -----------------------------------------------------------
  hs: 'Haskell',
  lhs: 'Haskell',
  elm: 'Elm',
  purs: 'PureScript',
  res: 'ReScript',
  ml: 'OCaml',
  mli: 'OCaml',
  re: 'ReasonML',
  ex: 'Elixir',
  exs: 'Elixir',
  erl: 'Erlang',
  hrl: 'Erlang',
  gleam: 'Gleam',
  lisp: 'Common Lisp',
  cl: 'Common Lisp',
  el: 'Emacs Lisp',
  scm: 'Scheme',
  ss: 'Scheme',
  rkt: 'Racket',
  // --- Data / scientific ----------------------------------------------------
  r: 'R',
  rmd: 'R Markdown',
  jl: 'Julia',
  sql: 'SQL',
  psql: 'SQL',
  prql: 'PRQL',
  // --- Hardware / legacy ----------------------------------------------------
  v: 'Verilog',
  sv: 'SystemVerilog',
  svh: 'SystemVerilog',
  vhd: 'VHDL',
  vhdl: 'VHDL',
  f90: 'Fortran',
  f95: 'Fortran',
  f03: 'Fortran',
  for: 'Fortran',
  ada: 'Ada',
  adb: 'Ada',
  ads: 'Ada',
  cob: 'COBOL',
  cbl: 'COBOL',
  pas: 'Pascal',
  dpr: 'Pascal',
  // --- Blockchain -----------------------------------------------------------
  sol: 'Solidity',
  cairo: 'Cairo',
  move: 'Move',
  // --- Schema / IDL ---------------------------------------------------------
  proto: 'Protocol Buffers',
  graphql: 'GraphQL',
  gql: 'GraphQL',
  thrift: 'Thrift',
  dot: 'Graphviz',
  gv: 'Graphviz',
  avdl: 'Avro IDL',
  capnp: "Cap'n Proto",
  // --- Infrastructure -------------------------------------------------------
  tf: 'Terraform',
  tfvars: 'Terraform',
  hcl: 'HCL',
  bicep: 'Bicep',
  nix: 'Nix',
  pp: 'Puppet',
  bzl: 'Starlark',
  bazel: 'Starlark',
  star: 'Starlark',
  cmake: 'CMake',
  mk: 'Makefile',
  just: 'Just',
  // --- Markup / docs --------------------------------------------------------
  md: 'Markdown',
  markdown: 'Markdown',
  mdx: 'MDX',
  rst: 'reStructuredText',
  adoc: 'AsciiDoc',
  asciidoc: 'AsciiDoc',
  org: 'Org',
  tex: 'TeX',
  bib: 'BibTeX',
  txt: 'Text',
  text: 'Text',
  rtf: 'Rich Text',
  // --- Config / data --------------------------------------------------------
  json: 'JSON',
  json5: 'JSON5',
  jsonc: 'JSON',
  jsonl: 'JSON Lines',
  ndjson: 'JSON Lines',
  geojson: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  ini: 'INI',
  cfg: 'INI',
  conf: 'INI',
  properties: 'Properties',
  plist: 'XML',
  xml: 'XML',
  xsd: 'XML',
  xsl: 'XSLT',
  xslt: 'XSLT',
  svg: 'SVG',
  csv: 'CSV',
  tsv: 'TSV',
  diff: 'Diff',
  patch: 'Diff',
  lock: 'Lock File',
  env: 'Dotenv',
  snap: 'Snapshot',
  http: 'HTTP Request',
  // --- Binary-ish (named so the language chart is honest about them) --------
  wasm: 'WebAssembly',
  parquet: 'Parquet',
  pdf: 'PDF'
}

/**
 * Extension-less or fixed-name files. Checked before the extension table so
 * `CMakeLists.txt` does not become plain text.
 */
const FILENAME_LANGUAGE: Record<string, string> = {
  dockerfile: 'Dockerfile',
  containerfile: 'Dockerfile',
  makefile: 'Makefile',
  gnumakefile: 'Makefile',
  'cmakelists.txt': 'CMake',
  rakefile: 'Ruby',
  gemfile: 'Ruby',
  'gemfile.lock': 'Lock File',
  podfile: 'Ruby',
  'podfile.lock': 'Lock File',
  brewfile: 'Ruby',
  guardfile: 'Ruby',
  capfile: 'Ruby',
  thorfile: 'Ruby',
  vagrantfile: 'Ruby',
  fastfile: 'Ruby',
  appfile: 'Ruby',
  jenkinsfile: 'Groovy',
  procfile: 'YAML',
  justfile: 'Just',
  'meson.build': 'Meson',
  build: 'Starlark',
  'build.bazel': 'Starlark',
  workspace: 'Starlark',
  'workspace.bazel': 'Starlark',
  'go.mod': 'Go Module',
  'go.sum': 'Go Checksums',
  'go.work': 'Go Module',
  pipfile: 'TOML',
  'pipfile.lock': 'Lock File',
  'requirements.txt': 'Requirements',
  'constraints.txt': 'Requirements',
  'py.typed': 'Marker',
  codeowners: 'CODEOWNERS',
  license: 'Text',
  licence: 'Text',
  copying: 'Text',
  notice: 'Text',
  authors: 'Text',
  contributors: 'Text',
  '.gitignore': 'Ignore List',
  '.dockerignore': 'Ignore List',
  '.npmignore': 'Ignore List',
  '.eslintignore': 'Ignore List',
  '.prettierignore': 'Ignore List',
  '.gitattributes': 'Git Attributes',
  '.gitmodules': 'Git Config',
  '.gitkeep': 'Marker',
  '.keep': 'Marker',
  '.editorconfig': 'EditorConfig',
  '.nvmrc': 'Text',
  '.npmrc': 'INI',
  '.yarnrc': 'INI',
  '.browserslistrc': 'Text',
  '.babelrc': 'JSON',
  '.eslintrc': 'JSON',
  '.prettierrc': 'JSON',
  '.stylelintrc': 'JSON',
  '.bashrc': 'Shell',
  '.bash_profile': 'Shell',
  '.zshrc': 'Shell',
  '.profile': 'Shell',
  '.env': 'Dotenv'
}

/**
 * Compound extensions, checked before the single-extension table. Longest
 * match wins, so `.d.mts` beats `.mts`.
 */
const COMPOUND_EXT: ReadonlyArray<readonly [string, string]> = [
  ['.d.ts', 'TypeScript Declaration'],
  ['.d.mts', 'TypeScript Declaration'],
  ['.d.cts', 'TypeScript Declaration'],
  ['.tar.gz', 'Archive'],
  ['.tar.bz2', 'Archive'],
  ['.tar.xz', 'Archive'],
  ['.blade.php', 'PHP'],
  ['.podspec', 'Ruby']
]

/** Interpreter basename → language, for `#!` lines. */
const SHEBANG_LANGUAGE: Record<string, string> = {
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  ksh: 'Shell',
  dash: 'Shell',
  ash: 'Shell',
  fish: 'Fish',
  nu: 'Nushell',
  python: 'Python',
  python2: 'Python',
  python3: 'Python',
  pypy: 'Python',
  node: 'JavaScript',
  nodejs: 'JavaScript',
  deno: 'TypeScript',
  bun: 'TypeScript',
  'ts-node': 'TypeScript',
  ruby: 'Ruby',
  perl: 'Perl',
  php: 'PHP',
  lua: 'Lua',
  tclsh: 'Tcl',
  wish: 'Tcl',
  awk: 'Awk',
  gawk: 'Awk',
  mawk: 'Awk',
  sed: 'Sed',
  rscript: 'R',
  julia: 'Julia',
  groovy: 'Groovy',
  scala: 'Scala',
  swift: 'Swift',
  elixir: 'Elixir',
  escript: 'Erlang',
  pwsh: 'PowerShell',
  powershell: 'PowerShell',
  osascript: 'AppleScript',
  make: 'Makefile'
}

// ---------------------------------------------------------------------------
// Binary extensions
// ---------------------------------------------------------------------------

/**
 * Extensions whose contents are never usefully text. `countLines` still sniffs
 * the bytes — this table is the cheap pre-filter that lets the tree walk skip a
 * `cat-file` entirely for a 40 MB video.
 *
 * SVG is absent on purpose: it is XML, and diffing it is meaningful.
 */
const BINARY_EXT: ReadonlySet<string> = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'ico', 'icns', 'webp', 'avif',
  'heic', 'heif', 'psd', 'psb', 'ai', 'eps', 'xcf', 'sketch', 'fig', 'svgz', 'tga',
  'dds', 'exr', 'raw', 'cr2', 'nef',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'ttc', 'pfb', 'fon',
  // archives & packages
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz4', '7z', 'rar', 'lzma', 'cab',
  'jar', 'war', 'ear', 'aar', 'apk', 'ipa', 'whl', 'egg', 'deb', 'rpm', 'dmg', 'iso',
  'pkg', 'msi', 'nupkg', 'crx', 'xpi',
  // office & documents
  'doc', 'docx', 'docm', 'dot', 'dotx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'xlt',
  'ppt', 'pptx', 'pps', 'ppsx', 'pdf', 'odt', 'ods', 'odp', 'odg', 'pages',
  'numbers', 'key', 'vsd', 'vsdx', 'mpp', 'one', 'pub', 'epub', 'mobi', 'djvu',
  // audio & video
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aac', 'm4a', 'wma', 'aiff', 'mid',
  'midi', 'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'mpg', 'mpeg',
  '3gp', 'ogv',
  // compiled artefacts & object code
  'exe', 'dll', 'so', 'dylib', 'a', 'lib', 'o', 'obj', 'bin', 'elf', 'class',
  'pyc', 'pyo', 'pyd', 'beam', 'wasm', 'node', 'rlib', 'rmeta', 'pdb', 'ilk', 'nib',
  // datastores & columnar formats
  'db', 'sqlite', 'sqlite3', 'mdb', 'accdb', 'realm', 'parquet', 'avro', 'orc',
  'arrow', 'feather', 'npy', 'npz', 'pkl', 'pickle', 'h5', 'hdf5', 'mat', 'sav',
  'dta', 'rds', 'rdata',
  // 3D, game & misc binary payloads
  'blend', 'fbx', 'glb', 'stl', 'unity', 'uasset', 'pak', 'dat', 'pack',
  'idx', 'bundle', 'jks', 'keystore', 'p12', 'pfx', 'der'
])

/** True when the path's extension is one whose bytes are never text. */
export function isBinaryExtension(path: string): boolean {
  const ext = extensionOf(path)
  if (ext.length === 0) return false
  return BINARY_EXT.has(ext)
}

// ---------------------------------------------------------------------------
// Non-source languages
// ---------------------------------------------------------------------------

/**
 * Languages that exist in the table but are not "code". Used by `classify.ts`
 * as the final gate before a file is called source, and by the language chart
 * to keep prose and lockfiles out of the code totals.
 */
const NON_SOURCE_LANGUAGES: ReadonlySet<string> = new Set([
  'Markdown', 'MDX', 'reStructuredText', 'AsciiDoc', 'Org', 'Text', 'Rich Text',
  'BibTeX', 'R Markdown',
  'JSON', 'JSON5', 'JSON Lines', 'YAML', 'TOML', 'INI', 'Properties', 'XML',
  'CSV', 'TSV', 'EDN', 'Snapshot', 'Diff', 'Lock File', 'Parquet', 'PDF',
  'Dotenv', 'Ignore List', 'Git Config', 'Git Attributes', 'EditorConfig',
  'Marker', 'CODEOWNERS', 'Requirements', 'Go Checksums', 'SVG', 'Archive',
  'Jupyter Notebook', 'WebAssembly', 'HTTP Request'
])

/**
 * True when a language name denotes something a developer writes as code.
 * Markup that carries structure a human authored (HTML, CSS, templating
 * languages) counts; serialised data and prose do not.
 */
export function isSourceLanguage(language: string | null): boolean {
  if (language === null) return false
  return !NON_SOURCE_LANGUAGES.has(language)
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Reads a `#!` line out of the first bytes of a blob.
 *
 * Handles both `#!/bin/bash` and `#!/usr/bin/env -S python3 -u`: the last
 * non-flag token before any argument is the interpreter, and `env` is skipped.
 */
function fromShebang(head: Buffer): string | null {
  if (head.length < 3) return null
  // 0x23 '#', 0x21 '!'
  if (head[0] !== 0x23 || head[1] !== 0x21) return null

  let end = head.indexOf(0x0a)
  if (end === -1) end = Math.min(head.length, 256)
  if (end > 256) end = 256
  const line = head.toString('utf8', 2, end).trim()
  if (line.length === 0) return null

  const tokens = line.split(/\s+/)
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]
    if (raw === undefined || raw.length === 0) continue
    if (raw.startsWith('-')) continue
    // `KEY=value` assignments precede the interpreter under `env`.
    if (raw.includes('=')) continue
    const name = baseName(raw).toLowerCase()
    if (name === 'env') continue
    const hit = SHEBANG_LANGUAGE[name]
    if (hit !== undefined) return hit
    // An unrecognised first interpreter is not a licence to keep scanning its
    // arguments — `#!/usr/bin/myrunner script.foo` must not report "foo".
    return null
  }
  return null
}

/** Recognises the handful of magic prefixes worth the bytes. */
function fromMagic(head: Buffer): string | null {
  if (head.length < 5) return null
  const probe = head.toString('utf8', 0, Math.min(head.length, 64)).trimStart()
  const lower = probe.toLowerCase()
  if (lower.startsWith('<?php')) return 'PHP'
  if (lower.startsWith('<?xml')) return 'XML'
  if (lower.startsWith('<!doctype html')) return 'HTML'
  if (lower.startsWith('<html')) return 'HTML'
  return null
}

/**
 * Identifies the language of a file.
 *
 * `head` — the first few hundred bytes of the blob — is optional and only
 * consulted when the path carries no signal. Returns null when nothing is
 * recognised, which callers treat as "do not count this towards any language".
 */
export function detectLanguage(path: string, head?: Buffer): string | null {
  const norm = normalizePath(path)
  const base = baseName(norm)
  if (base.length === 0) return null
  const lower = base.toLowerCase()

  // 1. Exact filename. Highest confidence: these names are conventions, and a
  //    file called `Dockerfile` is a Dockerfile regardless of anything else.
  const byName = FILENAME_LANGUAGE[lower]
  if (byName !== undefined) return byName

  // 2. Conventional prefixes. `Dockerfile.dev`, `Makefile.am`, `.env.local`.
  if (lower.startsWith('dockerfile.') || lower.startsWith('containerfile.')) return 'Dockerfile'
  if (lower.startsWith('makefile.') || lower.startsWith('gnumakefile.')) return 'Makefile'
  if (lower.startsWith('.env.') || lower.startsWith('.env-')) return 'Dotenv'
  if (lower.startsWith('.eslintrc.') || lower.startsWith('.prettierrc.') || lower.startsWith('.stylelintrc.')) {
    const ext = extensionOf(lower)
    const byExt = EXT_LANGUAGE[ext]
    return byExt ?? 'JSON'
  }
  if (lower.startsWith('requirements') && lower.endsWith('.txt')) return 'Requirements'

  // 3. Compound extensions, before the single-extension table.
  for (const [suffix, lang] of COMPOUND_EXT) {
    if (lower.endsWith(suffix)) return lang
  }

  // 4. Single extension.
  const ext = extensionOf(lower)
  if (ext.length > 0) {
    const byExt = EXT_LANGUAGE[ext]
    if (byExt !== undefined) return byExt
  }

  // 5. Content. Only reached for unknown or absent extensions.
  if (head !== undefined && head.length > 0) {
    const bang = fromShebang(head)
    if (bang !== null) return bang
    const magic = fromMagic(head)
    if (magic !== null) return magic
  }

  return null
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * Every language name `detectLanguage` can return, sorted. The renderer uses
 * this to build a stable legend without having to see a repository first.
 */
export const KNOWN_LANGUAGES: readonly string[] = Object.freeze(
  Array.from(
    new Set<string>([
      ...Object.values(EXT_LANGUAGE),
      ...Object.values(FILENAME_LANGUAGE),
      ...COMPOUND_EXT.map(([, lang]) => lang),
      ...Object.values(SHEBANG_LANGUAGE)
    ])
  ).sort((a, b) => a.localeCompare(b, 'en'))
)

/** Exposed for tests and for classify.ts's source gate. */
export const __testing = { EXT_LANGUAGE, FILENAME_LANGUAGE, BINARY_EXT, NON_SOURCE_LANGUAGES }
