// Cross-platform launcher for the Flask backend in development.
// Picks the venv interpreter for the current OS and runs backend/app.py with
// the env the desktop app expects. Used by the `dev:backend` npm script so the
// dev loop doesn't depend on Electron (or its lazy binary download) to bring
// the API up.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendDir = path.join(__dirname, '..', 'backend')
const isWin = process.platform === 'win32'
const py = isWin
  ? path.join(backendDir, '.venv', 'Scripts', 'python.exe')
  : path.join(backendDir, '.venv', 'bin', 'python')

if (!existsSync(py)) {
  console.error(
    `[backend] venv python not found at:\n  ${py}\n` +
      `Create it first:\n` +
      `  cd backend\n` +
      (isWin
        ? `  py -m venv .venv && .venv\\Scripts\\python.exe -m pip install -r requirements.txt`
        : `  python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt`),
  )
  process.exit(1)
}

const child = spawn(py, ['app.py'], {
  cwd: backendDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    BSM_NO_BROWSER: '1',
    DEPLOYER_HOST: '127.0.0.1',
    DEPLOYER_PORT: '8765',
    PYTHONUNBUFFERED: '1',
  },
})

child.on('exit', (code) => process.exit(code ?? 0))
const stop = () => { if (!child.killed) child.kill() }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
