import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// The Flask sidecar that Electron spawns. The renderer always talks to the
// backend through a same-origin "/api" prefix so the NDJSON streaming endpoint
// (/api/deploy) works without CORS. In dev, Vite proxies "/api" to Flask; in a
// packaged build Flask will serve the built SPA itself (Phase 6), keeping the
// same-origin contract.
const BACKEND = 'http://127.0.0.1:8765'

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the built assets load from file:// or from Flask's static
  // mount regardless of mount path.
  base: './',
  server: {
    // Bind explicit IPv4. Default 'localhost' resolves to IPv6 ::1 on Windows,
    // which makes IPv4 health checks (wait-on tcp:127.0.0.1:5173) and Electron's
    // loadURL fail with ECONNREFUSED even though a browser can reach it. Pinning
    // 127.0.0.1 keeps Vite, Flask, the proxy, wait-on, and Electron all on IPv4.
    host: '127.0.0.1',
    port: 5173,
    // Fail loudly instead of hopping to a random port — Electron waits on 5173.
    strictPort: true,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // Don't let the proxy buffer the long-lived NDJSON stream.
            proxyReq.setHeader('Accept-Encoding', 'identity')
            // Flask's CSRF guard (app.py _csrf_guard) only accepts requests
            // whose Origin is the backend's own host:port. The renderer runs on
            // :5173, so rewrite Origin (and drop Referer) to the backend origin
            // for proxied POST/DELETE. Safe: the backend binds loopback only.
            proxyReq.setHeader('Origin', BACKEND)
            proxyReq.removeHeader('referer')
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist',
  },
  // Pre-bundle these up front. The scanner can't see `react/compiler-runtime`
  // (the React Compiler injects that import *after* the scan), so without the
  // list a cold start optimises, discovers it late, optimises again and forces
  // a full page reload. Naming them makes it one pass.
  //
  // Discovery itself is deliberately left ON: skipping it (`noDiscovery`) shaves
  // ~10s off a cold boot but silently breaks dev the moment someone adds a
  // dependency without editing this list. Not worth the trap.
  //
  // A cold pre-bundle (first run after any dependency change) takes a while —
  // CodeMirror alone is ~30 packages. tools/dev-electron.mjs waits it out.
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react/compiler-runtime',
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/commands',
      '@codemirror/language',
      '@codemirror/autocomplete',
      '@codemirror/search',
      '@codemirror/legacy-modes/mode/shell',
      '@lezer/highlight',
    ],
  },
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
})
