// Free the dev ports (5173 Vite, 8765 Flask) if a stale dev process is still
// holding them — so `npm run dev` is self-healing after a crash or a terminal
// closed without a clean shutdown. Only ever kills our own dev servers, never
// an unrelated app that happens to use the port.
import { execSync } from 'node:child_process'
import net from 'node:net'

const PORTS = [5173, 8765]
const isWin = process.platform === 'win32'

// Process images we're willing to kill: the dev servers themselves, plus the
// packaged Flask sidecar, which can hold 8765 if an installed build was left
// running.
const OURS = /^"(node|python|pythonw|fleet-commander-backend)\.exe"/i

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/** Is anything listening on `port`? A quick connect beats shelling out. */
function inUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    const done = (v) => {
      sock.destroy()
      resolve(v)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => resolve(false))
    sock.setTimeout(400, () => done(false))
  })
}

/**
 * PIDs listening on `port`, read from netstat's columns:
 *
 *   Proto  Local Address        Foreign Address      State      PID
 *   TCP    127.0.0.1:5173       0.0.0.0:0            LISTENING  10680
 *
 * Parsed positionally rather than by regex — a previous version matched with
 * `new RegExp(`:${port}\s`)`, where `\s` in a template literal collapses to a
 * literal "s", so it silently matched nothing and this whole script became a
 * no-op. Columns have no escaping to get wrong.
 */
function listeningPids(lines, port) {
  const pids = new Set()
  for (const line of lines) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5) continue
    const local = cols[1]
    if (local.slice(local.lastIndexOf(':') + 1) !== String(port)) continue
    const pid = cols[cols.length - 1]
    if (pid && pid !== '0') pids.add(pid)
  }
  return pids
}

// The common case is a clean start with both ports free — check first so we
// don't pay for netstat/tasklist/lsof on every `npm run dev`.
const busy = []
for (const port of PORTS) if (await inUse(port)) busy.push(port)
if (!busy.length) process.exit(0)

if (isWin) {
  // One netstat pass for every busy port (it lists all sockets anyway).
  const lines = run('netstat -ano -p tcp')
    .split('\n')
    .filter((l) => /LISTENING/i.test(l))
  for (const port of busy) {
    const pids = listeningPids(lines, port)
    if (!pids.size) {
      console.warn(`[free-ports] :${port} is in use but no owning PID was found — leaving it alone`)
      continue
    }
    for (const pid of pids) {
      const info = run(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`).trim()
      if (OURS.test(info)) {
        run(`taskkill /F /T /PID ${pid}`)
        console.log(`[free-ports] freed :${port} (killed stale ${info.split(',')[0]} pid ${pid})`)
      } else {
        console.warn(
          `[free-ports] :${port} is held by ${info.split(',')[0] || `pid ${pid}`}, which isn't ours — ` +
            `not killing it. Close it, or change the port.`,
        )
      }
    }
  }
} else {
  for (const port of busy) {
    const pids = run(`lsof -ti tcp:${port}`).split('\n').filter(Boolean)
    for (const pid of pids) run(`kill -9 ${pid}`)
    if (pids.length) console.log(`[free-ports] freed :${port}`)
  }
}
