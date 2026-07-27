/**
 * Line counting and text/binary detection.
 *
 * This is the hottest code in the analyzer. A 180-snapshot backfill of a
 * mid-size repository puts tens of thousands of blobs through `countLines`, so
 * everything here works on the Buffer directly: no `toString()`, no `split`, no
 * per-line allocation. The only strings this module ever creates are the
 * comment delimiters, encoded once at module load.
 *
 * Accuracy target is cloc's, not a compiler's. Comment state is tracked across
 * lines and string literals are skipped so that `const s = "/*"` does not open
 * a comment, but no attempt is made to understand raw strings, nested block
 * comments, or heredocs. Those cost a real lexer per language and would move
 * the aggregate numbers by well under a percent.
 *
 * `codeLines` is null whenever VDE has no defensible comment grammar for the
 * language. Null propagates: a signal that cannot be computed honestly is not
 * computed at all.
 */

// ---------------------------------------------------------------------------
// Byte constants
// ---------------------------------------------------------------------------

const NUL = 0
const BACKSPACE = 8
const TAB = 9
const LF = 10
const VT = 11
const FF = 12
const CR = 13
const SP = 32
const DEL = 127
const BACKSLASH = 92

/** Bytes examined when deciding whether a blob is binary. */
const BINARY_WINDOW = 8000

/** Above this share of control bytes in the window, the blob is not text. */
const NON_PRINTABLE_RATIO = 0.3

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

/**
 * True when a blob's opening bytes look like something other than text.
 *
 * Two tests, both applied to the first 8 KB:
 *   - any NUL byte, which no text encoding VDE cares about ever emits; and
 *   - more than 30% C0 control characters or DEL.
 *
 * Bytes at or above 0x80 are treated as printable. They are UTF-8 continuation
 * bytes far more often than they are binary noise, and counting them would
 * declare every CJK or emoji-bearing document binary.
 */
export function isBinaryBuffer(buf: Buffer): boolean {
  const win = buf.length < BINARY_WINDOW ? buf.length : BINARY_WINDOW
  if (win === 0) return false
  let nonPrintable = 0
  for (let i = 0; i < win; i++) {
    // Safe: i is bounded by win, which is bounded by buf.length.
    const b = buf[i]!
    if (b === NUL) return true
    if (b < TAB || (b > CR && b < SP) || b === DEL || b === BACKSPACE) nonPrintable++
  }
  return nonPrintable > win * NON_PRINTABLE_RATIO
}

// ---------------------------------------------------------------------------
// Comment grammars
// ---------------------------------------------------------------------------

interface SyntaxSpec {
  /** Tokens that comment out the rest of the line. */
  line?: readonly string[]
  /** Paired block delimiters. Python's docstrings are modelled as one of these. */
  block?: ReadonlyArray<readonly [string, string]>
  /** Characters that open a string literal, as a single string of chars. */
  quotes?: string
  /** Whether a backslash escapes the next character inside a string. */
  escape?: boolean
  /** Recognise block openers only as the first non-blank token on a line. */
  blockAtIndentOnly?: boolean
}

interface CommentSyntax {
  readonly lineTokens: readonly Uint8Array[]
  readonly blockOpen: readonly Uint8Array[]
  readonly blockClose: readonly Uint8Array[]
  readonly quotes: readonly number[]
  readonly escape: boolean
  readonly blockAtIndentOnly: boolean
  /**
   * 256-entry lookup: 1 when the byte can begin a comment token or a string.
   * This is what keeps the scanner at one array read per ordinary character
   * instead of one substring comparison per delimiter per character.
   */
  readonly triggers: Uint8Array
}

function encodeToken(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function compile(spec: SyntaxSpec): CommentSyntax {
  // Longest delimiter first, so `#=` wins over `#` and `--[[` over `--`.
  const lineTokens = [...(spec.line ?? [])].sort((a, b) => b.length - a.length).map(encodeToken)
  const blocks = [...(spec.block ?? [])].sort((a, b) => b[0].length - a[0].length)
  const blockOpen = blocks.map(([o]) => encodeToken(o))
  const blockClose = blocks.map(([, c]) => encodeToken(c))
  const quotes: number[] = []
  for (const ch of spec.quotes ?? '') quotes.push(ch.charCodeAt(0))

  const triggers = new Uint8Array(256)
  for (const t of lineTokens) {
    const first = t[0]
    if (first !== undefined) triggers[first] = 1
  }
  for (const o of blockOpen) {
    const first = o[0]
    if (first !== undefined) triggers[first] = 1
  }
  for (const q of quotes) triggers[q] = 1

  return {
    lineTokens,
    blockOpen,
    blockClose,
    quotes,
    escape: spec.escape ?? true,
    blockAtIndentOnly: spec.blockAtIndentOnly ?? false,
    triggers
  }
}

// --- Families ---------------------------------------------------------------
//
// `quotes` is narrowed to '"' for languages whose apostrophe means something
// else: Rust lifetimes, Haskell/OCaml primes, Lisp quoting, Elixir charlists.
// Treating those as string openers would swallow the rest of the line.

const C_LIKE: SyntaxSpec = { line: ['//'], block: [['/*', '*/']], quotes: '"\'' }
const JS_LIKE: SyntaxSpec = { line: ['//'], block: [['/*', '*/']], quotes: '"\'`' }
const C_NO_APOSTROPHE: SyntaxSpec = { line: ['//'], block: [['/*', '*/']], quotes: '"' }
const SLASH_ONLY: SyntaxSpec = { line: ['//'], quotes: '"' }
const BLOCK_ONLY: SyntaxSpec = { block: [['/*', '*/']], quotes: '"\'' }
const HASH: SyntaxSpec = { line: ['#'], quotes: '"\'' }
const HASH_DOUBLE_ONLY: SyntaxSpec = { line: ['#'], quotes: '"' }
const HASH_PLAIN: SyntaxSpec = { line: ['#'] }
const PYTHON: SyntaxSpec = {
  line: ['#'],
  block: [
    ['"""', '"""'],
    ["'''", "'''"]
  ],
  quotes: '"\''
}
const RUBY: SyntaxSpec = {
  line: ['#'],
  block: [['=begin', '=end']],
  quotes: '"\'',
  blockAtIndentOnly: true
}
const SQL_LIKE: SyntaxSpec = { line: ['--'], block: [['/*', '*/']], quotes: '"\'' }
const LUA: SyntaxSpec = { line: ['--'], block: [['--[[', ']]']], quotes: '"\'' }
const HASKELL: SyntaxSpec = { line: ['--'], block: [['{-', '-}']], quotes: '"' }
const DASH_ONLY: SyntaxSpec = { line: ['--'], quotes: '"' }
const SEMICOLON: SyntaxSpec = { line: [';'], quotes: '"' }
const PERCENT: SyntaxSpec = { line: ['%'], quotes: '"' }
const MATLAB: SyntaxSpec = { line: ['%'], block: [['%{', '%}']], quotes: '"\'' }
const ML_LIKE: SyntaxSpec = { block: [['(*', '*)']], quotes: '"' }
const FSHARP: SyntaxSpec = { line: ['//'], block: [['(*', '*)']], quotes: '"' }
const MARKUP: SyntaxSpec = { block: [['<!--', '-->']] }
/** HTML with an embedded script/style island — `//` is only honoured line-initially. */
const WEB_COMPONENT: SyntaxSpec = {
  line: ['//'],
  block: [
    ['<!--', '-->'],
    ['/*', '*/']
  ]
}
const POWERSHELL: SyntaxSpec = { line: ['#'], block: [['<#', '#>']], quotes: '"\'' }
const JULIA: SyntaxSpec = { line: ['#'], block: [['#=', '=#']], quotes: '"' }
const NIM: SyntaxSpec = { line: ['#'], block: [['#[', ']#']], quotes: '"' }
const HCL: SyntaxSpec = { line: ['#', '//'], block: [['/*', '*/']], quotes: '"' }
const NIX: SyntaxSpec = { line: ['#'], block: [['/*', '*/']], quotes: '"' }
const BATCH: SyntaxSpec = { line: ['::', 'REM ', 'rem '], quotes: '"' }
const JINJA: SyntaxSpec = { block: [['{#', '#}']] }
const ERB: SyntaxSpec = {
  block: [
    ['<!--', '-->'],
    ['<%#', '%>']
  ]
}
const TWIG: SyntaxSpec = { block: [['{#', '#}']] }
const FORTRAN: SyntaxSpec = { line: ['!'], quotes: '"\'' }
const VB: SyntaxSpec = { line: ["'"], quotes: '"' }
const COBOL: SyntaxSpec = { line: ['*>'], quotes: '"\'' }
const CLOJURE: SyntaxSpec = { line: [';'], quotes: '"' }
const MDX: SyntaxSpec = {
  block: [
    ['<!--', '-->'],
    ['{/*', '*/}']
  ]
}
/** No comment grammar at all: every non-blank line is code. */
const NO_COMMENTS: SyntaxSpec = {}

/**
 * Language name → grammar. A language absent from this table yields a null
 * `codeLines` rather than a guess.
 */
const SYNTAX_SPECS: Record<string, SyntaxSpec> = {
  // JavaScript / TypeScript
  TypeScript: JS_LIKE,
  'TypeScript Declaration': JS_LIKE,
  TSX: JS_LIKE,
  JavaScript: JS_LIKE,
  JSX: JS_LIKE,
  JSON5: JS_LIKE,
  CoffeeScript: HASH,
  // Web
  HTML: MARKUP,
  Vue: WEB_COMPONENT,
  Svelte: WEB_COMPONENT,
  Astro: WEB_COMPONENT,
  CSS: BLOCK_ONLY,
  SCSS: JS_LIKE,
  Sass: JS_LIKE,
  Less: JS_LIKE,
  Stylus: JS_LIKE,
  Handlebars: { block: [['{{!', '}}']] },
  Mustache: { block: [['{{!', '}}']] },
  EJS: { block: [['<%#', '%>']] },
  Pug: DASH_ONLY,
  Liquid: { block: [['{% comment %}', '{% endcomment %}']] },
  Twig: TWIG,
  Jinja: JINJA,
  ERB: ERB,
  MDX: MDX,
  // Python family
  Python: PYTHON,
  Cython: PYTHON,
  // Systems
  Go: C_LIKE,
  'Go Module': SLASH_ONLY,
  Rust: C_NO_APOSTROPHE,
  Zig: SLASH_ONLY,
  C: C_LIKE,
  'C/C++ Header': C_LIKE,
  'C++': C_LIKE,
  'C++ Header': C_LIKE,
  'Objective-C': C_LIKE,
  'Objective-C++': C_LIKE,
  D: C_LIKE,
  Nim: NIM,
  Odin: C_LIKE,
  Crystal: HASH,
  Vala: C_LIKE,
  Haxe: C_LIKE,
  Assembly: SEMICOLON,
  'WebAssembly Text': SEMICOLON,
  // JVM / .NET
  Java: C_LIKE,
  Kotlin: C_LIKE,
  Scala: C_LIKE,
  Groovy: C_LIKE,
  Gradle: C_LIKE,
  Clojure: CLOJURE,
  ClojureScript: CLOJURE,
  EDN: CLOJURE,
  'C#': C_LIKE,
  'F#': FSHARP,
  'Visual Basic': VB,
  // Mobile
  Swift: C_LIKE,
  Dart: C_LIKE,
  // Scripting
  Ruby: RUBY,
  PHP: { line: ['//', '#'], block: [['/*', '*/']], quotes: '"\'' },
  Perl: HASH,
  Lua: LUA,
  Tcl: HASH,
  Awk: HASH,
  Sed: HASH_PLAIN,
  Shell: HASH,
  Fish: HASH,
  Nushell: HASH,
  PowerShell: POWERSHELL,
  Batch: BATCH,
  AppleScript: { line: ['--', '#'], block: [['(*', '*)']], quotes: '"' },
  // Functional
  Haskell: HASKELL,
  Elm: HASKELL,
  PureScript: HASKELL,
  ReScript: C_NO_APOSTROPHE,
  OCaml: ML_LIKE,
  ReasonML: C_NO_APOSTROPHE,
  Elixir: HASH_DOUBLE_ONLY,
  Erlang: PERCENT,
  Gleam: SLASH_ONLY,
  'Common Lisp': SEMICOLON,
  'Emacs Lisp': SEMICOLON,
  Scheme: SEMICOLON,
  Racket: SEMICOLON,
  // Data & scientific
  R: HASH,
  Julia: JULIA,
  SQL: SQL_LIKE,
  PRQL: HASH,
  // Hardware & legacy
  Verilog: C_LIKE,
  SystemVerilog: C_LIKE,
  VHDL: DASH_ONLY,
  Fortran: FORTRAN,
  Ada: DASH_ONLY,
  COBOL: COBOL,
  Pascal: { block: [['(*', '*)'], ['{', '}']], line: ['//'], quotes: "'" },
  MATLAB: MATLAB,
  // Blockchain
  Solidity: C_LIKE,
  Cairo: HASH,
  Move: C_LIKE,
  // Schema & IDL
  'Protocol Buffers': C_LIKE,
  GraphQL: HASH_DOUBLE_ONLY,
  Thrift: C_LIKE,
  Graphviz: { line: ['//', '#'], block: [['/*', '*/']], quotes: '"' },
  'Avro IDL': C_LIKE,
  "Cap'n Proto": HASH_DOUBLE_ONLY,
  // Infrastructure
  Terraform: HCL,
  HCL: HCL,
  Bicep: SLASH_ONLY,
  Nix: NIX,
  Puppet: HASH,
  Starlark: PYTHON,
  CMake: HASH,
  Makefile: HASH_PLAIN,
  Just: HASH_PLAIN,
  Meson: HASH,
  Dockerfile: HASH_PLAIN,
  // Markup & docs
  Markdown: MARKUP,
  'R Markdown': MARKUP,
  // rST's comment form is an indented block after `..`, which needs indentation
  // tracking to read correctly. Counting every non-blank line is the honest
  // approximation rather than a grammar that is wrong in both directions.
  reStructuredText: NO_COMMENTS,
  AsciiDoc: { line: ['//'], block: [['////', '////']] },
  Org: HASH_PLAIN,
  TeX: PERCENT,
  BibTeX: PERCENT,
  // Config & data
  JSON: NO_COMMENTS,
  YAML: HASH_PLAIN,
  TOML: HASH_PLAIN,
  INI: { line: [';', '#'], quotes: '"' },
  Properties: { line: ['#', '!'] },
  XML: MARKUP,
  XSLT: MARKUP,
  SVG: MARKUP,
  Dotenv: HASH_PLAIN,
  'Ignore List': HASH_PLAIN,
  'Git Config': { line: [';', '#'] },
  'Git Attributes': HASH_PLAIN,
  EditorConfig: HASH_PLAIN,
  Requirements: HASH_PLAIN,
  CODEOWNERS: HASH_PLAIN,
  'HTTP Request': HASH_PLAIN
}

/** Compiled grammars, built on first use. */
const SYNTAX_CACHE = new Map<string, CommentSyntax | null>()

function syntaxFor(language: string): CommentSyntax | null {
  const hit = SYNTAX_CACHE.get(language)
  if (hit !== undefined) return hit
  const spec = SYNTAX_SPECS[language]
  const compiled = spec === undefined ? null : compile(spec)
  SYNTAX_CACHE.set(language, compiled)
  return compiled
}

/** True when VDE can count code lines for this language. */
export function hasCommentSyntax(language: string | null): boolean {
  return language !== null && SYNTAX_SPECS[language] !== undefined
}

// ---------------------------------------------------------------------------
// Byte-level scanning primitives
// ---------------------------------------------------------------------------

/** First index in [from, end) at which `needle` occurs wholly before `end`. */
function indexOfBytes(buf: Buffer, needle: Uint8Array, from: number, end: number): number {
  const nl = needle.length
  if (nl === 0) return -1
  const first = needle[0]
  const last = end - nl
  for (let i = from; i <= last; i++) {
    if (buf[i] !== first) continue
    let k = 1
    while (k < nl && buf[i + k] === needle[k]) k++
    if (k === nl) return i
  }
  return -1
}

function startsWithAt(buf: Buffer, needle: Uint8Array, i: number, end: number): boolean {
  const nl = needle.length
  if (i + nl > end) return false
  for (let k = 0; k < nl; k++) {
    if (buf[i + k] !== needle[k]) return false
  }
  return true
}

/**
 * Returns the index just past the closing quote, or `end` when the literal is
 * unterminated on this line. Multi-line strings therefore consume the rest of
 * the line and no more, which keeps a heredoc from corrupting the whole file's
 * count.
 */
function skipString(buf: Buffer, i: number, end: number, quote: number, escape: boolean): number {
  let j = i + 1
  while (j < end) {
    const b = buf[j]
    if (escape && b === BACKSLASH) {
      j += 2
      continue
    }
    if (b === quote) return j + 1
    j++
  }
  return end
}

/**
 * Classifies one line and returns the carried block state, packed into a single
 * integer so the hot loop allocates nothing:
 *
 *   bit 0        1 when the line contains code
 *   bits 1..n    (block index + 1); 0 means "not inside a block comment"
 */
function scanLine(buf: Buffer, start: number, end: number, syn: CommentSyntax, inBlock: number): number {
  const { triggers, blockOpen, blockClose, lineTokens, quotes, escape, blockAtIndentOnly } = syn
  /**
   * With no block delimiters there is no state to carry across lines, so the
   * verdict is settled by the first non-blank token and the rest of the line
   * need never be read. Roughly half the grammars here — YAML, TOML, Shell,
   * Makefile, JSON, Dockerfile — take this path.
   */
  const noBlocks = blockOpen.length === 0
  let i = start
  let block = inBlock
  let sawCode = false
  let atIndent = true

  while (i < end) {
    if (block >= 0) {
      const close = blockClose[block]
      if (close === undefined) {
        // Defensive: `block` only ever comes from an index into blockOpen,
        // which is the same length as blockClose.
        block = -1
        continue
      }
      const idx = indexOfBytes(buf, close, i, end)
      if (idx === -1) return ((block + 1) << 1) | (sawCode ? 1 : 0)
      i = idx + close.length
      block = -1
      atIndent = false
      continue
    }

    const b = buf[i]
    if (b === undefined) break
    if (b === SP || b === TAB || b === CR || b === FF || b === VT) {
      i++
      continue
    }

    if (triggers[b] === 1) {
      // Block openers are tested first: `#=` must beat `#` in Julia and `--[[`
      // must beat `--` in Lua.
      if (!blockAtIndentOnly || atIndent) {
        let opened = -1
        for (let k = 0; k < blockOpen.length; k++) {
          const open = blockOpen[k]
          if (open !== undefined && startsWithAt(buf, open, i, end)) {
            opened = k
            i += open.length
            break
          }
        }
        if (opened !== -1) {
          block = opened
          atIndent = false
          continue
        }
      }

      let isLineComment = false
      for (const t of lineTokens) {
        if (startsWithAt(buf, t, i, end)) {
          isLineComment = true
          break
        }
      }
      // Everything after a line-comment token is commentary; whether the line
      // counts as code was already decided by what preceded it.
      if (isLineComment) return sawCode ? 1 : 0

      let quoted = false
      for (let k = 0; k < quotes.length; k++) {
        if (quotes[k] === b) {
          i = skipString(buf, i, end, b, escape)
          quoted = true
          break
        }
      }
      if (quoted) {
        if (noBlocks) return 1
        sawCode = true
        atIndent = false
        continue
      }
    }

    if (noBlocks) return 1
    sawCode = true
    atIndent = false
    i++
  }

  return ((block + 1) << 1) | (sawCode ? 1 : 0)
}

// ---------------------------------------------------------------------------
// The public counter
// ---------------------------------------------------------------------------

export interface LineCounts {
  /** Newline-terminated lines, plus one when the file lacks a final newline. */
  lines: number
  /** Lines that are neither blank nor entirely comment. Null when unknown. */
  codeLines: number | null
  binary: boolean
}

/**
 * Counts lines in a blob.
 *
 * Binary blobs short-circuit: `lines` is 0 and `codeLines` null, because a line
 * count over compressed bytes is noise that would then be summed into the
 * repository totals.
 */
export function countLines(buf: Buffer, language: string | null): LineCounts {
  const len = buf.length
  const syn = language === null ? null : syntaxFor(language)

  if (len === 0) return { lines: 0, codeLines: syn === null ? null : 0, binary: false }
  if (isBinaryBuffer(buf)) return { lines: 0, codeLines: null, binary: true }

  let lines = 0
  let codeLines = 0
  let block = -1
  let pos = 0

  while (pos < len) {
    // `indexOf` on a byte value uses the native memchr path — materially faster
    // than stepping the buffer in JS, and this loop runs once per line of every
    // blob in the repository's history.
    const nl = buf.indexOf(LF, pos)
    const lineEnd = nl === -1 ? len : nl
    lines++

    if (syn !== null) {
      // Strip a CRLF's carriage return so it is not mistaken for content.
      const end = lineEnd > pos && buf[lineEnd - 1] === CR ? lineEnd - 1 : lineEnd
      const packed = scanLine(buf, pos, end, syn, block)
      block = (packed >> 1) - 1
      if ((packed & 1) === 1) codeLines++
    }

    if (nl === -1) break
    pos = nl + 1
  }

  return { lines, codeLines: syn === null ? null : codeLines, binary: false }
}

/** Exposed for tests. */
export const __testing = { syntaxFor, scanLine, indexOfBytes, SYNTAX_SPECS }
