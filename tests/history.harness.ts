/**
 * A standalone AnalysisContext builder, used only by tests/history.signals.test.ts.
 *
 * The real History / FileStats / tree-scan modules are owned by other parts of
 * the engine and may not exist yet. This harness reproduces just enough of them,
 * through the read-only git gateway, to run the history signals against a real
 * repository and check the numbers against independent measurement.
 *
 * It is a test fixture, not production code — but it goes through
 * src/analyzer/git/exec.ts like everything else, because nothing in VDE talks to
 * git any other way.
 */

import { run } from '../src/analyzer/git/exec'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import type {
  AnalysisContext,
  BlobAnalysis,
  ChangeStatus,
  CommitRecord,
  FileChange,
  FileKind,
  FileStats,
  History,
  TreeEntry
} from '../src/analyzer/model'

const NUL = '\u0000'
const SOH = '\u0001'
const FS = '\u001f'
const DAY_MS = 86_400_000

/** The well-known empty tree object; diffing against it yields every file's length. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// ---------------------------------------------------------------------------
// git log → CommitRecord[]
// ---------------------------------------------------------------------------

export async function readHistory(repoPath: string): Promise<History> {
  const format = `--format=%x01%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%ct${FS}%s`
  const raw = await run(repoPath, ['log', 'HEAD', '--numstat', '-z', '-M', format], { timeoutMs: 600_000 })

  const commits: CommitRecord[] = []
  const authors = new Map<string, string>()

  for (const chunk of raw.split(SOH)) {
    if (chunk.length === 0) continue
    const headerEnd = chunk.indexOf(NUL)
    if (headerEnd === -1) continue
    const fields = chunk.slice(0, headerEnd).split(FS)
    const sha = fields[0] ?? ''
    if (sha.length === 0) continue
    const parents = (fields[1] ?? '').split(' ').filter((p) => p.length > 0)
    const authorName = fields[2] ?? ''
    const authorEmail = fields[3] ?? ''
    const authoredAt = Number(fields[4] ?? 0) * 1000
    const committedAt = Number(fields[5] ?? 0) * 1000
    const subject = fields[6] ?? ''
    authors.set(authorEmail, authorName)

    const body = chunk.slice(headerEnd + 1).replace(/^\n/, '')
    const parts = body.split(NUL)
    const files: FileChange[] = []
    for (let i = 0; i < parts.length; i++) {
      const rec = parts[i]
      if (rec === undefined || rec.length === 0) continue
      const seg = rec.split('\t')
      if (seg.length < 3) continue
      const binary = seg[0] === '-'
      const insertions = binary ? 0 : Number(seg[0] ?? 0)
      const deletions = binary ? 0 : Number(seg[1] ?? 0)
      // Rename form: "add<TAB>del<TAB>" then two more NUL-separated fields.
      if (seg[2] === '') {
        const oldPath = parts[i + 1] ?? ''
        const newPath = parts[i + 2] ?? ''
        i += 2
        if (newPath === '') continue
        files.push({ path: newPath, oldPath, status: 'R' as ChangeStatus, insertions, deletions, binary })
      } else {
        files.push({ path: seg.slice(2).join('\t'), status: 'M' as ChangeStatus, insertions, deletions, binary })
      }
    }

    commits.push({
      sha,
      parents,
      authorName,
      authorEmail,
      authoredAt,
      committedAt,
      subject,
      files,
      isMerge: parents.length > 1
    })
  }

  const times = commits.map((c) => c.authoredAt)
  return {
    commits,
    firstAt: times.length > 0 ? Math.min(...times) : 0,
    lastAt: times.length > 0 ? Math.max(...times) : 0,
    authors
  }
}

// ---------------------------------------------------------------------------
// Tree + per-file line counts
// ---------------------------------------------------------------------------

export async function readTree(repoPath: string): Promise<{ tree: TreeEntry[]; blobs: Map<string, BlobAnalysis> }> {
  const listing = await run(repoPath, ['ls-tree', '-r', '-l', '-z', 'HEAD'], { timeoutMs: 600_000 })

  const tree: TreeEntry[] = []
  for (const rec of listing.split(NUL)) {
    if (rec.length === 0) continue
    const tab = rec.indexOf('\t')
    if (tab === -1) continue
    const meta = rec.slice(0, tab).split(/\s+/)
    const path = rec.slice(tab + 1)
    const mode = meta[0] ?? ''
    const type = meta[1] ?? ''
    const sha = meta[2] ?? ''
    const sizeRaw = meta[3] ?? '-'
    if (type !== 'blob') continue
    tree.push({ path, sha, size: sizeRaw === '-' ? -1 : Number(sizeRaw), mode })
  }

  // One diff against the empty tree gives the line count of every text file at
  // HEAD, which is exactly what BlobAnalysis.lines holds — and costs one process
  // instead of 4,000 cat-file calls.
  const numstat = await run(repoPath, ['diff', '--numstat', '-z', '--no-renames', EMPTY_TREE, 'HEAD'], {
    timeoutMs: 600_000
  })
  const linesByPath = new Map<string, number>()
  const binaryPaths = new Set<string>()
  for (const rec of numstat.split(NUL)) {
    if (rec.length === 0) continue
    const seg = rec.split('\t')
    if (seg.length < 3) continue
    const path = seg.slice(2).join('\t')
    if (seg[0] === '-') binaryPaths.add(path)
    else linesByPath.set(path, Number(seg[0] ?? 0))
  }

  const blobs = new Map<string, BlobAnalysis>()
  for (const entry of tree) {
    const binary = binaryPaths.has(entry.path)
    blobs.set(entry.sha, {
      sha: entry.sha,
      bytes: entry.size < 0 ? 0 : entry.size,
      lines: linesByPath.get(entry.path) ?? 0,
      codeLines: null,
      language: null,
      binary,
      functions: null,
      totalComplexity: null,
      maxComplexity: null,
      complexFunctions: null,
      simhash: null
    })
  }

  return { tree, blobs }
}

// ---------------------------------------------------------------------------
// Classification (a deliberately small stand-in for the real classifier)
// ---------------------------------------------------------------------------

const SOURCE_EXT = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'rb',
  'php',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'swift',
  'scala',
  'sh',
  'bash',
  'zsh',
  'sql',
  'css',
  'scss',
  'less',
  'html',
  'vue',
  'svelte'
])

const CONFIG_EXT = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'xml'])
const DOC_EXT = new Set(['md', 'mdx', 'rst', 'txt', 'adoc'])
const ASSET_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'woff', 'woff2', 'ttf', 'pdf', 'zip'])

export function classify(path: string): FileKind {
  const lower = path.toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const ext = dot === -1 ? '' : base.slice(dot + 1)

  if (/(^|\/)(node_modules|vendor|third_party|dist|build|out|\.next|target|__pycache__|\.venv)\//.test(lower)) {
    return 'vendored'
  }
  if (/\.(lock|min\.js|min\.css)$/.test(lower)) return 'generated'
  if (/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|poetry\.lock|cargo\.lock|uv\.lock)$/.test(lower)) {
    return 'generated'
  }
  if (/\.(gen|generated)\.[a-z]+$/.test(lower) || /\.pb\.go$/.test(lower) || /_pb2\.py$/.test(lower)) {
    return 'generated'
  }
  if (/(^|\/)schema\.d\.ts$/.test(lower)) return 'generated'

  if (ASSET_EXT.has(ext)) return 'asset'
  if (DOC_EXT.has(ext)) return 'doc'

  const isTestPath =
    /(^|\/)(tests?|__tests__|spec|specs|e2e)\//.test(lower) ||
    /\.(test|spec)\.[a-z]+$/.test(base) ||
    /(^|\/)test_[^/]+\.py$/.test(lower) ||
    /_test\.[a-z]+$/.test(base)
  if (isTestPath && (SOURCE_EXT.has(ext) || ext === '')) return 'test'

  if (SOURCE_EXT.has(ext)) return 'source'
  if (CONFIG_EXT.has(ext)) return 'config'
  if (base === 'dockerfile' || base === 'makefile' || base === 'justfile') return 'config'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// FileStats, following renames
// ---------------------------------------------------------------------------

interface Seen {
  first: number
  last: number
}

export function buildFileStats(history: History, treePaths: Set<string>): Map<string, FileStats> {
  // Rename edges, newest-first through the log. `alive` old paths are skipped:
  // a vacated path that exists again today is a different file.
  const successor = new Map<string, string>()
  const edgeAt = new Map<string, number>()
  const seen = new Map<string, Seen>()

  const note = (path: string, at: number): void => {
    const s = seen.get(path)
    if (s === undefined) seen.set(path, { first: at, last: at })
    else {
      if (at < s.first) s.first = at
      if (at > s.last) s.last = at
    }
  }

  for (const c of history.commits) {
    if (c.isMerge) continue
    for (const f of c.files) {
      note(f.path, c.authoredAt)
      if (f.oldPath !== undefined && f.oldPath !== '' && f.oldPath !== f.path) {
        note(f.oldPath, c.authoredAt)
        if (treePaths.has(f.oldPath)) continue
        if (!successor.has(f.oldPath)) {
          successor.set(f.oldPath, f.path)
          edgeAt.set(f.oldPath, c.authoredAt)
        }
      }
    }
  }

  const canonMemo = new Map<string, string>()
  const canon = (start: string): string => {
    const hit = canonMemo.get(start)
    if (hit !== undefined) return hit
    let cur = start
    for (let hops = 0; hops < 32; hops++) {
      const next = successor.get(cur)
      if (next === undefined || next === cur || next === start) break
      cur = next
    }
    canonMemo.set(start, cur)
    return cur
  }

  const stats = new Map<string, FileStats>()
  const ensure = (path: string): FileStats => {
    let s = stats.get(path)
    if (s === undefined) {
      s = {
        path,
        commits: 0,
        authors: new Set<string>(),
        firstAt: Number.POSITIVE_INFINITY,
        lastAt: 0,
        added: 0,
        deleted: 0,
        alive: treePaths.has(path),
        formerPaths: [],
        touchedBy: []
      }
      stats.set(path, s)
    }
    return s
  }

  for (const c of history.commits) {
    if (c.isMerge) continue
    for (const f of c.files) {
      const s = ensure(canon(f.path))
      s.commits++
      s.added += f.insertions
      s.deleted += f.deletions
      s.authors.add(c.authorEmail)
      if (c.authoredAt < s.firstAt) s.firstAt = c.authoredAt
      if (c.authoredAt > s.lastAt) s.lastAt = c.authoredAt
      if (s.touchedBy.length < 200) s.touchedBy.push(c.sha)
    }
  }

  // Former paths get their own (dead) entry, and are attached to the successor
  // newest-rename-first, exactly as FileStats.formerPaths is specified.
  const formers = new Map<string, Array<{ path: string; at: number }>>()
  for (const [former] of successor) {
    const target = canon(former)
    if (target === former) continue
    const list = formers.get(target) ?? []
    list.push({ path: former, at: edgeAt.get(former) ?? 0 })
    formers.set(target, list)
    const s = ensure(former)
    const obs = seen.get(former)
    if (obs) {
      s.firstAt = Math.min(s.firstAt, obs.first)
      s.lastAt = Math.max(s.lastAt, obs.last)
    }
  }
  for (const [target, list] of formers) {
    list.sort((a, b) => b.at - a.at)
    ensure(target).formerPaths = list.map((e) => e.path)
  }

  for (const s of stats.values()) {
    if (!Number.isFinite(s.firstAt)) s.firstAt = s.lastAt
  }
  return stats
}

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  windowDays?: number
}

export async function buildContext(repoPath: string, opts: HarnessOptions = {}): Promise<AnalysisContext> {
  const windowDays = opts.windowDays ?? 90
  const history = await readHistory(repoPath)
  const { tree, blobs } = await readTree(repoPath)

  const treePaths = new Set(tree.map((e) => e.path))
  const fileStats = buildFileStats(history, treePaths)

  const kinds = new Map<string, FileKind>()
  for (const e of tree) kinds.set(e.path, classify(e.path))
  for (const p of fileStats.keys()) if (!kinds.has(p)) kinds.set(p, classify(p))

  const dirFileCounts = new Map<string, number>()
  for (const e of tree) {
    const i = e.path.lastIndexOf('/')
    const dir = i === -1 ? '' : e.path.slice(0, i)
    dirFileCounts.set(dir, (dirFileCounts.get(dir) ?? 0) + 1)
  }

  const nonMerge = history.commits.filter((c) => !c.isMerge)
  const sizes = nonMerge.map((c) => c.files.length).sort((a, b) => a - b)
  const p90 = sizes.length === 0 ? 0 : (sizes[Math.min(sizes.length - 1, Math.ceil(0.9 * sizes.length) - 1)] ?? 0)
  const megaThreshold = Math.max(25, Math.round(p90 * 2.5))

  const head = history.commits[0]
  const now = head?.authoredAt ?? Date.now()
  const windowStart = now - windowDays * DAY_MS
  const window = nonMerge.filter((c) => c.authoredAt >= windowStart)

  return {
    repoId: 'harness',
    repoPath,
    settings: DEFAULT_SETTINGS,
    headSha: head?.sha ?? '',
    now,
    history,
    window,
    windowDays,
    tree,
    blobs,
    kinds,
    fileStats,
    dirFileCounts,
    clusters: [],
    megaThreshold
  }
}
