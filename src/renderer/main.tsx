import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import { App } from './App'
import { useStore } from './store'

const container = document.getElementById('root')
if (!container) throw new Error('VDE: #root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)

/**
 * Bootstrap runs outside React on purpose.
 *
 * StrictMode double-invokes effects in development, and `init()` opens the
 * progress subscription and picks the first repository — doing that twice would
 * double-subscribe and fire two scans. Module scope runs exactly once.
 */
void useStore.getState().init().catch((e: unknown) => {
  // Nothing else can render if this fails, so it has to reach the screen.
  const message = e instanceof Error ? e.message : String(e)
  useStore.setState({ reportError: `VDE could not start: ${message}` })
})
