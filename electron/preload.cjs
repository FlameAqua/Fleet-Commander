const { contextBridge, ipcRenderer, webUtils } = require('electron')

// Minimal, safe bridge. The renderer talks to the Flask backend over HTTP
// (same-origin via the Vite proxy / Flask static mount), so most app logic
// needs no IPC.
//
// SECURITY: every entry below is a named, fixed-purpose function. Deliberately
// NOT exposed is a generic `send(channel, data)` / `on(channel, cb)` pair — that
// hands the renderer the whole IPC surface, so any script running in the page
// could trigger e.g. quit-and-install. If you need a new capability, add a
// specific function here and a matching `ipcMain` handler that validates its
// input; don't reintroduce a passthrough.
let appVersion = ''
try {
  appVersion = ipcRenderer.sendSync('fc:app-version')
} catch {
  appVersion = ''
}

contextBridge.exposeInMainWorld('electron', {
  backendUrl: 'http://127.0.0.1:8765',
  // Frameless window controls (minimize / maximize / close).
  windowControl: (action) => ipcRenderer.send('fc:win', action),
  // Open a URL in the user's default browser.
  openExternal: (url) => ipcRenderer.send('fc:open-external', url),
  // Open a local folder in the OS file manager (foregrounded).
  openPath: (path) => ipcRenderer.invoke('fc:open-path', path),
  // Resolve the absolute disk path of a picked File (Electron replacement for
  // the removed File.path). Returns '' if unavailable (e.g. web build).
  filePath: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  appVersion,
  // Auto-update bridge. onUpdateStatus returns an unsubscribe function.
  onUpdateStatus: (cb) => {
    const handler = (_e, status) => cb(status)
    ipcRenderer.on('fc:update', handler)
    return () => ipcRenderer.removeListener('fc:update', handler)
  },
  checkForUpdate: () => ipcRenderer.send('fc:update:check'),
  installUpdate: () => ipcRenderer.send('fc:update:install'),
})
