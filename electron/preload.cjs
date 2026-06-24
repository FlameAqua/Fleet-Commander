const { contextBridge, ipcRenderer } = require('electron')

// Minimal, safe bridge. The renderer talks to the Flask backend over HTTP
// (same-origin via the Vite proxy / Flask static mount), so most app logic
// needs no IPC. This bridge is here for future desktop-only affordances
// (native file dialogs, window controls, backend status events).
contextBridge.exposeInMainWorld('electron', {
  send: (channel, data) => ipcRenderer.send(channel, data),
  on: (channel, func) =>
    ipcRenderer.on(channel, (_event, ...args) => func(...args)),
  backendUrl: 'http://127.0.0.1:8765',
  // Frameless window controls (minimize / maximize / close).
  windowControl: (action) => ipcRenderer.send('fc:win', action),
})
