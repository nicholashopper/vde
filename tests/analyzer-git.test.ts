/**
 * Scratch verification for src/analyzer/git/{repo,log,tree}.ts.
 *
 * The specimen assertions are the important ones: they pin the numstat parser
 * against a real 740-commit agent-built repository. They are skipped (not
 * failed) when the specimen is not present on the machine.
 */

import { existsSync } from 'node:fs'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { parseNumstatPath, readHistory, unquotePath } from '../src/analyzer/git/log'
import { pickSnapshotRevisions, readTree, utcDate } from '../src/analyzer/git/tree'
import { RepoValidationError, validateRepo } from '../src/analyzer/git/repo'
import { assertUnchanged, fingerprint } from '../src/analyzer/git/exec'
import type { CommitRecord, History } from '../src/analyzer/model'

const SPECIMEN = join(homedir(), 'codebase', 'apxstream', 'apx-response')
const haveSpecimen = existsSync(join(SPECIMEN, '.git'))

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

describe('parseNumstatPath', () => {
  it('reads a plain path', () => {
    expect(parseNumstatPath('src/a/b.ts')).toEqual({ path: 'src/a/b.ts' })
  })

  it('reads the compressed rename form with a common prefix', () => {
    expect(parseNumstatPath('apps/web/src/features/review/{QueueRail.tsx => ReviewList.tsx}')).toEqual({
      path: 'apps/web/src/features/review/ReviewList.tsx',
      oldPath: 'apps/web/src/features/review/QueueRail.tsx'
    })
  })

  it('reads the compressed rename form with prefix and suffix', () => {
    expect(parseNumstatPath('apps/web/src/features/{review/document => docviewer}/canvasStates.tsx')).toEqual({
      path: 'apps/web/src/features/docviewer/canvasStates.tsx',
      oldPath: 'apps/web/src/features/review/document/canvasStates.tsx'
    })
  })

  it('reads the compressed rename form with an empty side', () => {
    expect(parseNumstatPath('services/{ => vault}/fixtures/a.json')).toEqual({
      path: 'services/vault/fixtures/a.json',
      oldPath: 'services/fixtures/a.json'
    })
  })

  it('reads the uncompressed rename form', () => {
    expect(parseNumstatPath('deep/x/plain.txt => totally-different.md')).toEqual({
      path: 'totally-different.md',
      oldPath: 'deep/x/plain.txt'
    })
  })

  it('reads the uncompressed rename form when only the suffix is shared textually', () => {
    // git emits this shape because the common suffix does not start at a '/'.
    expect(parseNumstatPath('top.txt => newdir/top.txt')).toEqual({
      path: 'newdir/top.txt',
      oldPath: 'top.txt'
    })
  })

  it('reads a quoted single path', () => {
    expect(parseNumstatPath('"na\\303\\257ve fi le.txt"')).toEqual({ path: 'naïve fi le.txt' })
  })

  it('reads a rename with both sides quoted', () => {
    expect(parseNumstatPath('"d\\303\\257r/na\\303\\257ve a.txt" => "d\\303\\257r/na\\303\\257ve b.txt"')).toEqual({
      path: 'dïr/naïve b.txt',
      oldPath: 'dïr/naïve a.txt'
    })
  })

  it('reads a rename with only one side quoted', () => {
    expect(parseNumstatPath('"na\\303\\257ve.txt" => plain.txt')).toEqual({
      path: 'plain.txt',
      oldPath: 'naïve.txt'
    })
    expect(parseNumstatPath('plain.txt => "na\\303\\257ve.txt"')).toEqual({
      path: 'naïve.txt',
      oldPath: 'plain.txt'
    })
  })

  it('reads the compressed rename form when the new side is the empty one', () => {
    expect(parseNumstatPath('services/{vault => }/fixtures/a.json')).toEqual({
      path: 'services/fixtures/a.json',
      oldPath: 'services/vault/fixtures/a.json'
    })
  })

  it('does not mistake a braced filename for a rename', () => {
    // Neither side satisfies git's prefix/suffix invariants, and the arrow lies
    // inside the braces, so this is one path that merely looks like a rename.
    expect(parseNumstatPath('weird{a => b}name.txt')).toEqual({ path: 'weird{a => b}name.txt' })
  })

  it('reads an uncompressed rename whose sides contain braces', () => {
    // Verified against real git: no common prefix or suffix, so git emits the
    // uncompressed form even though both names contain braces.
    expect(parseNumstatPath('x{1}.txt => y{2}.txt')).toEqual({
      path: 'y{2}.txt',
      oldPath: 'x{1}.txt'
    })
  })
})

describe('unquotePath', () => {
  it('passes unquoted input through', () => {
    expect(unquotePath('src/a.ts')).toBe('src/a.ts')
  })

  it('decodes octal escapes as bytes, then UTF-8', () => {
    expect(unquotePath('"\\346\\227\\245\\346\\234\\254.md"')).toBe('日本.md')
  })

  it('decodes the simple escapes', () => {
    expect(unquotePath('"a\\tb\\nc\\"d\\\\e"')).toBe('a\tb\nc"d\\e')
  })
})

// ---------------------------------------------------------------------------
// pickSnapshotRevisions
// ---------------------------------------------------------------------------

const DAY = 86_400_000

function commit(sha: string, at: number, isMerge = false): CommitRecord {
  return {
    sha,
    parents: isMerge ? ['p1', 'p2'] : ['p1'],
    authorName: 'A',
    authorEmail: 'a@example.com',
    authoredAt: at,
    committedAt: at,
    subject: sha,
    files: [],
    isMerge
  }
}

function historyOf(commits: CommitRecord[]): History {
  const sorted = [...commits].sort((a, b) => b.authoredAt - a.authoredAt)
  const newest = sorted[0]
  const oldest = sorted[sorted.length - 1]
  return {
    commits: sorted,
    firstAt: oldest ? oldest.authoredAt : 0,
    lastAt: newest ? newest.authoredAt : 0,
    authors: new Map([['a@example.com', 'A']])
  }
}

describe('pickSnapshotRevisions', () => {
  const anchor = Date.UTC(2026, 5, 1, 12, 0, 0)

  it('returns nothing for an empty history', () => {
    expect(pickSnapshotRevisions(historyOf([]), 10)).toEqual([])
  })

  it('takes the last commit of each day inside the daily window', () => {
    const h = historyOf([
      commit('a', anchor - 2 * DAY - 3600_000),
      commit('b', anchor - 2 * DAY),
      commit('c', anchor - DAY),
      commit('d', anchor)
    ])
    const picked = pickSnapshotRevisions(h, 100)
    // 'b' ends day one, but the genesis commit 'a' is forced in and owns that
    // date: one snapshot per date, so no chart gets two points on one x.
    expect(picked.map((p) => p.sha)).toEqual(['a', 'c', 'd'])
    expect(new Set(picked.map((p) => p.date)).size).toBe(3)
  })

  it('prefers a non-merge representative', () => {
    const h = historyOf([
      commit('first', anchor - 5 * DAY),
      commit('real', anchor - 1000),
      commit('merge', anchor, true)
    ])
    const picked = pickSnapshotRevisions(h, 100)
    // HEAD is forced in even though it is a merge; it is the report's anchor.
    expect(picked.map((p) => p.sha)).toEqual(['first', 'merge'])

    const h2 = historyOf([
      commit('first', anchor - 5 * DAY),
      commit('real', anchor - 4 * DAY - 1000),
      commit('merge', anchor - 4 * DAY, true),
      commit('head', anchor)
    ])
    expect(pickSnapshotRevisions(h2, 100).map((p) => p.sha)).toEqual(['first', 'real', 'head'])
  })

  it('degrades to weekly then monthly cadence', () => {
    const commits: CommitRecord[] = []
    // One commit per day for a year.
    for (let d = 0; d < 365; d++) commits.push(commit(`d${d}`, anchor - d * DAY))
    const picked = pickSnapshotRevisions(historyOf(commits), 10_000)

    const dates = picked.map((p) => p.date)
    expect(new Set(dates).size).toBe(dates.length)
    expect(dates).toEqual([...dates].sort())

    // 90 daily + ~13 weekly + ~6 monthly, plus the forced genesis point.
    expect(picked.length).toBeGreaterThan(100)
    expect(picked.length).toBeLessThan(120)
    expect(picked[picked.length - 1]?.sha).toBe('d0')
    expect(picked[0]?.sha).toBe('d364')
  })

  it('thins the oldest buckets first and always keeps genesis and HEAD', () => {
    const commits: CommitRecord[] = []
    for (let d = 0; d < 365; d++) commits.push(commit(`d${d}`, anchor - d * DAY))
    const h = historyOf(commits)
    const picked = pickSnapshotRevisions(h, 30)

    expect(picked).toHaveLength(30)
    expect(picked[0]?.sha).toBe('d364')
    expect(picked[picked.length - 1]?.sha).toBe('d0')
    // Everything after genesis is inside the daily window, i.e. recent.
    expect(picked[1]?.sha).toBe('d28')
  })

  it('honours degenerate caps', () => {
    const h = historyOf([commit('a', anchor - DAY), commit('b', anchor)])
    expect(pickSnapshotRevisions(h, 0)).toEqual([])
    expect(pickSnapshotRevisions(h, 1).map((p) => p.sha)).toEqual(['b'])
    expect(pickSnapshotRevisions(h, 2).map((p) => p.sha)).toEqual(['a', 'b'])
  })

  it('formats dates as UTC YYYY-MM-DD', () => {
    expect(utcDate(Date.UTC(2026, 6, 7, 18, 27, 55))).toBe('2026-07-07')
  })
})

// ---------------------------------------------------------------------------
// validateRepo against synthetic repositories
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'vde-git-test-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
}

function makeRepo(name: string): string {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  return dir
}

describe('validateRepo', () => {
  it('rejects a path that does not exist', async () => {
    await expect(validateRepo(join(scratch, 'nope'))).rejects.toMatchObject({ problem: 'not-found' })
  })

  it('rejects a file', async () => {
    const f = join(scratch, 'a-file.txt')
    writeFileSync(f, 'x')
    await expect(validateRepo(f)).rejects.toMatchObject({ problem: 'not-a-directory' })
  })

  it('rejects a directory that is not a repository', async () => {
    const d = join(scratch, 'plain')
    mkdirSync(d, { recursive: true })
    await expect(validateRepo(d)).rejects.toMatchObject({ problem: 'not-a-repo' })
  })

  it('rejects a repository with no commits', async () => {
    const d = makeRepo('empty')
    await expect(validateRepo(d)).rejects.toMatchObject({ problem: 'empty' })
  })

  it('rejects a bare repository', async () => {
    const d = join(scratch, 'bare.git')
    mkdirSync(d, { recursive: true })
    git(d, 'init', '-q', '--bare')
    await expect(validateRepo(d)).rejects.toMatchObject({ problem: 'bare' })
  })

  it('describes a working repository and snaps to its root', async () => {
    const d = makeRepo('good')
    mkdirSync(join(d, 'sub'), { recursive: true })
    writeFileSync(join(d, 'sub', 'a.txt'), 'one\ntwo\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'first')
    writeFileSync(join(d, 'sub', 'a.txt'), 'one\ntwo\nthree\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'second')

    const fromSub = await validateRepo(join(d, 'sub'))
    expect(fromSub.commitCount).toBe(2)
    expect(fromSub.name).toBe('good')
    expect(fromSub.head).toMatch(/^[0-9a-f]{40}$/)
    expect(fromSub.branch).not.toBeNull()
    expect(fromSub.lastScanAt).toBeNull()
    expect(new Date(fromSub.firstCommitAt).getTime()).toBeLessThanOrEqual(new Date(fromSub.lastCommitAt).getTime())

    const fromRoot = await validateRepo(d)
    expect(fromRoot.id).toBe(fromSub.id)
    expect(fromRoot.path).toBe(fromSub.path)
    expect(fromRoot.id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('reports a detached HEAD as no branch', async () => {
    const d = makeRepo('detached')
    writeFileSync(join(d, 'a.txt'), 'x\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'first')
    git(d, 'checkout', '-q', '--detach', 'HEAD')
    const ref = await validateRepo(d)
    expect(ref.branch).toBeNull()
  })

  it('is a RepoValidationError, not a bare Error', async () => {
    await expect(validateRepo(join(scratch, 'still-nope'))).rejects.toBeInstanceOf(RepoValidationError)
  })
})

// ---------------------------------------------------------------------------
// readHistory / readTree against synthetic repositories
// ---------------------------------------------------------------------------

describe('readHistory statuses', () => {
  it('reports add, modify, delete and rename', async () => {
    const d = makeRepo('statuses')
    writeFileSync(join(d, 'keep.txt'), 'a\nb\nc\n')
    writeFileSync(join(d, 'gone.txt'), 'x\n')
    writeFileSync(join(d, 'moved.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'add three')

    writeFileSync(join(d, 'keep.txt'), 'a\nb\nc\nd\n')
    git(d, 'rm', '-q', 'gone.txt')
    git(d, 'mv', 'moved.txt', 'renamed.txt')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'churn')

    const h = await readHistory(d)
    expect(h.commits).toHaveLength(2)

    const newest = h.commits[0]
    const oldest = h.commits[1]
    expect(newest?.subject).toBe('churn')
    expect(oldest?.subject).toBe('add three')
    expect(h.authors.get('test@example.com')).toBe('Test')
    expect(h.firstAt).toBeLessThanOrEqual(h.lastAt)

    const byPath = new Map((newest?.files ?? []).map((f) => [f.path, f]))
    expect(byPath.get('keep.txt')?.status).toBe('M')
    expect(byPath.get('keep.txt')?.insertions).toBe(1)
    expect(byPath.get('gone.txt')?.status).toBe('D')
    expect(byPath.get('gone.txt')?.deletions).toBe(1)
    expect(byPath.get('renamed.txt')?.status).toBe('R')
    expect(byPath.get('renamed.txt')?.oldPath).toBe('moved.txt')

    for (const f of oldest?.files ?? []) expect(f.status).toBe('A')
  })

  it('records merges with no file rows', async () => {
    const d = makeRepo('merges')
    writeFileSync(join(d, 'base.txt'), 'base\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'base')
    git(d, 'checkout', '-q', '-b', 'side')
    writeFileSync(join(d, 'side.txt'), 'side\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'side work')
    git(d, 'checkout', '-q', '-')
    writeFileSync(join(d, 'main.txt'), 'main\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'main work')
    git(d, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')

    const h = await readHistory(d)
    const merge = h.commits.find((c) => c.isMerge)
    expect(merge).toBeDefined()
    expect(merge?.parents).toHaveLength(2)
    expect(merge?.files).toHaveLength(0)
  })

  it('handles binary files and unusual path bytes', async () => {
    const d = makeRepo('exotic')
    writeFileSync(join(d, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
    writeFileSync(join(d, 'naïve na me.txt'), 'x\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'exotic')

    const h = await readHistory(d)
    const files = h.commits[0]?.files ?? []
    const bin = files.find((f) => f.path === 'blob.bin')
    expect(bin?.binary).toBe(true)
    expect(bin?.insertions).toBe(0)
    expect(files.map((f) => f.path)).toContain('naïve na me.txt')

    const tree = await readTree(d, 'HEAD')
    expect(tree.map((e) => e.path).sort()).toEqual(['blob.bin', 'naïve na me.txt'])
    for (const e of tree) {
      expect(e.sha).toMatch(/^[0-9a-f]{40}$/)
      expect(e.size).toBeGreaterThan(0)
      expect(e.mode).toBe('100644')
    }
  })

  it('reports progress and honours cancellation', async () => {
    const d = makeRepo('cancel')
    writeFileSync(join(d, 'a.txt'), 'x\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'only')

    const seen: number[] = []
    await readHistory(d, { onProgress: (n) => seen.push(n) })
    expect(seen.at(-1)).toBe(1)

    const ac = new AbortController()
    ac.abort()
    await expect(readHistory(d, { signal: ac.signal })).rejects.toMatchObject({ name: 'Cancelled' })
    await expect(readTree(d, 'HEAD', { signal: ac.signal })).rejects.toMatchObject({ name: 'Cancelled' })
  })

  it('refuses an option-shaped revision', async () => {
    const d = makeRepo('revguard')
    writeFileSync(join(d, 'a.txt'), 'x\n')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'only')
    await expect(readTree(d, '--help')).rejects.toThrow(/would be read as a git option/)
  })
})

// ---------------------------------------------------------------------------
// The calibration specimen
// ---------------------------------------------------------------------------

describe.skipIf(!haveSpecimen)('specimen: apx-response', () => {
  it('matches the calibrated history numbers', async () => {
    const h = await readHistory(SPECIMEN)

    expect(h.commits).toHaveLength(740)
    expect(utcDate(h.firstAt)).toBe('2026-07-07')

    let insertions = 0
    let deletions = 0
    let insertionsExRenames = 0
    let deletionsExRenames = 0
    for (const c of h.commits) {
      if (c.isMerge) continue
      for (const f of c.files) {
        insertions += f.insertions
        deletions += f.deletions
        if (f.oldPath === undefined) {
          insertionsExRenames += f.insertions
          deletionsExRenames += f.deletions
        }
      }
    }
    expect(insertions).toBe(1_207_450)
    expect(deletions).toBe(42_157)

    // The brief quotes 1,207,163 / 40,514 as ground truth. That figure comes
    // from an awk-style `NF == 3` filter over numstat output, which silently
    // drops every rename row — a rename's path field contains spaces, so it
    // splits into five fields, not three. Reproducing the quoted numbers
    // exactly by excluding rename rows proves the difference is the 1,252
    // renames this parser now captures, not a parsing error.
    expect(insertionsExRenames).toBe(1_207_163)
    expect(deletionsExRenames).toBe(40_514)

    // Rename detection must survive the parse.
    const renames = h.commits.flatMap((c) => c.files.filter((f) => f.status === 'R'))
    expect(renames.length).toBeGreaterThan(1000)
    for (const r of renames) expect(r.oldPath).toBeTruthy()
    // No path may keep the raw combined rename text.
    for (const c of h.commits) for (const f of c.files) expect(f.path).not.toContain(' => ')

    // Status letters come from the name-status pass, so every letter is real.
    const statuses = new Set(h.commits.flatMap((c) => c.files.map((f) => f.status)))
    expect(statuses.has('A')).toBe(true)
    expect(statuses.has('M')).toBe(true)
    expect(statuses.has('D')).toBe(true)
    expect(statuses.has('R')).toBe(true)

    expect(h.commits.every((c, i) => i === 0 || (h.commits[i - 1]?.authoredAt ?? 0) >= c.authoredAt)).toBe(true)
  }, 120_000)

  it('leaves the repository byte-for-byte unchanged', async () => {
    // The whole product rests on this. Fingerprint, do the heaviest reads
    // these modules perform, and prove nothing moved.
    const before = await fingerprint(SPECIMEN)
    await readHistory(SPECIMEN)
    await readTree(SPECIMEN, 'HEAD')
    await validateRepo(SPECIMEN)
    assertUnchanged(before, await fingerprint(SPECIMEN), SPECIMEN)
  }, 120_000)

  it('validates and reads its tree', async () => {
    const ref = await validateRepo(SPECIMEN)
    expect(ref.commitCount).toBe(740)
    expect(ref.firstCommitAt.slice(0, 10)).toBe('2026-07-07')
    expect(ref.name).toBe('apx-response')

    const tree = await readTree(SPECIMEN, ref.head)
    expect(tree.length).toBeGreaterThan(3000)
    expect(new Set(tree.map((e) => e.path)).size).toBe(tree.length)
    for (const e of tree) expect(e.path).not.toMatch(/^"/)
  }, 120_000)
})
