import type { VdeApi } from '../shared/types'
import type { MenuAction } from '../shared/ipc'

declare global {
  interface Window {
    vde: VdeApi
    vdeMenu: {
      onAction(cb: (action: MenuAction) => void): () => void
    }
  }
}

export {}
