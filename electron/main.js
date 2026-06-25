import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { spawn } from 'child_process'
import fs from 'node:fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'

const { autoUpdater } = electronUpdater

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Read-only GitHub token used to read releases from the PRIVATE repo. CI writes
// this file from a secret at build time; it's gitignored and absent in dev.
let UPDATE_TOKEN = ''
try {
  UPDATE_TOKEN = fs.readFileSync(path.join(__dirname, 'update-token.txt'), 'utf8').trim()
} catch {
  UPDATE_TOKEN = ''
}

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
// Auto-update (electron-updater → GitHub Releases)
// ---------------------------------------------------------------------------
function sendUpdate (status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fc:update', status)
  }
}

let updaterWired = false
function setupAutoUpdate () {
  if (isDev || updaterWired) return // updater only runs in packaged builds
  updaterWired = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = true // we ship beta tags (e.g. v1.0.0-beta.2)
  // Authenticate to the private repo so the updater can read releases/assets.
  if (UPDATE_TOKEN) {
    try {
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'FlameAqua',
        repo: 'Fleet-Commander',
        private: true,
        token: UPDATE_TOKEN,
      })
    } catch (err) {
      console.error('[update] setFeedURL failed:', err)
    }
  }
  autoUpdater.on('checking-for-update', () => sendUpdate({ state: 'checking' }))
  autoUpdater.on('update-available', (i) => sendUpdate({ state: 'available', version: i?.version }))
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }))
  autoUpdater.on('download-progress', (p) =>
    sendUpdate({ state: 'downloading', percent: Math.round(p?.percent ?? 0) }))
  autoUpdater.on('update-downloaded', (i) => sendUpdate({ state: 'downloaded', version: i?.version }))
  autoUpdater.on('error', (err) => sendUpdate({ state: 'error', message: String(err?.message || err) }))
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
  setupAutoUpdate()
  // First check shortly after launch; the renderer can also trigger one.
  if (!isDev) setTimeout(() => autoUpdater.checkForUpdates().catch((e) => console.error('[update]', e)), 4000)

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

// Open external links (e.g. the GitHub link in Settings) in the OS browser.
ipcMain.on('fc:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url)
})

// Open a local folder in the OS file manager. Done from the app process (not
// the hidden Flask backend) so Explorer comes to the foreground instead of
// opening silently behind the window.
ipcMain.handle('fc:open-path', async (_e, p) => {
  if (typeof p === 'string' && p) return shell.openPath(p)
  return 'invalid path'
})

// Synchronous version lookup for the preload bridge.
ipcMain.on('fc:app-version', (e) => { e.returnValue = app.getVersion() })

// Auto-update controls driven from the renderer.
ipcMain.on('fc:update:check', () => {
  if (!isDev) autoUpdater.checkForUpdates().catch((err) => console.error('[update]', err))
})
ipcMain.on('fc:update:install', () => {
  if (!isDev) autoUpdater.quitAndInstall()
})

app.on('before-quit', stopBackend)
process.on('exit', stopBackend)
