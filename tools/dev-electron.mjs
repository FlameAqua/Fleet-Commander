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

async function waitForPorts() {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if ((await portUp(5173)) && (await portUp(8765))) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

if (!(await waitForPorts())) {
  console.error('[electron] dev servers (5173 / 8765) did not come up in time')
  process.exit(1)
}

const child = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' },
})

child.on('exit', (code) => process.exit(code ?? 0))
const stop = () => {
  try {
    child.kill()
  } catch {
    /* already gone */
  }
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
