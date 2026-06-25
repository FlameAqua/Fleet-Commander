/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute backend URL for packaged builds that load from file://. Unset in dev. */
  readonly VITE_BACKEND_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version?: string }
  | { state: 'downloading'; percent?: number }
  | { state: 'downloaded'; version?: string }
  | { state: 'none' }
  | { state: 'error'; message?: string }

interface FleetElectronBridge {
  send: (channel: string, data?: unknown) => void
  on: (channel: string, func: (...args: unknown[]) => void) => void
  backendUrl: string
  windowControl?: (action: 'minimize' | 'maximize' | 'close') => void
  /** Open a URL in the user's default browser (Electron shell.openExternal). */
  openExternal?: (url: string) => void
  /** Open a local folder in the OS file manager, foregrounded (shell.openPath). */
  openPath?: (path: string) => Promise<string>
  /** The packaged app version (app.getVersion()). */
  appVersion?: string
  // --- auto-update (electron-updater) ---
  onUpdateStatus?: (cb: (status: UpdateStatus) => void) => void
  checkForUpdate?: () => void
  /** Quit and install a downloaded update. */
  installUpdate?: () => void
}

interface Window {
  electron?: FleetElectronBridge
}
