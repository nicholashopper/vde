import { app, dialog, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

/**
 * Auto-update.
 *
 * Wired but inert until a publish target exists and the app is signed: an
 * unsigned macOS build cannot self-update, and shipping an updater that points
 * nowhere produces confusing errors on every launch. Set VDE_ENABLE_UPDATER=1
 * (or configure `publish` in electron-builder.yml and build a signed artefact)
 * to turn it on.
 */
export function initUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) return
  if (!process.env['VDE_ENABLE_UPDATER']) return

  const { autoUpdater } = electronUpdater
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => {
    // Never surface an update failure as a modal — it is not the user's problem.
    console.error('[updater]', err?.message ?? err)
  })

  autoUpdater.on('update-downloaded', (info) => {
    const win = getWindow()
    const opts: Electron.MessageBoxOptions = {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `VDE ${info.version} has been downloaded.`,
      detail: 'Restart to finish installing.'
    }
    const handle = (res: Electron.MessageBoxReturnValue): void => {
      if (res.response === 0) autoUpdater.quitAndInstall()
    }
    void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then(handle)
  })

  void autoUpdater.checkForUpdates().catch(() => {
    /* handled by the error listener */
  })

  // A quiet re-check every six hours.
  setInterval(
    () => {
      void autoUpdater.checkForUpdates().catch(() => {})
    },
    6 * 60 * 60 * 1000
  ).unref()
}
