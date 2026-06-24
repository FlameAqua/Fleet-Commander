/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute backend URL for packaged builds that load from file://. Unset in dev. */
  readonly VITE_BACKEND_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface FleetElectronBridge {
  send: (channel: string, data?: unknown) => void
  on: (channel: string, func: (...args: unknown[]) => void) => void
  backendUrl: string
  windowControl?: (action: 'minimize' | 'maximize' | 'close') => void
}

interface Window {
  electron?: FleetElectronBridge
}
