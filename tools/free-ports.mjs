// Free the dev ports (5173 Vite, 8765 Flask) if a stale dev process is still
// holding them — so `npm run dev` is self-healing after a crash or a terminal
// closed without a clean shutdown. Only ever kills node/python processes (our
// own dev servers), never an unrelated app that happens to use the port.
import { execSync } from 'node:child_process'

const PORTS = [5173, 8765]
const isWin = process.platform === 'win32'

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

for (const port of PORTS) {
  if (isWin) {
    const re = new RegExp(`:${port}\\s`)
    const lines = run('netstat -ano -p tcp')
      .split('\n')
      .filter((l) => re.test(l) && /LISTENING/i.test(l))
    const pids = new Set(lines.map((l) => l.trim().split(/\s+/).pop()).filter((p) => p && p !== '0'))
    for (const pid of pids) {
      const info = run(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`).trim()
      if (/^"(node|python|pythonw)\.exe"/i.test(info)) {
        run(`taskkill /F /PID ${pid}`)
        console.log(`[free-ports] freed :${port} (killed stale ${info.split(',')[0]} pid ${pid})`)
      }
    }
  } else {
    const pids = run(`lsof -ti tcp:${port}`).split('\n').filter(Boolean)
    for (const pid of pids) run(`kill -9 ${pid}`)
    if (pids.length) console.log(`[free-ports] freed :${port}`)
  }
}
