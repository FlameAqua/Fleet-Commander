import { app, BrowserWindow, Menu, ipcMain } from 'electron'
import { spawn } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BACKEND_HOST = '127.0.0.1'
const BACKEND_PORT = 8765
const BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`

// In dev, npm sets this to the Vite dev-server URL (HMR). When absent we're a
// packaged build: the Flask sidecar (PyInstaller binary) serves the SPA itself.
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const isDev = !!VITE_DEV_SERVER_URL

const isWindows = process.platform === 'win32'

let mainWindow = null
/** @type {import('child_process').ChildProcess | null} */
let backend = null

// ---------------------------------------------------------------------------
// Flask sidecar
// ---------------------------------------------------------------------------
function backendCommand () {
  if (isDev) {
    // Dev: run the project's Python venv against backend/app.py. (In practice
    // `npm run dev` already starts it; we only spawn if it isn't up.)
    const backendDir = path.join(__dirname, '..', 'backend')
    const venvPython = isWindows
      ? path.join(backendDir, '.venv', 'Scripts', 'python.exe')
      : path.join(backendDir, '.venv', 'bin', 'python')
    return { cmd: venvPython, args: ['app.py'], cwd: backendDir, spaDir: null }
  }
  // Prod: a PyInstaller binary + the built SPA, both shipped as extraResources.
  const backendDir = path.join(process.resourcesPath, 'backend')
  const binName = isWindows ? 'fleet-commander-backend.exe' : 'fleet-commander-backend'
  return {
    cmd: path.join(backendDir, binName),
    args: [],
    cwd: backendDir,
    spaDir: path.join(process.resourcesPath, 'spa'),
  }
}

function startBackend () {
  const { cmd, args, cwd, spaDir } = backendCommand()
  const env = {
    ...process.env,
    BSM_NO_BROWSER: '1', // we own the window; don't let Flask open a browser
    DEPLOYER_HOST: BACKEND_HOST,
    DEPLOYER_PORT: String(BACKEND_PORT),
    PYTHONUNBUFFERED: '1',
  }
  if (spaDir) env.BSM_SPA_DIR = spaDir // prod: Flask serves the SPA same-origin
  backend = spawn(cmd, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, // don't flash the console binary's window on Windows
  })

  backend.stdout.on('data', (d) => process.stdout.write(`[flask] ${d}`))
  backend.stderr.on('data', (d) => process.stderr.write(`[flask] ${d}`))
  backend.on('exit', (code, signal) => {
    console.log(`[flask] exited code=${code} signal=${signal}`)
    backend = null
  })
  backend.on('error', (err) => {
    console.error('[flask] failed to start:', err)
  })
}

function stopBackend () {
  if (!backend || backend.killed) return
  // On Windows a plain kill() can leave the python process orphaned; use
  // taskkill to take down the whole tree.
  if (isWindows && backend.pid) {
    try {
      spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'])
    } catch (e) {
      backend.kill()
    }
  } else {
    backend.kill('SIGTERM')
  }
  backend = null
}

/** Quick one-shot check: is a backend already answering on the port? */
function isBackendUp (timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.get(BACKEND_URL + '/api/scripts', (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve(false)
    })
  })
}

/** Resolve once Flask answers an HTTP request, or reject after `timeoutMs`. */
function waitForBackend (timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(BACKEND_URL + '/api/scripts', (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`backend did not come up within ${timeoutMs}ms`))
        } else {
          setTimeout(ping, 300)
        }
      })
    }
    ping()
  })
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow () {
  // Icon: public/ in dev; the SPA resources dir in a packaged build.
  const icon = isDev
    ? path.join(__dirname, '..', 'public', 'fleet.ico')
    : path.join(process.resourcesPath, 'spa', 'fleet.ico')
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'Fleet Commander',
    icon,
    autoHideMenuBar: true,
    // Frameless so the app draws its own title bar + window controls (DOM
    // buttons that theme and dim correctly under overlays).
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  // Both modes load a URL so the renderer is same-origin with the API:
  //   dev  → the Vite dev server (HMR)
  //   prod → the Flask-served SPA (waitForBackend has confirmed it's up)
  mainWindow.loadURL(isDev ? VITE_DEV_SERVER_URL : BACKEND_URL)
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })

  // Reveal the window reliably. `ready-to-show` is the ideal trigger, but on
  // some setups it fires late or not at all (frameless window, slow first
  // paint) — which would leave the window invisible. Back it up with
  // did-finish-load and a hard timeout so the window never stays hidden.
  let shown = false
  const reveal = () => {
    if (shown || !mainWindow) return
    shown = true
    mainWindow.show()
    mainWindow.focus()
  }
  mainWindow.once('ready-to-show', reveal)
  mainWindow.webContents.once('did-finish-load', reveal)
  setTimeout(reveal, 4000)
  mainWindow.on('closed', () => { mainWindow = null })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  // No application menu (File/Edit/View/Window) — this is a focused tool UI.
  Menu.setApplicationMenu(null)
  // In dev the backend is started by `npm run dev` (the `dev:backend` process),
  // so don't double-spawn it. In a packaged build nothing else runs it, so we
  // spawn it here and own its lifecycle.
  if (await isBackendUp()) {
    console.log('[flask] already running — not spawning')
  } else {
    startBackend()
  }
  try {
    await waitForBackend()
  } catch (err) {
    console.error(err)
    // Still open the window so the renderer can show a connection error.
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Custom (DOM-drawn) window controls for the frameless window.
ipcMain.on('fc:win', (e, action) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  if (action === 'minimize') win.minimize()
  else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
  else if (action === 'close') win.close()
})

app.on('before-quit', stopBackend)
process.on('exit', stopBackend)
