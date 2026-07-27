import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, MENU_ACTION } from '../shared/ipc'
import type {
  AnalysisProgress,
  BaselineKind,
  RepoRef,
  RepoReport,
  Platform,
  ScanOptions,
  Settings,
  VdeApi
} from '../shared/types'
import type { MenuAction } from '../shared/ipc'

/**
 * The preload bridge — the only path from renderer to privilege.
 *
 * Runs sandboxed, so it has no filesystem or child-process access of its own.
 * It exposes a fixed, typed surface and nothing else: no ipcRenderer, no
 * generic `invoke`, no way for renderer code to name a channel that isn't
 * listed here.
 */

const api: VdeApi = {
  repos: {
    list: () => ipcRenderer.invoke(CHANNELS.reposList) as Promise<RepoRef[]>,
    pick: () => ipcRenderer.invoke(CHANNELS.reposPick) as Promise<RepoRef | null>,
    add: (path: string) => ipcRenderer.invoke(CHANNELS.reposAdd, path) as Promise<RepoRef>,
    remove: (id: string) => ipcRenderer.invoke(CHANNELS.reposRemove, id) as Promise<void>,
    get: (id: string) => ipcRenderer.invoke(CHANNELS.reposGet, id) as Promise<RepoRef | null>
  },
  analysis: {
    scan: (id: string, opts?: ScanOptions) => ipcRenderer.invoke(CHANNELS.analysisScan, id, opts) as Promise<void>,
    cancel: (id: string) => ipcRenderer.invoke(CHANNELS.analysisCancel, id) as Promise<void>,
    report: (id: string, baseline: BaselineKind, ref?: string) =>
      ipcRenderer.invoke(CHANNELS.analysisReport, id, baseline, ref) as Promise<RepoReport>,
    onProgress: (cb: (p: AnalysisProgress) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, p: AnalysisProgress): void => cb(p)
      ipcRenderer.on(CHANNELS.analysisProgress, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.analysisProgress, listener)
      }
    }
  },
  brief: {
    generate: (id: string, findingIds?: string[]) =>
      ipcRenderer.invoke(CHANNELS.briefGenerate, id, findingIds) as Promise<string>,
    copy: (text: string) => ipcRenderer.invoke(CHANNELS.briefCopy, text) as Promise<void>,
    save: (id: string, text: string) => ipcRenderer.invoke(CHANNELS.briefSave, id, text) as Promise<string | null>
  },
  settings: {
    get: () => ipcRenderer.invoke(CHANNELS.settingsGet) as Promise<Settings>,
    set: (patch: Partial<Settings>) => ipcRenderer.invoke(CHANNELS.settingsSet, patch) as Promise<Settings>
  },
  app: {
    version: () => ipcRenderer.invoke(CHANNELS.appVersion) as Promise<string>,
    platform: () => ipcRenderer.invoke(CHANNELS.appPlatform) as Promise<Platform>,
    openExternal: (url: string) => ipcRenderer.invoke(CHANNELS.appOpenExternal, url) as Promise<void>,
    revealFile: (id: string, relPath: string) =>
      ipcRenderer.invoke(CHANNELS.appRevealFile, id, relPath) as Promise<void>
  }
}

/** Menu-driven navigation, so accelerators and the app menu stay in sync. */
const menu = {
  onAction(cb: (action: MenuAction) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, action: MenuAction): void => cb(action)
    ipcRenderer.on(MENU_ACTION, listener)
    return () => {
      ipcRenderer.removeListener(MENU_ACTION, listener)
    }
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('vde', api)
  contextBridge.exposeInMainWorld('vdeMenu', menu)
} else {
  // Context isolation is force-enabled in window.ts; this branch exists only so
  // a misconfiguration fails visibly rather than silently exposing nothing.
  throw new Error('VDE requires context isolation')
}
