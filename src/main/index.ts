import { app, BrowserWindow, nativeTheme, session } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { analyzerHost } from './analyzer-host'
import { registerIpc, wireProgress } from './ipc'
import { buildMenu } from './menu'
import { getSettings } from './settings'
import { initUpdater } from './updater'
import { createWindow } from './window'

/**
 * VDE main process.
 *
 * Responsibilities, in order: enforce single-instance, harden the session,
 * register the renderer's capability surface, own the window, and supervise the
 * analyzer utility process. It deliberately contains no analysis logic — that
 * all lives in the analyzer, where it cannot block the UI.
 */

let mainWindow: BrowserWindow | null = null
const getWindow = (): BrowserWindow | null => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('dev.vde.app')

    // Content-Security-Policy is also declared in index.html; setting it at the
    // session level means a compromised renderer cannot simply rewrite the meta
    // tag to loosen it.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
              "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
              "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
          ]
        }
      })
    })

    const settings = getSettings()
    nativeTheme.themeSource = settings.theme

    registerIpc()
    const unwireProgress = wireProgress()

    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    mainWindow = createWindow()
    buildMenu(getWindow)
    initUpdater(getWindow)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })

    app.on('before-quit', () => {
      unwireProgress()
      analyzerHost.dispose()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// A crash in the main process takes the app with it; log loudly rather than
// dying silently so a packaged build produces something diagnosable.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason)
})
