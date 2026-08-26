import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { spawn, spawnSync } from 'child_process'
import fs from 'node:fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'

const { autoUpdater } = electronUpdater

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
  // Prod: a PyInstaller ONEDIR bundle + the built SPA, both shipped as
  // extraResources. The onedir bundle lands at resources/backend/
  // fleet-commander-backend/ with the launcher exe inside it.
  const backendDir = path.join(process.resourcesPath, 'backend', 'fleet-commander-backend')
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

const BACKEND_BIN = isWindows ? 'fleet-commander-backend.exe' : 'fleet-commander-backend'

function stopBackend () {
  const proc = backend
  backend = null
  if (!proc || proc.killed) return
  // Use a SYNCHRONOUS kill: on quit/will-install we must finish before the
  // process exits, otherwise the backend is orphaned on port 8765 (which then
  // makes the installer think the app is still running). taskkill /T takes
  // down the whole tree (the PyInstaller bootloader + its python child).
  if (isWindows && proc.pid) {
    try {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { timeout: 5000 })
    } catch {
      try { proc.kill() } catch {}
    }
  } else {
    try { proc.kill('SIGTERM') } catch {}
  }
}

/** Prod-only: kill any orphaned backend exe (e.g. left by a crash or upgrade)
 *  so we don't end up talking to a stale, outdated sidecar on our port. */
function killStaleBackend () {
  try {
    if (isWindows) {
      spawnSync('taskkill', ['/F', '/T', '/IM', BACKEND_BIN], { timeout: 5000 })
    } else {
      spawnSync('pkill', ['-f', BACKEND_BIN], { timeout: 5000 })
    }
  } catch {
    /* nothing to kill */
  }
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

/** Resolve once `url` returns a response (any status), or after `timeoutMs`. */
function waitForUrl (url, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const ping = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve(true)
      })
      req.on('error', () => {
        if (Date.now() > deadline) resolve(false)
        else setTimeout(ping, 400)
      })
      req.setTimeout(600000, () => {
        req.destroy()
        resolve(false)
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
  const startUrl = isDev ? VITE_DEV_SERVER_URL : BACKEND_URL
  if (isDev) {
    // Vite listens long before it can serve: the first request waits on the
    // dependency pre-bundle and the initial transform, which is tens of seconds
    // on a cold cache. Paint a local boot screen immediately and swap to the
    // dev server once it genuinely answers, so the window is never blank.
    mainWindow.loadFile(path.join(__dirname, 'boot.html'))
    void waitForUrl(startUrl).then(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(startUrl)
    })
  } else {
    mainWindow.loadURL(startUrl)
  }
  // Detached DevTools costs ~3s of dev startup — FC_DEVTOOLS=0 skips it.
  if (isDev && process.env.FC_DEVTOOLS !== '0') mainWindow.webContents.openDevTools({ mode: 'detach' })

  // A failed load leaves a permanently blank window — Electron never retries on
  // its own. That's the difference between "the dev server was still warming up
  // for one more second" and "restart the whole stack", so retry a few times.
  let loadRetries = 0
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame) return
    if (code === -3) return // ERR_ABORTED — a superseded navigation, not a failure
    if (loadRetries++ >= 20 || !mainWindow || mainWindow.isDestroyed()) return
    console.error(`[window] load failed (${code} ${desc}) — retry ${loadRetries}`)
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(startUrl)
    }, 500)
  })

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

  // Basic right-click context menu (Cut / Copy / Paste / Select All) — Electron
  // has none by default, so text fields felt broken without it.
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const { editFlags, isEditable, selectionText } = params
    const hasSelection = !!selectionText
    // Only show the native menu for editable fields or an active text selection;
    // otherwise let the app's own DOM menus (e.g. result "Copy title/URL") handle it.
    if (!isEditable && !hasSelection) return
    const menu = Menu.buildFromTemplate([
      { role: 'cut', enabled: isEditable && editFlags.canCut },
      { role: 'copy', enabled: editFlags.canCopy && hasSelection },
      { role: 'paste', enabled: isEditable && editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: editFlags.canSelectAll },
    ])
    menu.popup({ window: mainWindow })
  })

  // Navigation lockdown (defense-in-depth for a credential-handling app): this
  // window only ever shows our own app origin. Block any attempt to navigate
  // away from it or to spawn child windows — injected/remote content must never
  // be able to load inside a context that carries the preload bridge. Genuine
  // external https links are handed to the OS browser instead.
  const appOrigin = new URL(isDev ? VITE_DEV_SERVER_URL : BACKEND_URL).origin
  mainWindow.webContents.on('will-navigate', (e, url) => {
    let origin = ''
    try { origin = new URL(url).origin } catch { /* malformed → block */ }
    if (origin !== appOrigin) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // No <webview> is used; refuse any attempt to attach one.
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault())
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
  // Stable channel: resolve updates through GitHub's /releases/latest, which
  // excludes pre-releases: the public GitHub provider resolves the stable
  // channel through `/releases/latest`, unauthenticated and not subject to the
  // API rate limit. Setting this true instead reads the releases feed and
  // prefers pre-release tags.
  autoUpdater.allowPrerelease = false
  // No setFeedURL and no token: the repository is public, so electron-builder's
  // generated app-update.yml (from `build.publish` in package.json) is all the
  // updater needs. Nothing secret ships inside the app.
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

/**
 * Only one copy of the installed app may run. A second instance would spawn a
 * rival Flask sidecar fighting over port 8765, run its own auto-updater, and
 * let the operator start two fleet-wide runs that know nothing about each
 * other. Launching again just focuses the window that's already open.
 *
 * Packaged builds only: the lock is keyed on userData, which dev shares with
 * the installed app — so locking in dev would mean an installed Fleet Commander
 * silently blocks `npm run dev` (and vice versa).
 */
const gotInstanceLock = isDev || app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  })
}

app.whenReady().then(async () => {
  // Lost the race for the single-instance lock: quit without touching the
  // backend — the instance that holds it owns port 8765.
  if (!gotInstanceLock) return
  // No application menu (File/Edit/View/Window) — this is a focused tool UI.
  Menu.setApplicationMenu(null)
  // In dev the backend is started by `npm run dev` (the `dev:backend` process),
  // so don't double-spawn it. In a packaged build WE own the backend — any
  // sidecar already on the port is a stale orphan (crash / improper close /
  // mid-upgrade), so take it down and start our own (correct-version) one.
  if (isDev) {
    if (await isBackendUp()) {
      console.log('[flask] already running (dev) — not spawning')
    } else {
      startBackend()
    }
  } else {
    if (await isBackendUp()) {
      console.log('[flask] stale backend on port — killing and restarting')
      killStaleBackend()
      await new Promise((r) => setTimeout(r, 600)) // let the port free up
    }
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
// opening silently behind the window. Restricted to existing DIRECTORIES:
// shell.openPath on a file launches it with its default handler (a .exe would
// execute), so refusing non-directories keeps a compromised renderer from
// turning this bridge into an arbitrary-file launcher.
ipcMain.handle('fc:open-path', async (_e, p) => {
  if (typeof p !== 'string' || !p) return 'invalid path'
  try {
    if (!fs.statSync(p).isDirectory()) return 'not a directory'
  } catch {
    return 'path not found'
  }
  return shell.openPath(p)
})

// Synchronous version lookup for the preload bridge.
ipcMain.on('fc:app-version', (e) => { e.returnValue = app.getVersion() })

// Auto-update controls driven from the renderer.
ipcMain.on('fc:update:check', (e) => {
  if (isDev) {
    // The updater only runs in a packaged build; tell the tester rather than
    // leaving the UI spinning on "checking…".
    e.sender.send('fc:update', {
      state: 'error',
      message: 'Updates only run in the installed build (not in dev).',
    })
    return
  }
  autoUpdater.checkForUpdates().catch((err) => console.error('[update]', err))
})
ipcMain.on('fc:update:install', () => {
  if (!isDev) {
    stopBackend() // free the port + unlock the exe before the installer runs
    // (isSilent=true) runs the NSIS installer silently — no wizard, keeps the
    // existing install location/options, so updates are fast and don't re-ask
    // anything. (isForceRunAfter=true) relaunches the app afterwards.
    autoUpdater.quitAndInstall(true, true)
  }
})

app.on('before-quit', stopBackend)
process.on('exit', stopBackend)
