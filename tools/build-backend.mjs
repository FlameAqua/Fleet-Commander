// Build the Fleet Commander backend sidecar with PyInstaller, using the
// backend venv. Produces a ONEDIR bundle at backend/dist/fleet-commander-backend/
// (launcher exe + unpacked deps), which electron-builder ships as an
// extraResource. Onedir avoids the multi-second onefile temp-unpack on every
// launch. Run on each target OS (PyInstaller does not cross-compile).
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
    `[build:backend] venv python not found at:\n  ${py}\n` +
      `Create it and install build deps first:\n` +
      `  cd backend\n` +
      (isWin
        ? `  py -m venv .venv && .venv\\Scripts\\python.exe -m pip install -r requirements.txt -r requirements-build.txt`
        : `  python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt -r requirements-build.txt`),
  )
  process.exit(1)
}

console.log('[build:backend] running PyInstaller…')
const child = spawn(
  py,
  ['-m', 'PyInstaller', '--noconfirm', '--clean', 'fleet-commander-backend.spec'],
  { cwd: backendDir, stdio: 'inherit' },
)
child.on('exit', (code) => {
  if (code === 0) {
    const dir = path.join(backendDir, 'dist', 'fleet-commander-backend')
    const out = path.join(dir, isWin ? 'fleet-commander-backend.exe' : 'fleet-commander-backend')
    console.log(`[build:backend] done → ${out}`)
  }
  process.exit(code ?? 0)
})
