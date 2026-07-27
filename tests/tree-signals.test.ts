/**
 * Scratch verification harness for src/analyzer/signals/tree.ts.
 *
 * The modules that normally build an AnalysisContext (git/history, content/
 * classify, content/blobs, content/clusters) are owned by other agents and were
 * not present when this was written, so this file builds a *minimal, honest*
 * context of its own from the reference specimen — using nothing but the
 * read-only git gateway — and runs the seven tree signals against it.
 *
 * Everything here is approximate where the real pipeline is exact, and the
 * approximations are named at the point they are made. This file is a probe,
 * not a fixture: once the real modules land it can be deleted or rewritten
 * against them.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { run, readBlob, streamLines } from '../src/analyzer/git/exec'
import type {
  AnalysisContext,
  BlobAnalysis,
  CommitRecord,
  FileChange,
  FileKind,
  FileStats,
  SprawlCluster,
  TreeEntry
} from '../src/analyzer/model'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import {
  complexityDrift,
  computeFileFlags,
  computeRisk,
  directorySprawl,
  docBloat,
  godFiles,
  siblingSprawl,
  testDeficit,
  treeSignals,
  writeOnce
} from '../src/analyzer/signals/tree'

const SPECIMEN = join(homedir(), 'codebase', 'apxstream', 'apx-response')
const DAY = 86_400_000

// ---------------------------------------------------------------------------
// Minimal classification (stands in for content/classify.ts)
// ---------------------------------------------------------------------------

const SOURCE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'go', 'rs', 'java', 'kt', 'kts',
  'rb', 'php', 'cs', 'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'swift', 'scala', 'm', 'mm',
  'sh', 'bash', 'zsh', 'sql', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'lua', 'ex', 'exs'
])
const DOC_EXT = new Set(['md', 'mdx', 'rst', 'adoc', 'txt', 'org'])
const CONFIG_EXT = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'properties', 'plist'])
const DATA_EXT = new Set(['csv', 'tsv', 'jsonl', 'ndjson', 'parquet', 'db', 'sqlite', 'sqlite3', 'avro'])
const ASSET_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'icns', 'webp', 'bmp', 'tiff', 'avif',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'wav', 'webm', 'pdf'
])
const VENDOR_RE = /(?:^|\/)(?:vendor|vendored|third_party|thirdparty|node_modules|bower_components|\.yarn|Pods)(?:\/|$)/
const TEST_RE =
  /(?:^|\/)(?:tests?|specs?|__tests__|__mocks__|e2e|cypress|playwright)(?:\/|$)|(?:\.(?:test|spec)\.[a-z]+$)|(?:(?:^|\/)test_[^/]+\.py$)|(?:_test\.(?:go|py|ts|js|rb)$)/
const GENERATED_RE =
  /(?:\.lock$)|(?:(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock)$)|(?:\.generated\.)|(?:\.gen\.ts$)|(?:(?:^|\/)schema\.d\.ts$)|(?:\.pb\.go$)|(?:_pb2\.py$)|(?:\.min\.(?:js|css)$)/

function extOf(path: string): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  if (dot <= slash + 1) return ''
  return path.slice(dot + 1).toLowerCase()
}

function classify(path: string): FileKind {
  if (VENDOR_RE.test(path)) return 'vendored'
  if (GENERATED_RE.test(path)) return 'generated'
  const ext = extOf(path)
  if (ASSET_EXT.has(ext)) return 'asset'
  if (DATA_EXT.has(ext)) return 'data'
  if (TEST_RE.test(path) && (SOURCE_EXT.has(ext) || ext === '')) return 'test'
  if (DOC_EXT.has(ext)) return 'doc'
  if (SOURCE_EXT.has(ext)) return 'source'
  if (CONFIG_EXT.has(ext)) return 'config'
  const base = path.slice(path.lastIndexOf('/') + 1)
  if (/^(Dockerfile|Makefile|\.[a-z]+rc|\.gitignore|\.env.*)$/i.test(base)) return 'config'
  return 'unknown'
}

function languageOf(ext: string): string | null {
  switch (ext) {
    case 'ts': case 'mts': case 'cts': return 'TypeScript'
    case 'tsx': return 'TSX'
    case 'js': case 'mjs': case 'cjs': return 'JavaScript'
    case 'jsx': return 'JSX'
    case 'py': return 'Python'
    case 'go': return 'Go'
    case 'rs': return 'Rust'
    case 'md': case 'mdx': return 'Markdown'
    case 'json': return 'JSON'
    case 'yaml': case 'yml': return 'YAML'
    case 'sh': case 'bash': return 'Shell'
    case 'sql': return 'SQL'
    case 'css': case 'scss': return 'CSS'
    default: return ext === '' ? null : ext
  }
}

// ---------------------------------------------------------------------------
// Approximate complexity (stands in for the tree-sitter parser)
//
// Brace-scoped for C-family languages, indentation-scoped for Python.
// Decision points are attributed to the innermost open function, which is what
// a real cyclomatic-complexity tool does; string and comment text is stripped
// first so keywords inside literals are not counted.
// ---------------------------------------------------------------------------

function stripLiterals(src: string): string {
  let out = ''
  let i = 0
  let mode: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tick' = 'code'
  while (i < src.length) {
    const c = src[i] ?? ''
    const n = src[i + 1] ?? ''
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue }
      if (c === '#') { mode = 'line'; i += 1; continue }
      if (c === "'") { mode = 'sq'; i += 1; out += ' '; continue }
      if (c === '"') { mode = 'dq'; i += 1; out += ' '; continue }
      if (c === '`') { mode = 'tick'; i += 1; out += ' '; continue }
      out += c
      i += 1
      continue
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n' }
      i += 1
      continue
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; i += 2; continue }
      if (c === '\n') out += '\n'
      i += 1
      continue
    }
    // inside a string literal
    if (c === '\\') { i += 2; continue }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tick' && c === '`')) {
      mode = 'code'
      i += 1
      continue
    }
    if (c === '\n') out += '\n'
    i += 1
  }
  return out
}

const DECISION_RE = /\b(?:if|for|while|case|catch)\b|&&|\|\||\?\?|\?/g
const PY_DECISION_RE = /\b(?:if|elif|for|while|except)\b|\band\b|\bor\b/g

function countDecisions(text: string, python: boolean): number {
  const re = python ? PY_DECISION_RE : DECISION_RE
  re.lastIndex = 0
  let n = 0
  while (re.exec(text) !== null) n++
  return n
}

/** Header text immediately preceding a `{` that indicates a function body. */
const FN_HEADER_RE =
  /(?:\bfunction\b[^(){}]*$)|(?:=>\s*$)|(?:\b(?:constructor|get|set)\b[^(){}]*\)\s*$)|(?:^[^(){};=]*\)\s*(?::[^(){};=]+)?\s*$)/

interface ComplexityResult {
  functions: number
  totalComplexity: number
  maxComplexity: number
  complexFunctions: number
}

function analyseBraces(src: string): ComplexityResult {
  const code = stripLiterals(src)
  const stack: Array<{ depth: number; cc: number }> = []
  const result: ComplexityResult = { functions: 0, totalComplexity: 0, maxComplexity: 0, complexFunctions: 0 }
  let depth = 0
  let segStart = 0

  const finish = (cc: number): void => {
    result.functions++
    result.totalComplexity += cc
    if (cc > result.maxComplexity) result.maxComplexity = cc
    if (cc > 10) result.complexFunctions++
  }

  for (let i = 0; i < code.length; i++) {
    const c = code[i] ?? ''
    if (c === ';' || c === '\n') {
      // A statement boundary resets the "header" window used to recognise fns.
      if (c === ';') segStart = i + 1
      continue
    }
    if (c === '{') {
      const header = code.slice(Math.max(segStart, i - 400), i)
      const isFn = FN_HEADER_RE.test(header.split('\n').slice(-3).join('\n').trimEnd())
      depth++
      if (isFn) stack.push({ depth, cc: 1 })
      segStart = i + 1
      continue
    }
    if (c === '}') {
      const top = stack[stack.length - 1]
      if (top && top.depth === depth) {
        stack.pop()
        finish(top.cc)
      }
      depth--
      segStart = i + 1
      continue
    }
    // Decision points go to the innermost open function.
    const top = stack[stack.length - 1]
    if (!top) continue
    if (c === '&' || c === '|' || c === '?') {
      const prev = code[i - 1]
      if ((c === '&' && prev === '&') || (c === '|' && prev === '|') || (c === '?' && prev === '?')) continue
      const next = code[i + 1]
      if ((c === '&' && next === '&') || (c === '|' && next === '|') || (c === '?' && next === '?')) { top.cc++; continue }
      if (c === '?') top.cc++
      continue
    }
    if (c >= 'a' && c <= 'z') {
      if (i > 0) {
        const prev = code[i - 1] ?? ''
        if (/[A-Za-z0-9_$]/.test(prev)) continue
      }
      const word = /^[a-z]+/.exec(code.slice(i, i + 8))?.[0] ?? ''
      const after = code[i + word.length] ?? ''
      if (/[A-Za-z0-9_$]/.test(after)) continue
      if (word === 'if' || word === 'for' || word === 'while' || word === 'case' || word === 'catch') top.cc++
    }
  }
  // Unbalanced braces (rare, from a mis-stripped literal) leave frames open.
  for (const frame of stack) finish(frame.cc)
  return result
}

function analysePython(src: string): ComplexityResult {
  const lines = stripLiterals(src).split('\n')
  const stack: Array<{ indent: number; cc: number }> = []
  const result: ComplexityResult = { functions: 0, totalComplexity: 0, maxComplexity: 0, complexFunctions: 0 }

  const finish = (cc: number): void => {
    result.functions++
    result.totalComplexity += cc
    if (cc > result.maxComplexity) result.maxComplexity = cc
    if (cc > 10) result.complexFunctions++
  }

  for (const line of lines) {
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top && indent <= top.indent) {
        stack.pop()
        finish(top.cc)
      } else break
    }
    if (/^\s*(?:async\s+)?def\s+\w+/.test(line)) {
      stack.push({ indent, cc: 1 })
      continue
    }
    const top = stack[stack.length - 1]
    if (top) top.cc += countDecisions(line, true)
  }
  for (const frame of stack) finish(frame.cc)
  return result
}

const BRACE_LANGS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'go', 'java', 'cs', 'c', 'cc', 'cpp', 'rs'])

// ---------------------------------------------------------------------------
// Reading the repository (read-only, via the gateway only)
// ---------------------------------------------------------------------------

function unquote(path: string): string {
  if (!path.startsWith('"')) return path
  try {
    return JSON.parse(path) as string
  } catch {
    return path.slice(1, -1)
  }
}

async function readTree(repo: string, rev: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = []
  await streamLines(
    repo,
    ['ls-tree', '-r', '-l', '-z', rev],
    (record) => {
      if (record === '') return
      const tab = record.indexOf('\t')
      if (tab === -1) return
      const meta = record.slice(0, tab).split(/\s+/)
      const path = record.slice(tab + 1)
      const mode = meta[0] ?? ''
      const type = meta[1] ?? ''
      const sha = meta[2] ?? ''
      const sizeRaw = meta[3] ?? '-'
      if (type !== 'blob') return
      entries.push({ path, sha, size: sizeRaw === '-' ? -1 : Number(sizeRaw), mode })
    },
    { separator: '\0', timeoutMs: 300_000 }
  )
  return entries
}

const REC = ''

async function readHistory(repo: string): Promise<CommitRecord[]> {
  const commits: CommitRecord[] = []
  let current: CommitRecord | null = null

  await streamLines(
    repo,
    [
      'log',
      '--no-renames',
      '--numstat',
      `--pretty=format:${REC}%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s`
    ],
    (line) => {
      if (line.startsWith(REC)) {
        if (current) commits.push(current)
        const f = line.slice(1).split('')
        const parents = (f[1] ?? '').split(' ').filter((p) => p.length > 0)
        current = {
          sha: f[0] ?? '',
          parents,
          authorName: f[2] ?? '',
          authorEmail: f[3] ?? '',
          authoredAt: Number(f[4] ?? 0) * 1000,
          committedAt: Number(f[5] ?? 0) * 1000,
          subject: f[6] ?? '',
          files: [],
          isMerge: parents.length > 1
        }
        return
      }
      if (line === '' || !current) return
      const parts = line.split('\t')
      if (parts.length < 3) return
      const addRaw = parts[0] ?? ''
      const delRaw = parts[1] ?? ''
      const path = unquote(parts.slice(2).join('\t'))
      const binary = addRaw === '-' || delRaw === '-'
      const change: FileChange = {
        path,
        status: 'M',
        insertions: binary ? 0 : Number(addRaw),
        deletions: binary ? 0 : Number(delRaw),
        binary
      }
      current.files.push(change)
    },
    { timeoutMs: 600_000 }
  )
  if (current) commits.push(current)
  return commits
}

/** Bounded-concurrency blob reader; a spawn per blob is the only API we have. */
async function analyseBlobs(repo: string, entries: TreeEntry[]): Promise<Map<string, BlobAnalysis>> {
  const out = new Map<string, BlobAnalysis>()
  const queue = entries.slice()
  const workers: Promise<void>[] = []
  const CONCURRENCY = 24

  const work = async (): Promise<void> => {
    for (;;) {
      const entry = queue.pop()
      if (!entry) return
      if (out.has(entry.sha)) continue
      let buf: Buffer
      try {
        buf = await readBlob(repo, entry.sha, { maxBuffer: 8 * 1024 * 1024 })
      } catch {
        continue
      }
      const probe = buf.subarray(0, 8000)
      const binary = probe.includes(0)
      const ext = extOf(entry.path)
      if (binary) {
        out.set(entry.sha, {
          sha: entry.sha, bytes: buf.length, lines: 0, codeLines: null,
          language: languageOf(ext), binary: true, functions: null, totalComplexity: null,
          maxComplexity: null, complexFunctions: null, simhash: null
        })
        continue
      }
      const text = buf.toString('utf8')
      let lines = 0
      for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines++
      if (text.length > 0 && !text.endsWith('\n')) lines++

      let cx: ComplexityResult | null = null
      if (BRACE_LANGS.has(ext)) cx = analyseBraces(text)
      else if (ext === 'py') cx = analysePython(text)

      out.set(entry.sha, {
        sha: entry.sha,
        bytes: buf.length,
        lines,
        codeLines: null,
        language: languageOf(ext),
        binary: false,
        functions: cx ? cx.functions : null,
        totalComplexity: cx ? cx.totalComplexity : null,
        maxComplexity: cx ? cx.maxComplexity : null,
        complexFunctions: cx ? cx.complexFunctions : null,
        simhash: null
      })
    }
  }
  for (let i = 0; i < CONCURRENCY; i++) workers.push(work())
  await Promise.all(workers)
  return out
}

// ---------------------------------------------------------------------------
// Minimal name-based clustering (stands in for content/clusters.ts)
// ---------------------------------------------------------------------------

const VARIANT_RE =
  /(?:[-_. ]?(?:final|fixed|new|old|copy|updated|revised|draft|reproof|backup|bak|orig|temp|tmp|wip|latest))+$|(?:[-_. ]?v?\d+)+$|(?:[-_. ]?\d{4}[-_]\d{2}[-_]\d{2})$|(?:[-_. ]?p\d+)$|(?:\(\d+\))$/i

function normaliseStem(stem: string): string {
  let s = stem.toLowerCase()
  for (let i = 0; i < 6; i++) {
    const next = s.replace(VARIANT_RE, '')
    if (next === s || next.length < 3) break
    s = next
  }
  return s
}

function buildClusters(paths: string[]): SprawlCluster[] {
  const groups = new Map<string, string[]>()
  for (const path of paths) {
    const slash = path.lastIndexOf('/')
    const dir = slash === -1 ? '' : path.slice(0, slash)
    const base = path.slice(slash + 1)
    const dot = base.lastIndexOf('.')
    const stem = dot <= 0 ? base : base.slice(0, dot)
    const ext = dot <= 0 ? '' : base.slice(dot)
    const norm = normaliseStem(stem)
    if (norm.length < 3) continue
    const key = `${dir} ${norm}${ext}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(path)
    else groups.set(key, [path])
  }
  const clusters: SprawlCluster[] = []
  for (const [key, members] of groups) {
    if (members.length < 2) continue
    const sep = key.indexOf(' ')
    const dir = key.slice(0, sep)
    const normWithExt = key.slice(sep + 1)
    const stem = dir === '' ? normWithExt : `${dir}/${normWithExt}`
    const meanRaw =
      members.reduce((sum, p) => sum + p.slice(p.lastIndexOf('/') + 1).length, 0) / members.length
    const normLen = normWithExt.length
    clusters.push({
      stem,
      members: members.slice().sort(),
      basis: 'name',
      similarity: Math.max(0, Math.min(1, normLen / Math.max(1, meanRaw)))
    })
  }
  return clusters
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

async function buildContext(repo: string, windowDays: number): Promise<AnalysisContext> {
  const head = (await run(repo, ['rev-parse', 'HEAD'])).trim()
  const [tree, commits] = await Promise.all([readTree(repo, head), readHistory(repo)])
  const blobs = await analyseBlobs(repo, tree)

  const kinds = new Map<string, FileKind>()
  for (const entry of tree) kinds.set(entry.path, classify(entry.path))
  for (const commit of commits) {
    for (const change of commit.files) {
      if (!kinds.has(change.path)) kinds.set(change.path, classify(change.path))
    }
  }

  const now = commits.length > 0 ? Math.max(...commits.map((c) => c.authoredAt)) : Date.now()

  const alive = new Set(tree.map((e) => e.path))
  const fileStats = new Map<string, FileStats>()
  for (const commit of commits) {
    if (commit.isMerge) continue
    for (const change of commit.files) {
      let stats = fileStats.get(change.path)
      if (!stats) {
        stats = {
          path: change.path,
          commits: 0,
          authors: new Set<string>(),
          firstAt: commit.authoredAt,
          lastAt: commit.authoredAt,
          added: 0,
          deleted: 0,
          alive: alive.has(change.path),
          formerPaths: [],
          touchedBy: []
        }
        fileStats.set(change.path, stats)
      }
      stats.commits++
      stats.authors.add(commit.authorEmail)
      stats.added += change.insertions
      stats.deleted += change.deletions
      if (commit.authoredAt < stats.firstAt) stats.firstAt = commit.authoredAt
      if (commit.authoredAt > stats.lastAt) stats.lastAt = commit.authoredAt
      if (stats.touchedBy.length < 200) stats.touchedBy.push(commit.sha)
    }
  }

  // Immediate child-file counts, with every ancestor directory present as a key
  // so container directories are represented (matching what a tree walk yields).
  const dirFileCounts = new Map<string, number>()
  const ensure = (dir: string): void => {
    if (dir === '') return
    if (!dirFileCounts.has(dir)) dirFileCounts.set(dir, 0)
    const slash = dir.lastIndexOf('/')
    if (slash > 0) ensure(dir.slice(0, slash))
  }
  for (const entry of tree) {
    const slash = entry.path.lastIndexOf('/')
    if (slash === -1) continue
    const dir = entry.path.slice(0, slash)
    ensure(dir)
    dirFileCounts.set(dir, (dirFileCounts.get(dir) ?? 0) + 1)
  }

  const excludeRe = DEFAULT_SETTINGS.excludeGlobs.map((g) =>
    new RegExp(
      '^' +
        g
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*\//g, ' ')
          .replace(/\*/g, '[^/]*')
          .replace(/ /g, '(?:[^/]*/)*') +
        '$'
    )
  )
  const clusterInput = tree
    .map((e) => e.path)
    .filter((p) => {
      const kind = kinds.get(p) ?? 'unknown'
      if (kind === 'generated' || kind === 'vendored' || kind === 'asset' || kind === 'data') return false
      return !excludeRe.some((r) => r.test(p))
    })

  const cutoff = now - windowDays * DAY
  const window = commits.filter((c) => !c.isMerge && c.authoredAt >= cutoff)

  const counts = commits.filter((c) => !c.isMerge).map((c) => c.files.length).sort((a, b) => a - b)
  const p90 = counts.length > 0 ? (counts[Math.floor(counts.length * 0.9)] ?? 0) : 0

  return {
    repoId: 'specimen',
    repoPath: repo,
    settings: DEFAULT_SETTINGS,
    headSha: head,
    now,
    history: {
      commits,
      firstAt: commits.length > 0 ? Math.min(...commits.map((c) => c.authoredAt)) : now,
      lastAt: now,
      authors: new Map(commits.map((c) => [c.authorEmail, c.authorName]))
    },
    window,
    windowDays,
    tree,
    blobs,
    kinds,
    fileStats,
    dirFileCounts,
    clusters: buildClusters(clusterInput),
    megaThreshold: Math.max(25, p90 * 2.5)
  }
}

// ---------------------------------------------------------------------------
// Synthetic context, for the properties that must hold regardless of data
// ---------------------------------------------------------------------------

function blob(sha: string, over: Partial<BlobAnalysis> = {}): BlobAnalysis {
  return {
    sha, bytes: 100, lines: 10, codeLines: null, language: 'TypeScript', binary: false,
    functions: null, totalComplexity: null, maxComplexity: null, complexFunctions: null,
    simhash: null, ...over
  }
}

function stats(path: string, over: Partial<FileStats> = {}): FileStats {
  return {
    path, commits: 1, authors: new Set(['a@b.c']), firstAt: 0, lastAt: 0,
    added: 0, deleted: 0, alive: true, formerPaths: [], touchedBy: [], ...over
  }
}

const NOW = Date.UTC(2026, 0, 1)

function synthetic(over: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    repoId: 'synthetic',
    repoPath: '/tmp/synthetic',
    settings: DEFAULT_SETTINGS,
    headSha: 'deadbeef',
    now: NOW,
    history: { commits: [], firstAt: NOW, lastAt: NOW, authors: new Map() },
    window: [],
    windowDays: 30,
    tree: [],
    blobs: new Map(),
    kinds: new Map(),
    fileStats: new Map(),
    dirFileCounts: new Map(),
    clusters: [],
    megaThreshold: 25,
    ...over
  }
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('tree signals — invariants', () => {
  it('all seven are registered exactly once, in panel order', () => {
    expect(treeSignals.map((s) => s.id)).toEqual([
      'siblingSprawl', 'godFiles', 'writeOnce', 'complexityDrift', 'docBloat', 'testDeficit', 'directorySprawl'
    ])
    expect(new Set(treeSignals.map((s) => s.id)).size).toBe(7)
  })

  it('every signal returns 0 and a sane headline on an empty repository', () => {
    const ctx = synthetic()
    for (const signal of treeSignals) {
      const result = signal.compute(ctx)
      expect(result.value, signal.id).toBe(0)
      expect(result.headline.length, signal.id).toBeGreaterThan(0)
      expect(result.drivers, signal.id).toEqual([])
    }
  })

  it('caps drivers at 50', () => {
    const tree: TreeEntry[] = []
    const blobs = new Map<string, BlobAnalysis>()
    const kinds = new Map<string, FileKind>()
    for (let i = 0; i < 120; i++) {
      const path = `src/f${i}.ts`
      tree.push({ path, sha: `s${i}`, size: 1000, mode: '100644' })
      blobs.set(`s${i}`, blob(`s${i}`, { lines: 900 + i }))
      kinds.set(path, 'source')
    }
    const result = godFiles.compute(synthetic({ tree, blobs, kinds }))
    expect(result.drivers.length).toBe(50)
    expect(result.drivers[0]?.value).toBe(1019)
    expect(result.value).toBe(100)
  })
})

describe('godFiles', () => {
  it('weights by lines, not by file count', () => {
    const tree: TreeEntry[] = [
      { path: 'src/big.ts', sha: 'a', size: 1, mode: '100644' },
      { path: 'src/small.ts', sha: 'b', size: 1, mode: '100644' }
    ]
    const blobs = new Map([['a', blob('a', { lines: 3000 })], ['b', blob('b', { lines: 1000 })]])
    const kinds = new Map<string, FileKind>([['src/big.ts', 'source'], ['src/small.ts', 'source']])
    const r = godFiles.compute(synthetic({ tree, blobs, kinds }))
    expect(r.value).toBe(100)
    expect(r.findings?.length).toBe(1) // only the 3,000-line file crosses 2,000
    expect(r.findings?.[0]?.paths).toEqual(['src/big.ts'])
  })

  it('ignores tests and docs', () => {
    const tree: TreeEntry[] = [
      { path: 'src/a.ts', sha: 'a', size: 1, mode: '100644' },
      { path: 'src/a.test.ts', sha: 'b', size: 1, mode: '100644' },
      { path: 'README.md', sha: 'c', size: 1, mode: '100644' }
    ]
    const blobs = new Map([
      ['a', blob('a', { lines: 100 })],
      ['b', blob('b', { lines: 5000 })],
      ['c', blob('c', { lines: 5000 })]
    ])
    const kinds = new Map<string, FileKind>([
      ['src/a.ts', 'source'], ['src/a.test.ts', 'test'], ['README.md', 'doc']
    ])
    expect(godFiles.compute(synthetic({ tree, blobs, kinds })).value).toBe(0)
  })
})

describe('writeOnce', () => {
  it('requires both one commit and 14 days of age', () => {
    const tree: TreeEntry[] = [
      { path: 'src/old.ts', sha: 'a', size: 1, mode: '100644' },
      { path: 'src/new.ts', sha: 'b', size: 1, mode: '100644' },
      { path: 'src/edited.ts', sha: 'c', size: 1, mode: '100644' },
      { path: 'src/other.ts', sha: 'd', size: 1, mode: '100644' }
    ]
    const kinds = new Map<string, FileKind>(tree.map((e) => [e.path, 'source' as FileKind]))
    const fileStats = new Map([
      ['src/old.ts', stats('src/old.ts', { commits: 1, firstAt: NOW - 100 * DAY, lastAt: NOW - 100 * DAY })],
      ['src/new.ts', stats('src/new.ts', { commits: 1, firstAt: NOW - 3 * DAY, lastAt: NOW - 3 * DAY })],
      ['src/edited.ts', stats('src/edited.ts', { commits: 9, firstAt: NOW - 100 * DAY, lastAt: NOW })],
      ['src/other.ts', stats('src/other.ts', { commits: 1, firstAt: NOW - 90 * DAY, lastAt: NOW - 90 * DAY })]
    ])
    const r = writeOnce.compute(synthetic({ tree, kinds, fileStats, blobs: new Map() }))
    expect(r.value).toBe(50)
    expect(r.drivers.map((d) => d.path)).toEqual(['src/old.ts', 'src/other.ts']) // oldest first
  })
})

describe('testDeficit', () => {
  it('reports good news at or above the 0.4 ratio', () => {
    const tree: TreeEntry[] = [
      { path: 'src/a.ts', sha: 'a', size: 1, mode: '100644' },
      { path: 'src/a.test.ts', sha: 'b', size: 1, mode: '100644' }
    ]
    const blobs = new Map([['a', blob('a', { lines: 1000 })], ['b', blob('b', { lines: 500 })]])
    const kinds = new Map<string, FileKind>([['src/a.ts', 'source'], ['src/a.test.ts', 'test']])
    const r = testDeficit.compute(synthetic({ tree, blobs, kinds }))
    expect(r.value).toBe(0)
    expect(r.headline).toMatch(/Healthy/)
    expect(r.headline).toMatch(/0\.50/)
  })

  it('scores a full 100 when there are no tests at all', () => {
    const tree: TreeEntry[] = [{ path: 'src/a.ts', sha: 'a', size: 1, mode: '100644' }]
    const blobs = new Map([['a', blob('a', { lines: 1000 })]])
    const kinds = new Map<string, FileKind>([['src/a.ts', 'source']])
    const r = testDeficit.compute(synthetic({ tree, blobs, kinds }))
    expect(r.value).toBe(100)
  })

  it('does not blame a source directory whose tests live in a parallel tests/ tree', () => {
    const tree: TreeEntry[] = [
      { path: 'src/engine/a.ts', sha: 'a', size: 1, mode: '100644' },
      { path: 'tests/engine/a.test.ts', sha: 'b', size: 1, mode: '100644' }
    ]
    const blobs = new Map([['a', blob('a', { lines: 1000 })], ['b', blob('b', { lines: 600 })]])
    const kinds = new Map<string, FileKind>([
      ['src/engine/a.ts', 'source'], ['tests/engine/a.test.ts', 'test']
    ])
    const r = testDeficit.compute(synthetic({ tree, blobs, kinds }))
    expect(r.value).toBe(0)
    // 600 test lines against 1,000 source lines is 0.6. src/engine must not be
    // listed as an offender just because the tests sit in a sibling tree.
    expect(r.drivers).toEqual([])
  })

  it('still blames a source directory that has no tests anywhere', () => {
    const tree: TreeEntry[] = [
      { path: 'pkg/a/src/x.ts', sha: 'a', size: 1, mode: '100644' },
      { path: 'pkg/b/src/y.ts', sha: 'b', size: 1, mode: '100644' },
      { path: 'pkg/b/tests/y.test.ts', sha: 'c', size: 1, mode: '100644' }
    ]
    const blobs = new Map([
      ['a', blob('a', { lines: 1000 })],
      ['b', blob('b', { lines: 1000 })],
      ['c', blob('c', { lines: 900 })]
    ])
    const kinds = new Map<string, FileKind>([
      ['pkg/a/src/x.ts', 'source'], ['pkg/b/src/y.ts', 'source'], ['pkg/b/tests/y.test.ts', 'test']
    ])
    const r = testDeficit.compute(synthetic({ tree, blobs, kinds }))
    // pkg/b is covered by its sibling tests/ and drops out; pkg/a is a real gap,
    // and the well-tested half of the monorepo must not excuse it.
    expect(r.drivers.map((d) => d.path)).toEqual(['pkg/a'])
  })
})

describe('directorySprawl', () => {
  it('excludes the root and anything under an excluded path', () => {
    const dirFileCounts = new Map([
      ['', 4],
      ['src', 0],
      ['src/a', 1],
      ['src/b', 5],
      ['node_modules/x', 1]
    ])
    const r = directorySprawl.compute(synthetic({ dirFileCounts }))
    expect(r.value).toBe(round2((2 / 3) * 100))
    expect(r.drivers.map((d) => d.path)).toEqual(['src', 'src/a'])
  })
})

describe('docBloat', () => {
  it('measures file-touches on docs over the window', () => {
    const kinds = new Map<string, FileKind>([
      ['docs/plan.md', 'doc'], ['src/a.ts', 'source'], ['pnpm-lock.yaml', 'generated']
    ])
    const commit = (sha: string, paths: string[]): CommitRecord => ({
      sha, parents: [], authorName: 'a', authorEmail: 'a@b.c', authoredAt: NOW, committedAt: NOW,
      subject: 's', isMerge: false,
      files: paths.map((p) => ({ path: p, status: 'M' as const, insertions: 1, deletions: 0, binary: false }))
    })
    const window = [
      commit('1', ['docs/plan.md', 'src/a.ts', 'pnpm-lock.yaml']),
      commit('2', ['docs/plan.md'])
    ]
    const r = docBloat.compute(synthetic({ window, kinds }))
    // Generated lockfile excluded from both sides: 2 doc touches of 3.
    expect(r.value).toBe(round2((2 / 3) * 100))
    expect(r.drivers[0]?.path).toBe('docs/plan.md')
    expect(r.drivers[0]?.value).toBe(2)
  })

  it('raises a finding when a doc is a top-5 most-churned file', () => {
    const kinds = new Map<string, FileKind>([['docs/campaign.md', 'doc'], ['src/a.ts', 'source']])
    const fileStats = new Map([
      ['docs/campaign.md', stats('docs/campaign.md', { commits: 68 })],
      ['src/a.ts', stats('src/a.ts', { commits: 4 })]
    ])
    const r = docBloat.compute(synthetic({ kinds, fileStats }))
    expect(r.findings?.length).toBe(1)
    expect(r.findings?.[0]?.title).toMatch(/single most-churned/)
  })
})

describe('siblingSprawl', () => {
  it('counts only clusters of three or more, over live scored files', () => {
    const tree: TreeEntry[] = ['a-1.md', 'a-2.md', 'a-3.md', 'b.md', 'c.md'].map((p, i) => ({
      path: `docs/${p}`, sha: `s${i}`, size: 1, mode: '100644'
    }))
    const kinds = new Map<string, FileKind>(tree.map((e) => [e.path, 'doc' as FileKind]))
    const clusters: SprawlCluster[] = [
      { stem: 'docs/a', members: ['docs/a-1.md', 'docs/a-2.md', 'docs/a-3.md'], basis: 'name', similarity: 0.9 },
      { stem: 'docs/b', members: ['docs/b.md', 'docs/deleted.md'], basis: 'name', similarity: 0.8 }
    ]
    const r = siblingSprawl.compute(synthetic({ tree, kinds, clusters }))
    expect(r.value).toBe(60) // 3 of 5
    expect(r.drivers.length).toBe(1)
    expect(r.drivers[0]?.kind).toBe('cluster')
    expect(r.findings ?? []).toEqual([]) // 3 members: below the finding threshold of 4
  })
})

describe('complexityDrift', () => {
  it('is a function ratio, not a file ratio', () => {
    const tree: TreeEntry[] = [
      { path: 'src/a.ts', sha: 'a', size: 1, mode: '100644' },
      { path: 'src/b.ts', sha: 'b', size: 1, mode: '100644' }
    ]
    const blobs = new Map([
      ['a', blob('a', { functions: 90, complexFunctions: 0, maxComplexity: 3, totalComplexity: 100 })],
      ['b', blob('b', { functions: 10, complexFunctions: 10, maxComplexity: 42, totalComplexity: 300 })]
    ])
    const kinds = new Map<string, FileKind>([['src/a.ts', 'source'], ['src/b.ts', 'source']])
    const r = complexityDrift.compute(synthetic({ tree, blobs, kinds }))
    expect(r.value).toBe(10)
    expect(r.drivers.length).toBe(1)
    expect(r.drivers[0]?.label).toBe('src/b.ts — max cc 42')
  })
})

describe('computeFileFlags / computeRisk', () => {
  const tree: TreeEntry[] = [
    { path: 'src/god.ts', sha: 'a', size: 1, mode: '100644' },
    { path: 'assets/logo.png', sha: 'b', size: 1, mode: '100644' },
    { path: 'pnpm-lock.yaml', sha: 'c', size: 1, mode: '100644' }
  ]
  const blobs = new Map([['a', blob('a', { lines: 1200, maxComplexity: 30 })]])
  const kinds = new Map<string, FileKind>([
    ['src/god.ts', 'source'], ['assets/logo.png', 'asset'], ['pnpm-lock.yaml', 'generated']
  ])
  const fileStats = new Map([
    ['src/god.ts', stats('src/god.ts', { commits: 1, added: 1200, deleted: 900, firstAt: NOW - 400 * DAY, lastAt: NOW - 400 * DAY })]
  ])
  const ctx = synthetic({
    tree, blobs, kinds, fileStats,
    clusters: [{ stem: 'src/god', members: ['src/god.ts', 'src/god2.ts', 'src/god3.ts'], basis: 'name', similarity: 0.9 }]
  })

  it('applies the full vocabulary in union order', () => {
    expect(computeFileFlags('src/god.ts', ctx)).toEqual([
      'god-file', 'write-once', 'high-rework', 'stale', 'sibling-sprawl'
    ])
    expect(computeFileFlags('assets/logo.png', ctx)).toEqual(['binary'])
    expect(computeFileFlags('pnpm-lock.yaml', ctx)).toEqual(['generated'])
  })

  it('is 0..1 and monotonic in each term', () => {
    const risk = computeRisk('src/god.ts', ctx)
    expect(risk).toBeGreaterThan(0)
    expect(risk).toBeLessThanOrEqual(1)

    // Growing a file can never make it safer.
    for (const lines of [10, 100, 800, 1600, 20000]) {
      const bigger = synthetic({
        ...ctx, blobs: new Map([['a', blob('a', { lines, maxComplexity: 30 })]])
      })
      const smaller = synthetic({
        ...ctx, blobs: new Map([['a', blob('a', { lines: Math.max(1, lines - 5), maxComplexity: 30 })]])
      })
      expect(computeRisk('src/god.ts', bigger)).toBeGreaterThanOrEqual(computeRisk('src/god.ts', smaller))
    }

    // Unknown paths are 0, not NaN.
    expect(computeRisk('does/not/exist.ts', ctx)).toBe(0)
    expect(Number.isFinite(computeRisk('src/god.ts', ctx))).toBe(true)
  })

  it('damps generated and binary files so they do not dominate the ramp', () => {
    const noisy = synthetic({
      ...ctx,
      blobs: new Map([['c', blob('c', { lines: 20000 })]]),
      fileStats: new Map([['pnpm-lock.yaml', stats('pnpm-lock.yaml', { commits: 200, added: 50000, deleted: 40000, firstAt: NOW - 400 * DAY, lastAt: NOW - 400 * DAY })]])
    })
    expect(computeRisk('pnpm-lock.yaml', noisy)).toBeLessThan(0.5)
  })
})

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------------------
// The specimen
// ---------------------------------------------------------------------------

describe.skipIf(!existsSync(SPECIMEN))('specimen: apxstream/apx-response', () => {
  it('computes all seven signals', { timeout: 900_000 }, async () => {
    const ctx = await buildContext(SPECIMEN, 30)

    const lines: string[] = []
    lines.push(`repo            ${SPECIMEN}`)
    lines.push(`head            ${ctx.headSha.slice(0, 10)}`)
    lines.push(`commits         ${ctx.history.commits.length} (window ${ctx.window.length} over ${ctx.windowDays}d)`)
    lines.push(`tree entries    ${ctx.tree.length}`)
    lines.push(`blobs analysed  ${ctx.blobs.size}`)
    const emptyDirs = [...ctx.dirFileCounts.values()].filter((n) => n === 0).length
    lines.push(`directories     ${ctx.dirFileCounts.size} (${emptyDirs} hold no direct files)`)
    lines.push(`clusters        ${ctx.clusters.length}`)
    lines.push(`mega threshold  ${ctx.megaThreshold}`)
    lines.push('')

    for (const signal of treeSignals) {
      const r = signal.compute(ctx)
      expect(Number.isFinite(r.value), signal.id).toBe(true)
      expect(r.value, signal.id).toBeGreaterThanOrEqual(0)
      expect(r.drivers.length, signal.id).toBeLessThanOrEqual(50)
      lines.push(`${signal.id.padEnd(16)} ${r.value.toFixed(2).padStart(7)}   ${r.headline}`)
      for (const d of r.drivers.slice(0, 5)) {
        lines.push(`                 · ${d.label}${d.detail ? `  (${d.detail})` : ''}`)
      }
      for (const f of r.findings ?? []) lines.push(`                 ! ${f.title}`)
      lines.push('')
    }

    // Flag and risk distribution over the live tree.
    const flagCounts = new Map<string, number>()
    const risks: number[] = []
    for (const entry of ctx.tree) {
      for (const flag of computeFileFlags(entry.path, ctx)) {
        flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1)
      }
      risks.push(computeRisk(entry.path, ctx))
    }
    risks.sort((a, b) => a - b)
    const q = (p: number): number => risks[Math.min(risks.length - 1, Math.floor(risks.length * p))] ?? 0
    lines.push(`flags           ${[...flagCounts].map(([k, v]) => `${k}=${v}`).join('  ')}`)
    lines.push(`risk p50/p90/p99/max  ${q(0.5).toFixed(3)} / ${q(0.9).toFixed(3)} / ${q(0.99).toFixed(3)} / ${q(1).toFixed(3)}`)

    // eslint-disable-next-line no-console
    console.log('\n' + lines.join('\n') + '\n')
  })
})
