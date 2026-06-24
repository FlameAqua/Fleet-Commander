// Central place for talking to the Flask sidecar.
//
// Dev:  API_BASE = '' and Vite proxies '/api/*' to http://127.0.0.1:8765.
// Prod: Flask serves the built SPA (Phase 6), so '' stays same-origin too.
// If a packaged build ever loads from file://, set VITE_BACKEND_URL at build
// time and it will be used as an absolute base.
export const API_BASE: string = import.meta.env.VITE_BACKEND_URL ?? ''

export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  return `${API_BASE}${p}`
}

/** Error carrying the backend's `error` message and HTTP status. */
export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  if (!res.ok || data.ok === false) {
    throw new ApiError(data.error ?? `${res.status} ${res.statusText}`, res.status)
  }
  return data as T
}

export async function apiGet<T>(path: string): Promise<T> {
  return parseJson<T>(await fetch(apiUrl(path)))
}

export interface HeplifyDefaults {
  interface: string
  hep_server: string
  capture_mode: string
  discard_methods: string
  max_workers: number
}

export interface AppConfig {
  ok: boolean
  test_host: string
  defaults: HeplifyDefaults
}

export function getConfig(): Promise<AppConfig> {
  return apiGet<AppConfig>('/api/config')
}

/** Append a `dir` query param when a custom scripts directory is active. */
function dirQuery(dir: string): string {
  const d = dir.trim()
  return d ? `?dir=${encodeURIComponent(d)}` : ''
}

// --- Backend response shapes (grown per-slice as features are migrated) ---
export interface ScriptInfo {
  name: string
  size: number
  modified: number
}

export interface ScriptsResponse {
  ok: boolean
  dir: string
  scripts: ScriptInfo[]
}

export interface ScriptContent {
  ok: boolean
  name: string
  content: string
}

// --- Scripts library (backed by /api/scripts in app.py) ---
export function listScripts(dir = ''): Promise<ScriptsResponse> {
  return apiGet<ScriptsResponse>(`/api/scripts${dirQuery(dir)}`)
}

export function getScript(name: string, dir = ''): Promise<ScriptContent> {
  return apiGet<ScriptContent>(`/api/scripts/${encodeURIComponent(name)}${dirQuery(dir)}`)
}

export async function saveScript(
  name: string,
  content: string,
  dir = '',
): Promise<ScriptInfo> {
  const fd = new FormData()
  fd.append('name', name)
  fd.append('content', content)
  if (dir.trim()) fd.append('dir', dir.trim())
  return parseJson<ScriptInfo>(await fetch(apiUrl('/api/scripts'), { method: 'POST', body: fd }))
}

export async function deleteScript(name: string, dir = ''): Promise<void> {
  await parseJson<{ ok: true }>(
    await fetch(apiUrl(`/api/scripts/${encodeURIComponent(name)}${dirQuery(dir)}`), {
      method: 'DELETE',
    }),
  )
}

/** Opens the OS folder picker server-side. Returns the chosen path, or null if cancelled. */
export async function pickScriptsDir(): Promise<string | null> {
  const data = await parseJson<{ ok: true; path: string | null }>(
    await fetch(apiUrl('/api/pick-scripts-dir'), { method: 'POST' }),
  )
  return data.path
}

// --- CSV library (data-dir csv/ folder) ---
export interface CsvFileInfo {
  name: string
  encrypted: boolean
  size: number
  modified: number
}

export function listCsvFiles(): Promise<{ ok: boolean; dir: string; files: CsvFileInfo[] }> {
  return apiGet('/api/csv-files')
}

/** Read a plaintext .csv from the data-dir csv/ folder. */
export async function getServerCsv(name: string): Promise<DecryptedCsv> {
  const data = await apiGet<{ csv: string; filename: string }>(`/api/csv-file/${encodeURIComponent(name)}`)
  return { csv: data.csv, filename: data.filename }
}

/** Decrypt a server-side .enc file from the data-dir csv/ folder. */
export async function decryptServerCsv(name: string, masterPassword: string): Promise<DecryptedCsv> {
  const fd = new FormData()
  fd.append('server_name', name)
  fd.append('master_password', masterPassword)
  const data = await parseJson<{ ok: true; csv: string; filename: string }>(
    await fetch(apiUrl('/api/decrypt-csv'), { method: 'POST', body: fd }),
  )
  return { csv: data.csv, filename: data.filename }
}

// --- Encrypted CSV (.enc) helpers, backed by /api/{decrypt,encrypt}-csv ---
export interface DecryptedCsv {
  csv: string
  filename: string
}

/** Decrypt a master-password-encrypted `.enc` CSV. Plaintext stays in memory. */
export async function decryptCsv(file: File, masterPassword: string): Promise<DecryptedCsv> {
  const fd = new FormData()
  fd.append('enc_file', file)
  fd.append('master_password', masterPassword)
  const data = await parseJson<{ ok: true; csv: string; filename: string }>(
    await fetch(apiUrl('/api/decrypt-csv'), { method: 'POST', body: fd }),
  )
  return { csv: data.csv, filename: data.filename }
}

/** Encrypt a plaintext CSV into the `.enc` format; returns the blob + suggested name. */
export async function encryptCsv(
  file: File,
  masterPassword: string,
): Promise<{ blob: Blob; filename: string }> {
  const fd = new FormData()
  fd.append('csv_file', file)
  fd.append('master_password', masterPassword)
  const res = await fetch(apiUrl('/api/encrypt-csv'), { method: 'POST', body: fd })
  if (!res.ok) {
    // Error responses are JSON even though success is binary.
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(data.error ?? `${res.status} ${res.statusText}`, res.status)
  }
  const cd = res.headers.get('Content-Disposition') ?? ''
  const m = /filename="?([^"]+)"?/.exec(cd)
  const filename = m ? m[1] : 'fleet.enc'
  return { blob: await res.blob(), filename }
}

/** Encrypt a plaintext CSV and save the `.enc` straight into the CSV library folder. */
export async function encryptCsvToFolder(
  file: File,
  masterPassword: string,
): Promise<{ filename: string; dir: string }> {
  const fd = new FormData()
  fd.append('csv_file', file)
  fd.append('master_password', masterPassword)
  fd.append('save', 'true')
  return parseJson<{ ok: true; filename: string; dir: string }>(
    await fetch(apiUrl('/api/encrypt-csv'), { method: 'POST', body: fd }),
  )
}

/** Open the CSV library folder in the OS file manager (local desktop). */
export async function openCsvFolder(): Promise<{ dir: string }> {
  return parseJson<{ ok: true; dir: string }>(
    await fetch(apiUrl('/api/open-csv-folder'), { method: 'POST' }),
  )
}
