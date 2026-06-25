const { contextBridge, ipcRenderer } = require('electron')

// Minimal, safe bridge. The renderer talks to the Flask backend over HTTP
// (same-origin via the Vite proxy / Flask static mount), so most app logic
// needs no IPC. This bridge is here for future desktop-only affordances
// (native file dialogs, window controls, backend status events).
let appVersion = ''
try {
  appVersion = ipcRenderer.sendSync('fc:app-version')
} catch {
  appVersion = ''
}

contextBridge.exposeInMainWorld('electron', {
  send: (channel, data) => ipcRenderer.send(channel, data),
  on: (channel, func) =>
    ipcRenderer.on(channel, (_event, ...args) => func(...args)),
  backendUrl: 'http://127.0.0.1:8765',
  // Frameless window controls (minimize / maximize / close).
  windowControl: (action) => ipcRenderer.send('fc:win', action),
  // Open a URL in the user's default browser.
  openExternal: (url) => ipcRenderer.send('fc:open-external', url),
  // Open a local folder in the OS file manager (foregrounded).
  openPath: (path) => ipcRenderer.invoke('fc:open-path', path),
  appVersion,
  // Auto-update bridge.
  onUpdateStatus: (cb) => ipcRenderer.on('fc:update', (_e, status) => cb(status)),
  checkForUpdate: () => ipcRenderer.send('fc:update:check'),
  installUpdate: () => ipcRenderer.send('fc:update:install'),
})
