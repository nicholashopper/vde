import { BrowserWindow, clipboard, dialog, ipcMain, shell, app } from 'electron'
import { writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { CHANNELS } from '../shared/ipc'
import type { BaselineKind, Platform, RepoRef, RepoReport, ScanOptions, Settings } from '../shared/types'
import { analyzerHost } from './analyzer-host'
import { getSettings, setSettings } from './settings'

/**
 * The renderer's entire capability surface.
 *
 * The renderer has no Node integration and no direct filesystem access; every
 * privileged action it can take is one of the handlers below. Two of them take
 * paths from the renderer and are therefore validated: `revealFile` (which must
 * not be able to point outside the repo) and `save` (which routes through a
 * native dialog so the user picks the destination).
 */

/** Rejects any relative path that escapes its repo root. */
function safeJoin(root: string, rel: string): string {
  if (isAbsolute(rel)) throw new Error('absolute paths are not accepted')
  const target = resolve(root, normalize(rel))
  const bounded = resolve(root) + sep
  if (target !== resolve(root) && !target.startsWith(bounded)) {
    throw new Error('path escapes the repository root')
  }
  return target
}

async function getRepo(id: string): Promise<RepoRef> {
  const repos = await analyzerHost.request<RepoRef[]>({ kind: 'repos-list' })
  const found = repos.find((r) => r.id === id)
  if (!found) throw new Error(`unknown repository: ${id}`)
  return found
}

export function registerIpc(): void {
  // -- repos ---------------------------------------------------------------

  ipcMain.handle(CHANNELS.reposList, async (): Promise<RepoRef[]> => {
    return analyzerHost.request<RepoRef[]>({ kind: 'repos-list' })
  })

  ipcMain.handle(CHANNELS.reposGet, async (_e, id: string): Promise<RepoRef | null> => {
    const repos = await analyzerHost.request<RepoRef[]>({ kind: 'repos-list' })
    return repos.find((r) => r.id === id) ?? null
  })

  ipcMain.handle(CHANNELS.reposPick, async (e): Promise<RepoRef | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = win
      ? await dialog.showOpenDialog(win, {
          title: 'Open a repository',
          properties: ['openDirectory'],
          message: 'Choose a git repository. VDE only ever reads it.'
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    const chosen = res.filePaths[0]
    if (!chosen) return null
    return analyzerHost.request<RepoRef>({ kind: 'validate', path: chosen })
  })

  ipcMain.handle(CHANNELS.reposAdd, async (_e, path: string): Promise<RepoRef> => {
    if (typeof path !== 'string' || path.length === 0) throw new Error('a path is required')
    return analyzerHost.request<RepoRef>({ kind: 'validate', path })
  })

  ipcMain.handle(CHANNELS.reposRemove, async (_e, id: string): Promise<void> => {
    await analyzerHost.request<null>({ kind: 'forget', repoId: id })
  })

  // -- analysis ------------------------------------------------------------

  ipcMain.handle(CHANNELS.analysisScan, async (_e, id: string, opts?: ScanOptions): Promise<void> => {
    const repo = await getRepo(id)
    await analyzerHost.request<null>({
      kind: 'scan',
      repoId: repo.id,
      path: repo.path,
      opts: opts ?? {},
      settings: getSettings()
    })
  })

  ipcMain.handle(CHANNELS.analysisCancel, async (_e, id: string): Promise<void> => {
    await analyzerHost.request<null>({ kind: 'cancel', repoId: id })
  })

  ipcMain.handle(
    CHANNELS.analysisReport,
    async (_e, id: string, baseline: BaselineKind, ref?: string): Promise<RepoReport> => {
      const repo = await getRepo(id)
      return analyzerHost.request<RepoReport>({
        kind: 'report',
        repoId: repo.id,
        path: repo.path,
        baseline,
        ref,
        settings: getSettings()
      })
    }
  )

  // -- brief ---------------------------------------------------------------

  ipcMain.handle(CHANNELS.briefGenerate, async (_e, id: string, findingIds?: string[]): Promise<string> => {
    const repo = await getRepo(id)
    return analyzerHost.request<string>({
      kind: 'brief',
      repoId: repo.id,
      path: repo.path,
      findingIds,
      settings: getSettings()
    })
  })

  ipcMain.handle(CHANNELS.briefCopy, async (_e, text: string): Promise<void> => {
    if (typeof text !== 'string') throw new Error('text is required')
    clipboard.writeText(text)
  })

  ipcMain.handle(CHANNELS.briefSave, async (e, id: string, text: string): Promise<string | null> => {
    const repo = await getRepo(id)
    const win = BrowserWindow.fromWebContents(e.sender)
    const stamp = new Date().toISOString().slice(0, 10)
    const defaultPath = join(app.getPath('downloads'), `vde-brief-${repo.name}-${stamp}.md`)
    const res = win
      ? await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'Markdown', extensions: ['md'] }] })
      : await dialog.showSaveDialog({ defaultPath })
    if (res.canceled || !res.filePath) return null
    await writeFile(res.filePath, text, 'utf8')
    return res.filePath
  })

  // -- settings ------------------------------------------------------------

  ipcMain.handle(CHANNELS.settingsGet, (): Settings => getSettings())
  ipcMain.handle(CHANNELS.settingsSet, (_e, patch: Partial<Settings>): Settings => setSettings(patch))

  // -- app -----------------------------------------------------------------

  ipcMain.handle(CHANNELS.appVersion, (): string => app.getVersion())
  ipcMain.handle(CHANNELS.appPlatform, (): Platform => process.platform)

  ipcMain.handle(CHANNELS.appOpenExternal, async (_e, url: string): Promise<void> => {
    // Only ever open http(s). A file: or javascript: URL here would be a hole.
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('invalid URL')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('only http and https URLs may be opened')
    }
    await shell.openExternal(parsed.toString())
  })

  ipcMain.handle(CHANNELS.appRevealFile, async (_e, id: string, relPath: string): Promise<void> => {
    const repo = await getRepo(id)
    shell.showItemInFolder(safeJoin(repo.path, relPath))
  })
}

/** Forwards analyzer progress to every open window. */
export function wireProgress(): () => void {
  return analyzerHost.onProgress((p) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(CHANNELS.analysisProgress, p)
    }
  })
}

export const __testing = { safeJoin }
