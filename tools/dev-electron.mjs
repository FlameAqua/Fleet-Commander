// Dev launcher for Electron: waits (on IPv4 loopback) for the Vite dev server
// and the Flask backend, then spawns Electron directly. Replaces the fragile
// `wait-on … && cross-env … electron .` shell chain — no cmd.exe batch prompts,
// clean signal handling, and it spawns the electron binary by its real path.
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = require('electron') // absolute path to the electron binary
const DEV_URL = 'http://127.0.0.1:5173'

function portUp(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    const done = (ok) => {
      sock.destroy()
      resolve(ok)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => resolve(false))
    sock.setTimeout(800, () => done(false))
  })
}

/**
 * Wait for both dev servers, patiently. The first run after a dependency change
 * makes Vite pre-bundle everything from cold, which can take a couple of
 * minutes on Windows — and a launcher that gives up takes the whole
 * `concurrently -k` stack down with it, which looks like "the app is broken"
 * rather than "it needed another minute". So: a generous cap, and progress
 * output so the wait is visibly a wait.
 */
async function waitForPorts() {
  const deadline = Date.now() + 300000
  let told = 0
  while (Date.now() < deadline) {
    const [vite, flask] = [await portUp(5173), await portUp(8765)]
    if (vite && flask) return true
    const waited = Math.round((Date.now() - (deadline - 300000)) / 1000)
    if (waited >= told + 15) {
      told = waited
      const missing = [!vite && 'vite (5173)', !flask && 'flask (8765)'].filter(Boolean).join(' + ')
      console.log(
        `[electron] waiting for ${missing} — ${waited}s` +
          (waited === 15 ? ' (a cold dependency pre-bundle can take a few minutes)' : ''),
      )
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

if (!(await waitForPorts())) {
  console.error('[electron] dev servers (5173 / 8765) did not come up within 5 minutes.')
  console.error('           Check the [vite] and [flask] output above for the real error.')
  process.exit(1)
}

// Kick the page so Vite starts crawling/transforming/pre-bundling NOW, in
// parallel with Electron's own (~2s) startup, instead of only when the window
// asks for it. Deliberately not awaited — the window should open (showing
// index.html's boot screen) while this runs, and main.js retries the load if it
// happens to land before the server can answer.
const warm = (p) => fetch(new URL(p, DEV_URL), { signal: AbortSignal.timeout(120000) }).catch(() => {})
warm('/')
warm('/src/main.tsx')

const child = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL },
})

child.on('exit', (code, signal) => {
  // Worth stating plainly: when the app window is closed, Electron exits and
  // `concurrently -k` tears down vite/flask too. That is the stack shutting
  // down normally, not a crash.
  console.log(`[launcher] electron exited code=${code} signal=${signal}`)
  process.exit(code ?? 0)
})
const stop = () => {
  try {
    child.kill()
  } catch {
    /* already gone */
  }
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
