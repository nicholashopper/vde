import { app, Menu, shell, type BrowserWindow } from 'electron'
import { MENU_ACTION, type MenuAction } from '../shared/ipc'

export function buildMenu(getWindow: () => BrowserWindow | null): void {
  const send = (action: MenuAction) => (): void => getWindow()?.webContents.send(MENU_ACTION, action)
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: 'Settings…', accelerator: 'Cmd+,', click: send('settings') },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Repository…', accelerator: 'CmdOrCtrl+O', click: send('open-repo') },
        { label: 'Rescan', accelerator: 'CmdOrCtrl+R', click: send('rescan') },
        { type: 'separator' },
        { label: 'Copy Remediation Brief', accelerator: 'CmdOrCtrl+Shift+C', click: send('copy-brief') },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close' as const }] : [{ label: 'Settings…', click: send('settings') }, { role: 'quit' as const }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Pulse', accelerator: 'CmdOrCtrl+1', click: send('go-pulse') },
        { label: 'Map', accelerator: 'CmdOrCtrl+2', click: send('go-map') },
        { label: 'Timeline', accelerator: 'CmdOrCtrl+3', click: send('go-timeline') },
        { label: 'Findings', accelerator: 'CmdOrCtrl+4', click: send('go-findings') },
        { label: 'Brief', accelerator: 'CmdOrCtrl+5', click: send('go-brief') },
        { type: 'separator' },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+Shift+L', click: send('toggle-theme') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(process.env['NODE_ENV'] === 'development' || process.env['VDE_DEVTOOLS']
          ? [{ role: 'toggleDevTools' as const }]
          : [])
      ]
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'zoom' }]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'What VDE measures',
          click: () => void shell.openExternal('https://github.com/vde-app/vde#signals')
        },
        {
          label: 'VDE never writes to your repository',
          click: () => void shell.openExternal('https://github.com/vde-app/vde#read-only')
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
