import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GitReadOnlyViolation,
  assertUnchanged,
  fingerprint,
  run,
  streamLines,
  __testing
} from '../src/analyzer/git/exec'

/**
 * The read-only guarantee is VDE's most important promise: it points at other
 * people's repositories, and it must be *incapable* of changing them rather
 * than merely uninterested. These tests exercise the gateway directly, and then
 * prove the tripwire works on a real repository.
 */

let repo: string

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'vde-readonly-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: repo,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 't@example.com'
      }
    })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 't@example.com')
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  git('add', 'a.txt')
  git('commit', '-qm', 'feat: add a.txt')
  writeFileSync(join(repo, 'b.txt'), 'world\n')
  git('add', 'b.txt')
  git('commit', '-qm', 'feat: add b.txt')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('the subcommand allowlist', () => {
  const writing = [
    ['commit', '-m', 'x'],
    ['add', '.'],
    ['push'],
    ['fetch'],
    ['pull'],
    ['checkout', 'main'],
    ['switch', 'main'],
    ['reset', '--hard'],
    ['clean', '-fd'],
    ['rm', 'a.txt'],
    ['mv', 'a.txt', 'c.txt'],
    ['merge', 'main'],
    ['rebase', 'main'],
    ['stash'],
    ['tag', 'v1'],
    ['branch', 'x'],
    ['gc'],
    ['prune'],
    ['filter-branch'],
    ['update-ref', 'refs/heads/main', 'HEAD'],
    ['hash-object', '-w', 'a.txt'],
    ['apply', 'p.patch'],
    ['am', 'p.patch'],
    ['cherry-pick', 'HEAD'],
    ['revert', 'HEAD'],
    ['worktree', 'add', '/tmp/x'],
    ['submodule', 'update'],
    ['init'],
    ['clone', 'x', 'y'],
    ['remote', 'add', 'o', 'u'],
    ['bisect', 'start'],
    ['notes', 'add'],
    ['replace', 'a', 'b'],
    ['repack'],
    ['fsck'],
    ['maintenance', 'run'],
    ['sparse-checkout', 'set', 'x'],
    ['restore', 'a.txt']
  ]

  it.each(writing)('refuses to run "git %s"', async (...args) => {
    await expect(run(repo, args)).rejects.toBeInstanceOf(GitReadOnlyViolation)
  })

  it('refuses an empty invocation', async () => {
    await expect(run(repo, [])).rejects.toBeInstanceOf(GitReadOnlyViolation)
  })

  it('applies the allowlist to streamLines too, not just run', async () => {
    await expect(streamLines(repo, ['commit', '-m', 'x'], () => {})).rejects.toBeInstanceOf(
      GitReadOnlyViolation
    )
  })
})

describe('the argument denylist', () => {
  const dangerous: string[][] = [
    // -c could reinstate the config holes the gateway closes (a pager or an
    // fsmonitor is an arbitrary command).
    ['log', '-c', 'core.pager=sh -c "touch /tmp/pwned"'],
    ['log', '--config-env=core.pager=EVIL'],
    // These escape the validated repository path.
    ['log', '-C', '/etc'],
    ['log', '--git-dir=/somewhere/else/.git'],
    ['log', '--work-tree=/'],
    // These name a program to execute.
    ['log', '--exec-path=/tmp/evil'],
    ['ls-tree', '--upload-pack=/tmp/evil', 'HEAD'],
    ['ls-tree', '--receive-pack=/tmp/evil', 'HEAD'],
    // -w makes an otherwise-read command write into the object store.
    ['cat-file', '-w'],
    ['blame', '--write']
  ]

  it.each(dangerous)('refuses "git %s %s"', async (...args) => {
    await expect(run(repo, args)).rejects.toBeInstanceOf(GitReadOnlyViolation)
  })

  it('permits git config only in read form', async () => {
    await expect(run(repo, ['config', 'user.name', 'attacker'])).rejects.toBeInstanceOf(
      GitReadOnlyViolation
    )
    await expect(run(repo, ['config', '--unset', 'user.name'])).rejects.toBeInstanceOf(
      GitReadOnlyViolation
    )
    await expect(run(repo, ['config', '--global', 'user.name', 'x'])).rejects.toBeInstanceOf(
      GitReadOnlyViolation
    )
    // The read forms are allowed.
    await expect(run(repo, ['config', '--get', 'user.name'])).resolves.toContain('Test')
  })
})

describe('permitted reads still work', () => {
  it('reads the log', async () => {
    const out = await run(repo, ['log', '--format=%s'])
    expect(out).toContain('feat: add b.txt')
    expect(out).toContain('feat: add a.txt')
  })

  it('reads a tree', async () => {
    const out = await run(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])
    expect(out.split('\n').filter(Boolean).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('streams lines', async () => {
    const lines: string[] = []
    await streamLines(repo, ['log', '--format=%H'], (l) => lines.push(l))
    expect(lines.filter(Boolean)).toHaveLength(2)
  })
})

describe('the tripwire', () => {
  it('reports a repository as unchanged after a full read pass', async () => {
    const before = await fingerprint(repo)
    // Everything a scan actually does.
    await run(repo, ['log', '--numstat', '--format=%H'])
    await run(repo, ['ls-tree', '-r', '-l', 'HEAD'])
    await run(repo, ['rev-list', '--count', 'HEAD'])
    await run(repo, ['for-each-ref'])
    const after = await fingerprint(repo)
    expect(() => assertUnchanged(before, after, repo)).not.toThrow()
  })

  it('detects a HEAD change', async () => {
    const before = await fingerprint(repo)
    const after = { ...before, head: 'f'.repeat(40) }
    expect(() => assertUnchanged(before, after, repo)).toThrow(GitReadOnlyViolation)
  })

  it('detects a ref change', async () => {
    const before = await fingerprint(repo)
    expect(() => assertUnchanged(before, { ...before, refs: 'different' }, repo)).toThrow(
      GitReadOnlyViolation
    )
  })

  it('detects an index touch', async () => {
    const before = await fingerprint(repo)
    expect(() =>
      assertUnchanged(before, { ...before, indexMtimeMs: (before.indexMtimeMs ?? 0) + 1000 }, repo)
    ).toThrow(GitReadOnlyViolation)
  })
})

describe('the guard is exhaustive by construction', () => {
  it('allows only subcommands that cannot write', () => {
    // If someone adds a subcommand to the allowlist, it has to appear here too.
    // The point is to make widening the allowlist a deliberate act.
    expect([...__testing.ALLOWED].sort()).toEqual(
      [
        'blame',
        'cat-file',
        'config',
        'count-objects',
        'describe',
        'diff',
        'diff-tree',
        'for-each-ref',
        'log',
        'ls-files',
        'ls-tree',
        'merge-base',
        'name-rev',
        'rev-list',
        'rev-parse',
        'shortlog',
        'show',
        'symbolic-ref',
        'var'
      ].sort()
    )
  })
})
