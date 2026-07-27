import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import {
  isAnalyzerEvent,
  type AnalyzerEvent,
  type AnalyzerRequest,
  type AnalyzerRequestInit,
  type AnalyzerResponse
} from '../shared/ipc'
import type { AnalysisProgress } from '../shared/types'

/**
 * Owns the analyzer utility process.
 *
 * The engine walks history, reads thousands of blobs and runs tree-sitter over
 * all of them. In the main process that would freeze the window; in the
 * renderer it would need Node access, which the renderer must not have. A
 * utility process gives it a Node context of its own with no DOM and no remote
 * module, and lets us kill and restart it if it ever wedges.
 *
 * Requests are correlated by an incrementing id. A crash rejects every pending
 * request rather than leaving the UI spinning forever.
 */

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  kind: AnalyzerRequest['kind']
}

export class AnalyzerHost {
  private proc: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private ready: Promise<void> | null = null
  private progressListeners = new Set<(p: AnalysisProgress) => void>()
  private restarts = 0

  onProgress(fn: (p: AnalysisProgress) => void): () => void {
    this.progressListeners.add(fn)
    return () => this.progressListeners.delete(fn)
  }

  private entryPath(): string {
    // electron-vite emits the analyzer alongside the main bundle.
    return join(import.meta.dirname, 'analyzer.js')
  }

  /**
   * Grammar WASM lives in node_modules during development and in the unpacked
   * asar in production, because WASM cannot be read from inside an asar.
   */
  private wasmPath(): string {
    return is.dev
      ? join(app.getAppPath(), 'node_modules', 'tree-sitter-wasms', 'out')
      : join(process.resourcesPath, 'grammars')
  }

  private webTreeSitterPath(): string {
    return is.dev
      ? join(app.getAppPath(), 'node_modules', 'web-tree-sitter')
      : join(process.resourcesPath, 'web-tree-sitter')
  }

  private spawn(): Promise<void> {
    if (this.ready) return this.ready

    this.ready = new Promise<void>((resolve, reject) => {
      const child = utilityProcess.fork(this.entryPath(), [], {
        serviceName: 'vde-analyzer',
        stdio: 'pipe',
        env: {
          ...process.env,
          VDE_WASM_PATH: this.wasmPath(),
          VDE_WEB_TREE_SITTER_PATH: this.webTreeSitterPath()
        }
      })
      this.proc = child

      child.stdout?.on('data', (d: Buffer) => console.log('[analyzer]', d.toString().trimEnd()))
      child.stderr?.on('data', (d: Buffer) => console.error('[analyzer]', d.toString().trimEnd()))

      child.on('message', (msg: AnalyzerResponse | AnalyzerEvent) => {
        if (isAnalyzerEvent(msg)) {
          for (const fn of this.progressListeners) fn(msg.payload)
          return
        }
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(Object.assign(new Error(msg.error), { stack: msg.stack }))
      })

      child.on('exit', (code) => {
        const err = new Error(`analyzer process exited (code ${code})`)
        for (const [, p] of this.pending) p.reject(err)
        this.pending.clear()
        this.proc = null
        this.ready = null
        // A crash during a scan is recoverable; the next request respawns. Cap
        // restarts so a reproducible crash does not become an infinite loop.
        if (code !== 0 && this.restarts < 5) this.restarts += 1
      })

      child.once('spawn', () => {
        this.request({ kind: 'init', userDataPath: app.getPath('userData'), wasmPath: this.wasmPath() })
          .then(() => resolve())
          .catch(reject)
      })
    })

    return this.ready
  }

  /** Sends a request, spawning the process on first use. */
  async request<T>(req: AnalyzerRequestInit): Promise<T> {
    if (req.kind !== 'init') await this.spawn()
    const proc = this.proc
    if (!proc) throw new Error('analyzer process is not running')

    const id = this.nextId++
    const message = { ...req, id } as AnalyzerRequest
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, kind: req.kind })
      proc.postMessage(message)
    })
  }

  dispose(): void {
    this.proc?.kill()
    this.proc = null
    this.ready = null
    this.pending.clear()
  }
}

export const analyzerHost = new AnalyzerHost()
