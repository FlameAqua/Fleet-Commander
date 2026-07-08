// Run the backend test suite using the backend venv python. Locates the venv
// the same way build-backend.mjs does, so `npm test` works cross-platform.
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
    `[test] venv python not found at:\n  ${py}\n` +
      `Create it first:\n  cd backend\n` +
      (isWin
        ? `  py -m venv .venv && .venv\\Scripts\\python.exe -m pip install -r requirements.txt`
        : `  python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt`),
  )
  process.exit(1)
}

const child = spawn(py, [path.join(backendDir, 'tests', 'test_api.py')], {
  cwd: backendDir,
  stdio: 'inherit',
})
child.on('exit', (code) => process.exit(code ?? 0))
