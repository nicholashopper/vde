import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The analyzer runs in a dedicated Electron utility process so that
          // heavy git walks and tree-sitter parsing never block the UI or the
          // main process event loop.
          analyzer: resolve('src/analyzer/index.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@analyzer': resolve('src/analyzer')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // A sandboxed preload must be CommonJS — Electron only accepts an ESM
        // preload when sandbox is off, and VDE keeps the sandbox on. The .cjs
        // extension is what makes Node read it as CJS despite "type": "module"
        // in package.json.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
