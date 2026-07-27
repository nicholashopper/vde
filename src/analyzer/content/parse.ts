/**
 * Structural analysis of source blobs, via tree-sitter compiled to WebAssembly.
 *
 * VDE needs three numbers out of a source file that no line count can give it:
 * how many functions it defines, how branchy those functions are, and how many
 * of them have grown past the point a human will comfortably review. Agent-
 * written code is characteristically *wide* — many shallow functions — right up
 * until it isn't, and a single 400-line `handleRequest` with a cyclomatic
 * complexity of 60 appears. That transition is the complexityDrift signal.
 *
 * This module owns the whole tree-sitter surface. Nothing else in VDE imports
 * web-tree-sitter.
 *
 * ---------------------------------------------------------------------------
 * Deviation from the module brief, stated up front
 * ---------------------------------------------------------------------------
 * `analyzeSource` is **async**. The brief asks for lazy per-language grammar
 * loading *and* shows a synchronous return type; those cannot both hold, because
 * `Language.load` is asynchronous. Lazy loading is the requirement with teeth —
 * eagerly loading all 33 usable grammars costs hundreds of megabytes of wasm
 * heap in a process that typically needs four of them — so the return type gives
 * way. Callers must `await`. TypeScript makes forgetting this a compile error
 * rather than a silent wrong answer.
 *
 * ---------------------------------------------------------------------------
 * Two environmental hazards this module works around
 * ---------------------------------------------------------------------------
 * 1. **Legacy `dylink` sections.** The grammars in tree-sitter-wasms@0.1.13 were
 *    built with an Emscripten old enough to emit the pre-standard `dylink`
 *    custom section. web-tree-sitter@0.26 only accepts the `dylink.0` form and
 *    rejects everything else with a bare `Error()`. `upgradeDylinkSection`
 *    rewrites the section header in memory. See the function for the format
 *    details; without it *zero* grammars load.
 *
 * 2. **Quarantined grammars.** Four of the 36 shipped grammars cannot be used:
 *    `elm` (ABI 12) and `ql` (ABI 10) predate web-tree-sitter 0.26's minimum of
 *    13; `yaml`'s external scanner imports a symbol the 0.26 runtime no longer
 *    provides; and `swift` reliably kills the host process — V8's background
 *    wasm tier-up compiler fatal-OOMs on its lexer function. The first three
 *    fail catchably and would be negative-cached anyway. `swift` must be refused
 *    *before* it is parsed: the abort happens on a V8 compiler thread and no
 *    try/catch can intercept it.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Language, Parser } from 'web-tree-sitter'
import type { Tree } from 'web-tree-sitter'

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * What one parsed blob yields. Maps 1:1 onto the non-null form of the
 * corresponding fields on `BlobAnalysis` in ../model.
 */
export interface StructuralAnalysis {
  /** Function, method and closure definitions with a body. */
  functions: number
  /** Sum of cyclomatic complexity over those functions. */
  totalComplexity: number
  /** The single highest function complexity, or 0 when there are no functions. */
  maxComplexity: number
  /** Functions whose complexity exceeds {@link COMPLEX_FUNCTION_THRESHOLD}. */
  complexFunctions: number
}

export interface InitOptions {
  /**
   * Explicit path to web-tree-sitter's own runtime `web-tree-sitter.wasm`. When
   * omitted it is discovered next to the grammars, then via package resolution.
   */
  runtimeWasmPath?: string
  /**
   * Wall-clock budget for a single `parse` call. Tree-sitter's error recovery is
   * superlinear on some adversarial inputs; this bounds the damage one file can
   * do to a scan.
   */
  parseTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Above this, a function is "complex" — the threshold the brief fixes at 10. */
export const COMPLEX_FUNCTION_THRESHOLD = 10

/**
 * Blobs larger than this are not parsed. Minified bundles, generated protobuf
 * stubs and checked-in data files are all common in vibecoded repositories, and
 * none of them produce a meaningful complexity number. Measured in UTF-16 code
 * units, which is what actually bounds the decoded string in memory.
 */
export const MAX_PARSE_CHARS = 2 * 1024 * 1024

const DEFAULT_PARSE_TIMEOUT_MS = 5_000

/**
 * Cap on distinct grammars held in the wasm heap at once. Each is a side module
 * costing single-digit to low-tens of megabytes and web-tree-sitter offers no
 * way to unload one. A repository using more than twenty languages is using the
 * twenty-first for a handful of files.
 */
const MAX_LOADED_GRAMMARS = 20

/** Grammars that must never be loaded. See the header for the reasoning. */
const QUARANTINED_GRAMMARS: ReadonlySet<string> = new Set([
  'elm', // ABI 12, below web-tree-sitter 0.26's minimum of 13
  'ql', // ABI 10, likewise
  'yaml', // external scanner imports an unresolvable symbol under 0.26
  'swift' // fatal-OOMs V8's background wasm compiler; uncatchable
])

// ---------------------------------------------------------------------------
// Per-language node-type profiles
// ---------------------------------------------------------------------------

/**
 * How to recognise functions and decision points in one grammar.
 *
 * Named and anonymous node types are kept apart because several grammars use the
 * same string for both. tree-sitter-ruby, for instance, has a *named* rule `when`
 * whose first child is the *anonymous* keyword token `when`; counting node type
 * alone would double every Ruby case arm. Anonymous types are also where the
 * boolean operators live — `&&` and `||` are tokens inside `binary_expression`,
 * not nodes of their own.
 */
interface LanguageProfile {
  /** Named node types that open a new function scope. */
  functionNodes: ReadonlySet<string>
  /** Named node types that add a branch. */
  decisionNodes: ReadonlySet<string>
  /** Anonymous token types that add a branch. */
  decisionTokens: ReadonlySet<string>
}

function profile(fns: readonly string[], nodes: readonly string[], tokens: readonly string[]): LanguageProfile {
  return {
    functionNodes: new Set(fns),
    decisionNodes: new Set(nodes),
    decisionTokens: new Set(tokens)
  }
}

/**
 * The boolean operators, in the grammars that spell them with symbols.
 *
 * `??` is deliberately absent. Nullish coalescing is a defaulting idiom, not a
 * control-flow branch, and agent-written TypeScript is dense with it; counting
 * it would make `complexityDrift` fire on defensive style rather than on
 * genuinely tangled logic. Optional chaining (`?.`, node type `optional_chain`)
 * is excluded for the same reason and because the brief says so explicitly.
 */
const SYMBOLIC_BOOLEAN_OPS = ['&&', '||'] as const

/**
 * ECMAScript-family decision nodes, shared by javascript, typescript and tsx.
 *
 * `else_clause` is absent on purpose: an `else` alone adds no path, and `else if`
 * nests a second `if_statement` inside the clause, so plain `if_statement` counts
 * both arms correctly. `switch_case` is counted but `switch_default` is not — a
 * default arm is the fall-through, not a decision. `for_in_statement` covers both
 * `for...in` and `for...of` in these grammars.
 */
const JS_DECISION_NODES = [
  'if_statement',
  'ternary_expression',
  'switch_case',
  'catch_clause',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement'
] as const

const JS_FUNCTION_NODES = [
  'function_declaration',
  'function_expression',
  'generator_function',
  'generator_function_declaration',
  'arrow_function',
  'method_definition'
  // `function_signature` and `abstract_method_signature` are declarations with
  // no body; they contribute no complexity and would inflate the function count.
] as const

/**
 * Node-type names verified against the actual grammar binaries in
 * tree-sitter-wasms@0.1.13 by parsing a construct-covering sample of each
 * language and dumping the resulting type set — not from memory, because these
 * names drift between grammar releases.
 */
const PROFILES: ReadonlyMap<string, LanguageProfile> = new Map<string, LanguageProfile>([
  ['javascript', profile(JS_FUNCTION_NODES, JS_DECISION_NODES, SYMBOLIC_BOOLEAN_OPS)],
  ['typescript', profile(JS_FUNCTION_NODES, JS_DECISION_NODES, SYMBOLIC_BOOLEAN_OPS)],
  ['tsx', profile(JS_FUNCTION_NODES, JS_DECISION_NODES, SYMBOLIC_BOOLEAN_OPS)],

  [
    'python',
    profile(
      ['function_definition', 'lambda'],
      [
        'if_statement',
        'elif_clause', // Python's grammar models elif as a clause, not a nested if
        'conditional_expression',
        'for_statement',
        'while_statement',
        'except_clause',
        'case_clause', // structural pattern matching
        'for_in_clause', // comprehension generator
        'if_clause' // comprehension filter
      ],
      ['and', 'or'] // keyword operators inside boolean_operator
    )
  ],

  [
    'go',
    profile(
      ['function_declaration', 'method_declaration', 'func_literal'],
      [
        'if_statement',
        'for_statement',
        'expression_case',
        'type_case',
        'communication_case'
        // `default_case` excluded: it is the fall-through arm.
      ],
      SYMBOLIC_BOOLEAN_OPS
    )
  ],

  [
    'rust',
    profile(
      ['function_item', 'closure_expression'], // not function_signature_item: no body
      [
        'if_expression', // also covers `if let`
        'while_expression', // also covers `while let`
        'for_expression',
        'loop_expression',
        'match_arm'
        // `try_expression` (the `?` operator) is an early return, not a branch
        // the reader has to reason about; excluded to match the brief's list.
      ],
      SYMBOLIC_BOOLEAN_OPS
    )
  ],

  [
    'java',
    profile(
      ['method_declaration', 'constructor_declaration', 'compact_constructor_declaration', 'lambda_expression'],
      ['if_statement', 'ternary_expression', 'for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement', 'catch_clause'],
      // tree-sitter-java's `switch_label` matches `default:` as well as `case X:`,
      // so the anonymous `case` keyword is the precise marker. It also correctly
      // picks up the arrow form used by switch expressions.
      [...SYMBOLIC_BOOLEAN_OPS, 'case']
    )
  ],

  [
    'c',
    profile(
      ['function_definition'],
      ['if_statement', 'conditional_expression', 'for_statement', 'while_statement', 'do_statement'],
      // As in Java, `case_statement` also matches `default:`.
      [...SYMBOLIC_BOOLEAN_OPS, 'case']
    )
  ],

  [
    'cpp',
    profile(
      ['function_definition', 'lambda_expression'],
      [
        'if_statement',
        'conditional_expression',
        'for_statement',
        'for_range_loop',
        'while_statement',
        'do_statement',
        'catch_clause'
      ],
      [...SYMBOLIC_BOOLEAN_OPS, 'case']
    )
  ],

  [
    'c_sharp',
    profile(
      [
        'method_declaration',
        'constructor_declaration',
        'destructor_declaration',
        'operator_declaration',
        'conversion_operator_declaration',
        'local_function_statement',
        'lambda_expression',
        'anonymous_method_expression',
        'accessor_declaration' // property get/set bodies are real functions
      ],
      [
        'if_statement',
        'conditional_expression',
        'for_statement',
        'for_each_statement',
        'while_statement',
        'do_statement',
        'catch_clause',
        'case_switch_label', // distinct from default_switch_label in this grammar
        'case_pattern_switch_label',
        'switch_expression_arm'
      ],
      SYMBOLIC_BOOLEAN_OPS
    )
  ],

  [
    'ruby',
    profile(
      // Blocks are intentionally *not* functions here. `items.each { ... }` is a
      // loop wearing a closure's clothes, and treating it as a separate function
      // would drain complexity out of the method that actually owns it and make
      // god-methods read as trivial. RuboCop's CyclomaticComplexity cop makes the
      // same call: a block is +1 on its enclosing method.
      ['method', 'singleton_method'],
      [
        'if',
        'if_modifier',
        'unless',
        'unless_modifier',
        'elsif',
        'while',
        'while_modifier',
        'until',
        'until_modifier',
        'for',
        'when',
        'in_clause',
        'rescue',
        'rescue_modifier',
        'conditional',
        'block',
        'do_block'
      ],
      SYMBOLIC_BOOLEAN_OPS
    )
  ],

  [
    'php',
    profile(
      [
        'function_definition',
        'method_declaration',
        'anonymous_function_creation_expression',
        'anonymous_function',
        'arrow_function'
      ],
      [
        'if_statement',
        'else_if_clause',
        'conditional_expression',
        'for_statement',
        'foreach_statement',
        'while_statement',
        'do_statement',
        'catch_clause',
        'case_statement', // distinct from default_statement in this grammar
        'match_conditional_expression' // distinct from match_default_expression
      ],
      [...SYMBOLIC_BOOLEAN_OPS, 'and', 'or']
    )
  ]
])

/**
 * Fallback for the twenty-odd grammars without a hand-tuned profile.
 *
 * The names below are the union of the conventions tree-sitter grammar authors
 * actually use, checked against live parses of kotlin, scala, lua, elixir, zig,
 * dart and solidity. It will miss language-specific constructs — Elixir's `cond`
 * is an ordinary `call` node and is invisible here — so it under-reports rather
 * than inventing complexity, which is the right direction to be wrong in.
 */
const GENERIC_PROFILE: LanguageProfile = profile(
  [
    'function_definition',
    'function_definition_statement',
    'function_declaration',
    'function_expression',
    'function_item',
    'method_declaration',
    'method_definition',
    'constructor_declaration',
    'init_declaration',
    'local_function_statement',
    'arrow_function',
    'lambda',
    'lambda_expression',
    'lambda_literal',
    'closure_expression',
    'anonymous_function',
    'anonymous_function_creation_expression',
    'func_literal',
    'method',
    'singleton_method'
  ],
  [
    'if_statement',
    'if_expression',
    'if_clause',
    'elif_clause',
    'else_if_clause',
    'elseif_clause',
    'elsif',
    'conditional_expression',
    'ternary_expression',
    'guard_statement',
    'for_statement',
    'for_expression',
    'for_in_statement',
    'for_in_clause',
    'for_range_loop',
    'for_generic_statement',
    'for_numeric_statement',
    'foreach_statement',
    'enhanced_for_statement',
    'while_statement',
    'while_expression',
    'do_statement',
    'do_while_statement',
    'loop_expression',
    'repeat_statement',
    'repeat_while_statement',
    'until_statement',
    'catch_clause',
    'catch_block',
    'except_clause',
    'rescue',
    'switch_case',
    'switch_entry',
    'case_statement',
    'case_clause',
    'when_entry',
    'match_arm',
    'switch_expression_arm',
    'expression_case',
    'type_case',
    'communication_case'
  ],
  [...SYMBOLIC_BOOLEAN_OPS, 'and', 'or']
)

// ---------------------------------------------------------------------------
// Language-name resolution
// ---------------------------------------------------------------------------

/**
 * Display names and extensions mapped onto grammar file basenames.
 *
 * The classifier upstream of this module may hand us anything from `"TypeScript"`
 * to `"ts"` to `"c++"`, so the mapping is generous. Lookup is
 * case-insensitive and only consulted when the name is not already a grammar
 * basename.
 */
const LANGUAGE_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  ['ts', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['jsx', 'javascript'],
  ['node', 'javascript'],
  ['ecmascript', 'javascript'],
  ['py', 'python'],
  ['python3', 'python'],
  ['golang', 'go'],
  ['rs', 'rust'],
  ['rb', 'ruby'],
  ['c++', 'cpp'],
  ['cxx', 'cpp'],
  ['cc', 'cpp'],
  ['hpp', 'cpp'],
  ['objective-c++', 'cpp'],
  ['h', 'c'],
  ['c#', 'c_sharp'],
  ['csharp', 'c_sharp'],
  ['cs', 'c_sharp'],
  ['objective-c', 'objc'],
  ['objectivec', 'objc'],
  ['m', 'objc'],
  ['sh', 'bash'],
  ['shell', 'bash'],
  ['zsh', 'bash'],
  ['shellscript', 'bash'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['ex', 'elixir'],
  ['exs', 'elixir'],
  ['erb', 'embedded_template'],
  ['ejs', 'embedded_template'],
  ['scss', 'css'],
  ['sass', 'css'],
  ['less', 'css'],
  ['htm', 'html'],
  ['yml', 'yaml'],
  ['emacs-lisp', 'elisp'],
  ['el', 'elisp'],
  ['ml', 'ocaml'],
  ['res', 'rescript'],
  ['sol', 'solidity'],
  ['tla', 'tlaplus'],
  ['jsonc', 'json'],
  ['json5', 'json']
])

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

interface RuntimeState {
  grammarDir: string
  runtimeWasmPath: string
  parseTimeoutMs: number
  /** Grammar basenames found on disk, minus the quarantined ones. */
  available: ReadonlySet<string>
}

let initPromise: Promise<RuntimeState> | null = null
let runtime: RuntimeState | null = null

/**
 * Grammar basename → in-flight or settled load. Values resolve to null for a
 * grammar that failed to load, which is how failures are negative-cached: a
 * broken grammar is attempted exactly once per process.
 */
const languages = new Map<string, Promise<Language | null>>()

/** Grammar basename → parser bound to that language. */
const parsers = new Map<string, Parser>()

/** Non-fatal problems, drained by the orchestrator into RepoReport.warnings. */
let warnings: string[] = []

function warn(message: string): void {
  // Bounded so a repository full of broken blobs cannot grow this without limit.
  if (warnings.length < 200) warnings.push(message)
}

/**
 * Returns and clears the warnings accumulated since the last call. These are
 * degraded-analysis notices — a grammar that would not load, a file that hit the
 * parse timeout — not errors; analysis continues without the affected file's
 * structural numbers.
 */
export function takeWarnings(): string[] {
  const drained = warnings
  warnings = []
  return drained
}

// ---------------------------------------------------------------------------
// The dylink compatibility shim
// ---------------------------------------------------------------------------

/** Reads an unsigned LEB128 at `offset`; returns the value and the next offset. */
function readUleb(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0
  let shift = 0
  let i = offset
  for (;;) {
    if (i >= bytes.length) throw new RangeError('truncated LEB128')
    const byte = bytes[i] ?? 0
    i++
    value += (byte & 0x7f) * Math.pow(2, shift)
    if ((byte & 0x80) === 0) break
    shift += 7
    if (shift > 35) throw new RangeError('over-long LEB128')
  }
  return { value, next: i }
}

/** Encodes an unsigned LEB128. */
function writeUleb(value: number): number[] {
  const out: number[] = []
  let v = value
  do {
    let byte = v & 0x7f
    v = Math.floor(v / 128)
    if (v !== 0) byte |= 0x80
    out.push(byte)
  } while (v !== 0)
  return out
}

/**
 * Rewrites a WebAssembly side module's legacy `dylink` custom section into the
 * standard `dylink.0` form, so web-tree-sitter@0.26 will accept it.
 *
 * The two layouts carry the same information. Legacy, immediately after the
 * section name:
 *
 *     memorysize, memoryalign, tablesize, tablealign, neededcount, needed[]
 *
 * Standard splits that into typed subsections, each length-prefixed:
 *
 *     0x01 <size> memorysize memoryalign tablesize tablealign
 *     0x02 <size> neededcount needed[]
 *
 * All values stay LEB128, so the original bytes are copied through verbatim and
 * only the framing is rebuilt. Everything after the section — the entire module
 * body, including the relocation data Emscripten's dynamic linker consumes — is
 * untouched.
 *
 * A module that is already standard, or whose first section is not a dylink
 * section, is returned unchanged so that a future grammar package needs no
 * special-casing.
 */
export function upgradeDylinkSection(module: Uint8Array): Uint8Array {
  // magic (4) + version (4); the dylink section, if present, must be first.
  if (module.length < 10 || module[8] !== 0x00) return module

  let cursor = 9
  const sectionSize = readUleb(module, cursor)
  cursor = sectionSize.next
  const sectionEnd = cursor + sectionSize.value
  if (sectionEnd > module.length) return module

  const nameLength = readUleb(module, cursor)
  cursor = nameLength.next
  const nameEnd = cursor + nameLength.value
  if (nameEnd > sectionEnd) return module

  let name = ''
  for (let i = cursor; i < nameEnd; i++) name += String.fromCharCode(module[i] ?? 0)
  if (name !== 'dylink') return module

  // Four LEB128 fields make up the memory/table info block.
  let fieldCursor = nameEnd
  for (let i = 0; i < 4; i++) fieldCursor = readUleb(module, fieldCursor).next
  const memInfo = module.subarray(nameEnd, fieldCursor)
  const needed = module.subarray(fieldCursor, sectionEnd)

  const NAME_BYTES = [0x64, 0x79, 0x6c, 0x69, 0x6e, 0x6b, 0x2e, 0x30] // "dylink.0"
  const payload: number[] = [
    ...writeUleb(NAME_BYTES.length),
    ...NAME_BYTES,
    0x01,
    ...writeUleb(memInfo.length),
    ...memInfo,
    0x02,
    ...writeUleb(needed.length),
    ...needed
  ]
  const header = [0x00, ...writeUleb(payload.length)]

  const tail = module.subarray(sectionEnd)
  const out = new Uint8Array(8 + header.length + payload.length + tail.length)
  out.set(module.subarray(0, 8), 0)
  out.set(header, 8)
  out.set(payload, 8 + header.length)
  out.set(tail, 8 + header.length + payload.length)
  return out
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Locates web-tree-sitter's own runtime wasm.
 *
 * Emscripten's default resolution is relative to the module's own URL, which is
 * correct in development and wrong the moment electron-vite bundles the analyzer
 * into `out/main/analyzer.js`. Candidates, in order: whatever the caller passed;
 * a copy sitting alongside the grammars, which is how a packaged build should
 * ship them; package resolution through the exports map; and finally the
 * physical sibling layout `node_modules/tree-sitter-wasms/out/../../…`.
 */
async function locateRuntimeWasm(grammarDir: string, explicit: string | undefined): Promise<string> {
  const candidates: string[] = []
  if (explicit) candidates.push(explicit)
  candidates.push(join(grammarDir, 'web-tree-sitter.wasm'))

  try {
    const require = createRequire(import.meta.url)
    candidates.push(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
  } catch {
    // Not resolvable from this module's location (bundled, or asar-packed with a
    // different layout). The remaining candidates cover that case.
  }

  candidates.push(join(grammarDir, '..', '..', 'web-tree-sitter', 'web-tree-sitter.wasm'))

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  throw new Error(
    `Could not locate web-tree-sitter.wasm. Looked in: ${candidates.join(', ')}. ` +
      `Pass InitOptions.runtimeWasmPath to point at it explicitly.`
  )
}

async function doInit(grammarDir: string, options: InitOptions): Promise<RuntimeState> {
  const runtimeWasmPath = await locateRuntimeWasm(grammarDir, options.runtimeWasmPath)

  let entries: string[]
  try {
    entries = await readdir(grammarDir)
  } catch (error) {
    throw new Error(`Grammar directory ${grammarDir} is not readable: ${describe(error)}`)
  }

  const available = new Set<string>()
  for (const entry of entries) {
    if (!entry.startsWith('tree-sitter-') || !entry.endsWith('.wasm')) continue
    const base = entry.slice('tree-sitter-'.length, -'.wasm'.length)
    if (base.length === 0 || QUARANTINED_GRAMMARS.has(base)) continue
    available.add(base)
  }
  if (available.size === 0) {
    throw new Error(`No tree-sitter-<lang>.wasm grammars found in ${grammarDir}`)
  }

  // `locateFile` is consulted for the runtime binary; anything else the
  // Emscripten module asks for is passed through unchanged.
  await Parser.init({
    locateFile: (path: string): string => (path === 'web-tree-sitter.wasm' ? runtimeWasmPath : path)
  })

  return {
    grammarDir,
    runtimeWasmPath,
    parseTimeoutMs: options.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS,
    available
  }
}

/**
 * Initialises the tree-sitter runtime. Idempotent, and safe to call
 * concurrently: every caller awaits the same underlying work.
 *
 * `wasmDir` is the directory holding the `tree-sitter-<lang>.wasm` grammars —
 * `node_modules/tree-sitter-wasms/out` in development, the app's resources
 * directory once packaged. No grammar is loaded here; the directory is only
 * scanned so that {@link isLanguageSupported} can answer without I/O.
 */
export function initParser(wasmDir: string, options: InitOptions = {}): Promise<void> {
  if (!initPromise) {
    initPromise = doInit(wasmDir, options).then((state) => {
      runtime = state
      return state
    })
    // A failed init must not be cached, or a transient fault would poison the
    // process for its whole lifetime.
    initPromise.catch(() => {
      initPromise = null
    })
  }
  return initPromise.then(() => undefined)
}

function requireRuntime(): RuntimeState {
  if (!runtime) {
    throw new Error('initParser() must be awaited before analyzing source')
  }
  return runtime
}

// ---------------------------------------------------------------------------
// Grammar loading
// ---------------------------------------------------------------------------

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

/** Resets a parser, swallowing a failure that would otherwise mask the real one. */
function resetQuietly(parser: Parser): void {
  try {
    parser.reset()
  } catch {
    // The parser is unusable; the next acquire will surface it properly.
  }
}

/**
 * Resolves a caller-supplied language name to a grammar basename that exists on
 * disk, or null when nothing covers it.
 */
function resolveGrammar(state: RuntimeState, language: string): string | null {
  const key = language.trim().toLowerCase()
  if (key.length === 0) return null
  if (state.available.has(key)) return key
  const aliased = LANGUAGE_ALIASES.get(key)
  if (aliased !== undefined && state.available.has(aliased)) return aliased
  return null
}

/** True when a grammar for this language is present and not quarantined. */
export function isLanguageSupported(language: string): boolean {
  return runtime !== null && resolveGrammar(runtime, language) !== null
}

async function loadGrammar(state: RuntimeState, grammar: string): Promise<Language | null> {
  const path = join(state.grammarDir, `tree-sitter-${grammar}.wasm`)
  try {
    const raw = await readFile(path)
    // Copy into a plain Uint8Array view: Buffer is a Uint8Array, but the shim
    // may return a fresh buffer and web-tree-sitter takes ownership either way.
    const bytes = upgradeDylinkSection(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
    return await Language.load(bytes)
  } catch (error) {
    warn(`tree-sitter grammar "${grammar}" could not be loaded (${describe(error)}); files in that language will have no complexity data.`)
    return null
  }
}

/**
 * Returns the parser bound to `grammar`, loading the grammar on first use.
 *
 * Concurrent callers for the same grammar share one load — the promise is put in
 * the map before it is awaited — so a grammar is never compiled twice.
 */
async function acquireParser(state: RuntimeState, grammar: string): Promise<Parser | null> {
  const existing = parsers.get(grammar)
  if (existing) return existing

  let pending = languages.get(grammar)
  if (!pending) {
    if (languages.size >= MAX_LOADED_GRAMMARS) {
      warn(`Grammar budget of ${MAX_LOADED_GRAMMARS} languages reached; "${grammar}" was not loaded.`)
      return null
    }
    pending = loadGrammar(state, grammar)
    languages.set(grammar, pending)
  }

  const language = await pending
  if (!language) return null

  // Another caller may have raced us here while we awaited.
  const raced = parsers.get(grammar)
  if (raced) return raced

  try {
    const parser = new Parser()
    parser.setLanguage(language)
    parsers.set(grammar, parser)
    return parser
  } catch (error) {
    warn(`tree-sitter grammar "${grammar}" is incompatible with this runtime (${describe(error)}).`)
    return null
  }
}

/**
 * Loads the grammars for the given languages ahead of time.
 *
 * Optional. The analyzer can call this once it knows the repository's language
 * mix so that the first file of each language does not pay the compile cost
 * inside the parse loop. Unknown or unloadable languages are ignored.
 */
export async function preloadLanguages(languageNames: Iterable<string>): Promise<void> {
  const state = requireRuntime()
  const wanted = new Set<string>()
  for (const name of languageNames) {
    const grammar = resolveGrammar(state, name)
    if (grammar) wanted.add(grammar)
  }
  await Promise.all([...wanted].map((grammar) => acquireParser(state, grammar)))
}

// ---------------------------------------------------------------------------
// Complexity walk
// ---------------------------------------------------------------------------

/**
 * Walks the whole tree once, accumulating per-function cyclomatic complexity.
 *
 * Two design points worth stating:
 *
 * *Innermost attribution.* A decision point is charged to the innermost function
 * that encloses it, never to its ancestors. A closure's branches belong to the
 * closure. This keeps `totalComplexity` equal to `functions + decisionPoints`
 * over the whole file, with no double counting, and matches how ESLint, radon
 * and rust-code-analysis all report.
 *
 * *Iterative, not recursive.* Deeply nested expressions are routine in generated
 * code and in minified-ish files; a recursive walk would risk a stack overflow on
 * exactly the pathological input this module is supposed to survive. The cursor
 * carries the position, and an explicit depth counter tells us when a function
 * frame closes.
 */
function walk(tree: Tree, prof: LanguageProfile): StructuralAnalysis {
  let functions = 0
  let totalComplexity = 0
  let maxComplexity = 0
  let complexFunctions = 0

  // The innermost open function frame, held in scalars; enclosing frames spill
  // to the stacks. -1 means "not inside a function", in which case decision
  // points are ignored — module-level control flow belongs to no function.
  let currentComplexity = -1
  let currentDepth = -1
  const outerComplexity: number[] = []
  const outerDepth: number[] = []

  const cursor = tree.walk()
  try {
    let depth = 0

    const enter = (): void => {
      const type = cursor.nodeType
      if (cursor.nodeIsNamed) {
        if (prof.functionNodes.has(type)) {
          if (currentComplexity >= 0) {
            outerComplexity.push(currentComplexity)
            outerDepth.push(currentDepth)
          }
          currentComplexity = 1 // every function starts with one path
          currentDepth = depth
          return
        }
        if (prof.decisionNodes.has(type) && currentComplexity >= 0) currentComplexity++
        return
      }
      if (prof.decisionTokens.has(type) && currentComplexity >= 0) currentComplexity++
    }

    const leave = (nodeDepth: number): void => {
      if (currentDepth !== nodeDepth) return
      functions++
      totalComplexity += currentComplexity
      if (currentComplexity > maxComplexity) maxComplexity = currentComplexity
      if (currentComplexity > COMPLEX_FUNCTION_THRESHOLD) complexFunctions++
      currentComplexity = outerComplexity.pop() ?? -1
      currentDepth = outerDepth.pop() ?? -1
    }

    enter()
    for (;;) {
      if (cursor.gotoFirstChild()) {
        depth++
        enter()
        continue
      }
      leave(depth)
      for (;;) {
        if (cursor.gotoNextSibling()) {
          enter()
          break
        }
        if (depth === 0) return { functions, totalComplexity, maxComplexity, complexFunctions }
        cursor.gotoParent()
        depth--
        leave(depth)
      }
    }
  } finally {
    cursor.delete()
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses one source blob and returns its structural metrics.
 *
 * Returns null — meaning "no structural data", which the caller stores as the
 * null fields of `BlobAnalysis` — when any of the following hold:
 *   • no grammar covers `language`, or the grammar is quarantined or unloadable;
 *   • the blob exceeds {@link MAX_PARSE_CHARS};
 *   • the parse exceeded its time budget;
 *   • tree-sitter threw.
 *
 * It never throws for bad input. The only error it raises is a missing
 * {@link initParser}, which is a wiring bug and must be loud.
 *
 * A file that parses with syntax errors is still measured. Tree-sitter's error
 * recovery yields a usable tree, and refusing to score a file because one region
 * failed to parse would systematically under-report exactly the half-finished
 * code VDE exists to find.
 */
export async function analyzeSource(source: string, language: string): Promise<StructuralAnalysis | null> {
  const state = requireRuntime()

  const grammar = resolveGrammar(state, language)
  if (!grammar) return null
  if (source.length === 0 || source.length > MAX_PARSE_CHARS) return null

  const parser = await acquireParser(state, grammar)
  if (!parser) return null

  const deadline = Date.now() + state.parseTimeoutMs
  let tree: Tree | null = null

  try {
    // The progress callback is tree-sitter 0.26's cancellation mechanism: a
    // truthy return aborts the parse, and `parse` then yields null.
    tree = parser.parse(source, null, {
      progressCallback: (): boolean => Date.now() > deadline
    })
  } catch (error) {
    warn(`tree-sitter failed on a ${grammar} blob (${describe(error)}); it was skipped.`)
    resetQuietly(parser)
    return null
  }

  if (!tree) {
    // Cancelled, or the parser had no language. Either way the parser is left
    // mid-parse: without a reset it would resume this file's parse on the next
    // call and return a tree for the wrong source.
    resetQuietly(parser)
    warn(`A ${grammar} blob exceeded the ${state.parseTimeoutMs}ms parse budget and was skipped.`)
    return null
  }

  try {
    return walk(tree, PROFILES.get(grammar) ?? GENERIC_PROFILE)
  } catch (error) {
    warn(`Complexity walk failed on a ${grammar} blob (${describe(error)}); it was skipped.`)
    return null
  } finally {
    // Trees hold wasm heap. Leaking one per file would exhaust the heap on any
    // repository of consequence.
    tree.delete()
  }
}

/**
 * Releases every parser and resets module state.
 *
 * Grammars themselves cannot be unloaded — an Emscripten side module lives for
 * the life of the runtime — so this is for orderly shutdown and for tests that
 * need a clean slate, not for reclaiming memory mid-scan.
 */
export function disposeParsers(): void {
  for (const parser of parsers.values()) {
    try {
      parser.delete()
    } catch {
      // Already deleted, or the runtime is gone. Nothing useful to do.
    }
  }
  parsers.clear()
}

/** Exposed for tests. */
export const __testing = {
  PROFILES,
  GENERIC_PROFILE,
  QUARANTINED_GRAMMARS,
  resolveGrammar: (language: string): string | null => (runtime ? resolveGrammar(runtime, language) : null)
}
