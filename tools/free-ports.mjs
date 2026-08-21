// Free the dev ports (5173 Vite, 8765 Flask) if a stale dev process is still
// holding them — so `npm run dev` is self-healing after a crash or a terminal
// closed without a clean shutdown. Only ever kills node/python processes (our
// own dev servers), never an unrelated app that happens to use the port.
import { execSync } from 'node:child_process'
import net from 'node:net'

const PORTS = [5173, 8765]
const isWin = process.platform === 'win32'

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
    const re = new RegExp(`:${port}\s`)
    const pids = new Set(
      lines
        .filter((l) => re.test(l))
        .map((l) => l.trim().split(/\s+/).pop())
        .filter((p) => p && p !== '0'),
    )
    for (const pid of pids) {
      const info = run(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`).trim()
      if (/^"(node|python|pythonw)\.exe"/i.test(info)) {
        run(`taskkill /F /PID ${pid}`)
        console.log(`[free-ports] freed :${port} (killed stale ${info.split(',')[0]} pid ${pid})`)
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
