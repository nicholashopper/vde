import { create } from 'zustand'
import type {
  AnalysisProgress,
  BaselineKind,
  RepoRef,
  RepoReport,
  Settings,
  SignalId
} from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

export type ViewId = 'pulse' | 'map' | 'timeline' | 'findings' | 'brief' | 'settings'

interface State {
  // -- repositories
  repos: RepoRef[]
  activeRepoId: string | null
  // -- the current report
  report: RepoReport | null
  reportError: string | null
  loading: boolean
  progress: AnalysisProgress | null
  // -- view state
  view: ViewId
  baseline: BaselineKind
  /** Signal whose drill-down panel is open, if any. */
  openSignal: SignalId | null
  /** Path selected in the Map view. */
  selectedPath: string | null
  settings: Settings
  appVersion: string

  // -- actions
  init(): Promise<void>
  pickRepo(): Promise<void>
  selectRepo(id: string): Promise<void>
  removeRepo(id: string): Promise<void>
  scan(force?: boolean): Promise<void>
  loadReport(): Promise<void>
  setBaseline(b: BaselineKind): Promise<void>
  setView(v: ViewId): void
  setOpenSignal(id: SignalId | null): void
  setSelectedPath(p: string | null): void
  updateSettings(patch: Partial<Settings>): Promise<void>
  applyTheme(theme: Settings['theme']): void
}

/** Stamps the theme onto the document root so the token overrides take effect. */
function stampTheme(theme: Settings['theme']): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

export const useStore = create<State>((set, get) => ({
  repos: [],
  activeRepoId: null,
  report: null,
  reportError: null,
  loading: false,
  progress: null,
  view: 'pulse',
  baseline: '7d',
  openSignal: null,
  selectedPath: null,
  settings: DEFAULT_SETTINGS,
  appVersion: '',

  async init() {
    const [repos, settings, appVersion] = await Promise.all([
      window.vde.repos.list(),
      window.vde.settings.get(),
      window.vde.app.version()
    ])
    stampTheme(settings.theme)
    document.documentElement.setAttribute('data-texture', settings.textureFills ? 'on' : 'off')
    set({ repos, settings, appVersion, baseline: settings.defaultBaseline })

    window.vde.analysis.onProgress((p) => {
      // Ignore progress for a repo the user has navigated away from.
      if (p.repoId !== get().activeRepoId) return
      set({ progress: p.phase === 'done' || p.phase === 'error' ? null : p })
    })

    const first = repos[0]
    if (first) await get().selectRepo(first.id)
  },

  async pickRepo() {
    const repo = await window.vde.repos.pick()
    if (!repo) return
    set({ repos: await window.vde.repos.list() })
    await get().selectRepo(repo.id)
    // A freshly added repo has no snapshots, so scan immediately — an empty
    // dashboard on first open would make the app look broken.
    if (!repo.lastScanAt) await get().scan()
  },

  async selectRepo(id) {
    set({ activeRepoId: id, report: null, reportError: null, selectedPath: null, openSignal: null })
    await get().loadReport()
  },

  async removeRepo(id) {
    await window.vde.repos.remove(id)
    const repos = await window.vde.repos.list()
    set({ repos })
    if (get().activeRepoId === id) {
      const next = repos[0]
      if (next) await get().selectRepo(next.id)
      else set({ activeRepoId: null, report: null })
    }
  },

  async scan(force = false) {
    const id = get().activeRepoId
    if (!id) return
    set({ loading: true, reportError: null })
    try {
      await window.vde.analysis.scan(id, { force })
      set({ repos: await window.vde.repos.list() })
      await get().loadReport()
    } catch (e) {
      set({ reportError: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ loading: false, progress: null })
    }
  },

  async loadReport() {
    const id = get().activeRepoId
    if (!id) return
    set({ loading: true, reportError: null })
    try {
      const report = await window.vde.analysis.report(id, get().baseline)
      set({ report })
    } catch (e) {
      set({ report: null, reportError: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ loading: false })
    }
  },

  async setBaseline(baseline) {
    set({ baseline })
    await get().loadReport()
  },

  setView: (view) => set({ view }),
  setOpenSignal: (openSignal) => set({ openSignal }),
  setSelectedPath: (selectedPath) => set({ selectedPath }),

  async updateSettings(patch) {
    const settings = await window.vde.settings.set(patch)
    if (patch.theme) stampTheme(settings.theme)
    if (patch.textureFills !== undefined) {
      document.documentElement.setAttribute('data-texture', settings.textureFills ? 'on' : 'off')
    }
    set({ settings })
  },

  applyTheme(theme) {
    stampTheme(theme)
    void get().updateSettings({ theme })
  }
}))

/** The active repo, or null. */
export function useActiveRepo(): RepoRef | null {
  return useStore((s) => s.repos.find((r) => r.id === s.activeRepoId) ?? null)
}
