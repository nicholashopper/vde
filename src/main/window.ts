import { BrowserWindow, shell, nativeTheme } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { getSettings } from './settings'

/**
 * The application window.
 *
 * Security posture: context isolation on, sandbox on, node integration off,
 * web security on. The renderer reaches privilege only through the preload
 * bridge. Navigation away from the app and all window.open calls are blocked —
 * a repository's own content is untrusted data and must never become a page.
 */
export function createWindow(): BrowserWindow {
  const settings = getSettings()
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors)

  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    // Match the token surface so the first paint is not a white flash.
    backgroundColor: dark ? '#0a0a08' : '#f9f9f7',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 15 } : undefined,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // External links open in the user's browser; nothing opens in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    const allowed = devServer ? url.startsWith(devServer) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    }
  })

  // Never allow the renderer to be granted a permission it has no use for.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return win
}
