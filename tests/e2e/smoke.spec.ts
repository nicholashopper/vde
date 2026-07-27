import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeFileSync } from 'node:fs'

/**
 * The end-to-end smoke test.
 *
 * It builds a small but *real* repository in a temp directory — including the
 * pathologies VDE exists to detect — launches the packaged main process, adds
 * that repo, scans it, and asserts the dashboard actually renders numbers.
 *
 * It also re-asserts the read-only guarantee at the outermost level: the repo's
 * HEAD and index must be byte-identical after a full scan through the real app,
 * not just in a unit test of the gateway.
 */

const ROOT = resolve(import.meta.dirname, '../..')

let app: ElectronApplication
let page: Page
let repo: string
let headBefore: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Vibe Coder',
      GIT_AUTHOR_EMAIL: 'vibe@example.com',
      GIT_COMMITTER_NAME: 'Vibe Coder',
      GIT_COMMITTER_EMAIL: 'vibe@example.com'
    }
  })
}

/** A repository with deliberate slop, so the signals have something to find. */
function buildSpecimen(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vde-e2e-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Vibe Coder')
  git(dir, 'config', 'user.email', 'vibe@example.com')

  const commit = (msg: string): void => {
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '--allow-empty', '-m', msg)
  }

  // A god file that only ever grows — pure accretion.
  let god = ''
  for (let i = 0; i < 12; i += 1) {
    god += Array.from({ length: 90 }, (_, n) => `export const v${i}_${n} = ${n};`).join('\n') + '\n'
    writeFileSync(join(dir, 'app.ts'), god)
    commit(i === 0 ? 'feat: add app' : 'update')
  }

  // Sibling sprawl — the signature agent failure.
  for (const name of [
    'notes-final.md',
    'notes-final-2.md',
    'notes-final-3.md',
    'notes-final-really.md'
  ]) {
    writeFileSync(join(dir, name), `# Notes\n\nSome very similar prose about the same thing.\n`)
  }
  commit('docs: add notes')

  // File thrash — created then abandoned.
  writeFileSync(join(dir, 'scratch.ts'), 'export const scratch = 1\n')
  commit('feat: add scratch')
  rmSync(join(dir, 'scratch.ts'))
  commit('chore: remove scratch')

  // A test file, so Test Deficit can report good news for something.
  writeFileSync(join(dir, 'app.test.ts'), 'it("works", () => {})\n')
  commit('test: add a test')

  return dir
}

test.beforeAll(async () => {
  if (!existsSync(join(ROOT, 'out/main/index.js'))) {
    throw new Error('run `pnpm build` before the e2e suite')
  }
  repo = buildSpecimen()
  headBefore = git(repo, 'rev-parse', 'HEAD').trim()

  // A throwaway userData directory so the test never touches real settings or
  // a real database.
  // The switch MUST precede the app path: electron treats everything after the
  // app path as an argument *to the app*, so `[ROOT, '--user-data-dir', dir]`
  // is silently ignored and the suite runs against the developer's real
  // database — which is exactly how it once passed against a stale repository.
  const userData = mkdtempSync(join(tmpdir(), 'vde-e2e-data-'))
  app = await electron.launch({
    args: [`--user-data-dir=${userData}`, ROOT],
    env: { ...process.env, NODE_ENV: 'test', VDE_DEVTOOLS: '' }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  if (repo) rmSync(repo, { recursive: true, force: true })
})

test('the window opens with the app shell', async () => {
  await expect(page.locator('#root')).toBeVisible()
  // The empty state is the correct first screen with no repositories added.
  await expect(page.getByText(/repositor/i).first()).toBeVisible({ timeout: 30_000 })
})

test('adds and scans a repository, then renders signals', async () => {
  // Drive through the exposed API rather than the native directory dialog,
  // which Playwright cannot operate.
  await page.evaluate(async (path) => {
    const repoRef = await window.vde.repos.add(path)
    await window.vde.analysis.scan(repoRef.id, { force: true })
  }, repo)

  await page.reload()
  await page.waitForLoadState('domcontentloaded')

  // Every one of the fourteen signals should be on screen with a value.
  await expect(page.getByText('Accretion').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Sibling Sprawl').first()).toBeVisible()
  await expect(page.getByText('God Files').first()).toBeVisible()

  const report = await page.evaluate(async () => {
    const repos = await window.vde.repos.list()
    const first = repos[0]
    if (!first) return null
    return window.vde.analysis.report(first.id, '7d')
  })

  expect(report).not.toBeNull()
  expect(report?.signals).toHaveLength(14)
  // The specimen is nearly pure accretion by construction.
  const accretion = report?.signals.find((s) => s.id === 'accretion')
  expect(accretion?.value).toBeGreaterThan(50)
  // And the four notes-final files must have been clustered.
  const sprawl = report?.signals.find((s) => s.id === 'siblingSprawl')
  expect(sprawl?.value).toBeGreaterThan(0)
})

test('generates a remediation brief', async () => {
  const brief = await page.evaluate(async () => {
    const repos = await window.vde.repos.list()
    const first = repos[0]
    if (!first) return ''
    return window.vde.brief.generate(first.id)
  })
  expect(brief).toContain('# VDE remediation brief')
  expect(brief.length).toBeGreaterThan(200)
})

test('the repository was not modified by the scan', () => {
  expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
  // A clean status proves the working tree and index are untouched.
  expect(git(repo, 'status', '--porcelain').trim()).toBe('')
})
