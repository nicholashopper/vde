/**
 * IPC channel names and the analyzer's message protocol.
 *
 * Two boundaries exist:
 *   renderer  ⇄ main       via ipcRenderer.invoke / ipcMain.handle  (CHANNELS)
 *   main      ⇄ analyzer   via MessagePort on a utility process     (AnalyzerRequest/Response)
 *
 * The renderer never talks to the analyzer directly and has no Node access.
 */

import type {
  AnalysisProgress,
  BaselineKind,
  RepoRef,
  RepoReport,
  ScanOptions,
  Settings
} from './types'

export const CHANNELS = {
  reposList: 'repos:list',
  reposPick: 'repos:pick',
  reposAdd: 'repos:add',
  reposRemove: 'repos:remove',
  reposGet: 'repos:get',

  analysisScan: 'analysis:scan',
  analysisCancel: 'analysis:cancel',
  analysisReport: 'analysis:report',
  /** main → renderer, push. */
  analysisProgress: 'analysis:progress',

  briefGenerate: 'brief:generate',
  briefCopy: 'brief:copy',
  briefSave: 'brief:save',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  appVersion: 'app:version',
  appPlatform: 'app:platform',
  appOpenExternal: 'app:openExternal',
  appRevealFile: 'app:revealFile'
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]

/** Channel the main process uses to push menu-driven navigation. */
export const MENU_ACTION = 'menu:action'

/**
 * Actions the application menu can trigger. Declared here rather than in the
 * main process so the renderer can consume the type without pulling Electron's
 * main-process types into the web build.
 */
export type MenuAction =
  | 'open-repo'
  | 'rescan'
  | 'copy-brief'
  | 'go-pulse'
  | 'go-map'
  | 'go-timeline'
  | 'go-findings'
  | 'go-brief'
  | 'toggle-theme'
  | 'settings'

// ---------------------------------------------------------------------------
// main ⇄ analyzer protocol
// ---------------------------------------------------------------------------

/**
 * `Omit` over a union collapses it to its common keys instead of distributing,
 * so `Omit<AnalyzerRequest, 'id'>` would accept none of the per-kind fields.
 * The conditional makes it distribute across the members.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** An analyzer request with the correlation id not yet assigned. */
export type AnalyzerRequestInit = DistributiveOmit<AnalyzerRequest, 'id'>

export type AnalyzerRequest =
  | { id: number; kind: 'init'; userDataPath: string; wasmPath: string }
  | { id: number; kind: 'validate'; path: string }
  | { id: number; kind: 'scan'; repoId: string; path: string; opts: ScanOptions; settings: Settings }
  | { id: number; kind: 'cancel'; repoId: string }
  | {
      id: number
      kind: 'report'
      repoId: string
      path: string
      baseline: BaselineKind
      ref?: string
      settings: Settings
    }
  | { id: number; kind: 'brief'; repoId: string; path: string; findingIds?: string[]; settings: Settings }
  | { id: number; kind: 'forget'; repoId: string }
  | { id: number; kind: 'repos-list' }

export type AnalyzerResponse =
  | { id: number; ok: true; kind: 'init'; result: null }
  | { id: number; ok: true; kind: 'validate'; result: RepoRef }
  | { id: number; ok: true; kind: 'scan'; result: null }
  | { id: number; ok: true; kind: 'cancel'; result: null }
  | { id: number; ok: true; kind: 'report'; result: RepoReport }
  | { id: number; ok: true; kind: 'brief'; result: string }
  | { id: number; ok: true; kind: 'forget'; result: null }
  | { id: number; ok: true; kind: 'repos-list'; result: RepoRef[] }
  | { id: number; ok: false; error: string; stack?: string }

/** Unsolicited progress push from the analyzer. */
export interface AnalyzerEvent {
  id: -1
  event: 'progress'
  payload: AnalysisProgress
}

export function isAnalyzerEvent(m: unknown): m is AnalyzerEvent {
  return typeof m === 'object' && m !== null && (m as AnalyzerEvent).id === -1
}
