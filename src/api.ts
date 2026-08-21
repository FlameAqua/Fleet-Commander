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

/** The message to show a user for anything thrown by this module. */
export function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err)
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

/** Build a `?dir=&category=` query string, omitting empty parts. */
function scriptQuery(dir: string, category = ''): string {
  const params = new URLSearchParams()
  if (dir.trim()) params.set('dir', dir.trim())
  if (category) params.set('category', category)
  const s = params.toString()
  return s ? `?${s}` : ''
}

// --- Backend response shapes (grown per-slice as features are migrated) ---
export interface ScriptInfo {
  name: string
  /** Subdirectory category; '' = the default (root) category. */
  category: string
  size: number
  modified: number
}

export interface ScriptsResponse {
  ok: boolean
  dir: string
  scripts: ScriptInfo[]
  /** Names of the category subdirectories that exist. */
  categories: string[]
}

export interface ScriptContent {
  ok: boolean
  name: string
  category: string
  content: string
}

// --- Scripts library (backed by /api/scripts in app.py) ---
export function listScripts(dir = ''): Promise<ScriptsResponse> {
  return apiGet<ScriptsResponse>(`/api/scripts${dirQuery(dir)}`)
}

export function getScript(name: string, dir = '', category = ''): Promise<ScriptContent> {
  return apiGet<ScriptContent>(`/api/scripts/${encodeURIComponent(name)}${scriptQuery(dir, category)}`)
}

export async function saveScript(
  name: string,
  content: string,
  dir = '',
  category = '',
): Promise<ScriptInfo> {
  const fd = new FormData()
  fd.append('name', name)
  fd.append('content', content)
  if (dir.trim()) fd.append('dir', dir.trim())
  if (category) fd.append('category', category)
  return parseJson<ScriptInfo>(await fetch(apiUrl('/api/scripts'), { method: 'POST', body: fd }))
}

export async function deleteScript(name: string, dir = '', category = ''): Promise<void> {
  await parseJson<{ ok: true }>(
    await fetch(apiUrl(`/api/scripts/${encodeURIComponent(name)}${scriptQuery(dir, category)}`), {
      method: 'DELETE',
    }),
  )
}

/** Create a new category (subdirectory) in the scripts folder. */
export async function createScriptCategory(name: string, dir = ''): Promise<string> {
  const fd = new FormData()
  fd.append('name', name)
  if (dir.trim()) fd.append('dir', dir.trim())
  const r = await parseJson<{ ok: true; category: string }>(
    await fetch(apiUrl('/api/scripts/category'), { method: 'POST', body: fd }),
  )
  return r.category
}

/** Delete a category; its scripts fall back to General. Returns how many moved. */
export async function deleteScriptCategory(name: string, dir = ''): Promise<number> {
  const params = new URLSearchParams({ name })
  if (dir.trim()) params.set('dir', dir.trim())
  const r = await parseJson<{ ok: true; moved: number }>(
    await fetch(apiUrl(`/api/scripts/category?${params.toString()}`), { method: 'DELETE' }),
  )
  return r.moved
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

export interface KdbxImport extends DecryptedCsv {
  /** Entries in the vault. */
  total: number
  /** Entries that had a usable SSH URL. */
  usable: number
  /** Entries left behind (web logins, no URL, duplicate host). */
  skipped: number
}

/**
 * Read a KeePass vault and get its SSH-able entries back as a canonical CSV.
 * The vault is opened server-side (loopback only) and never written to disk;
 * notes, attachments and non-SSH entries are left in the vault.
 */
export async function importKdbx(
  file: File,
  masterPassword: string,
  keyFile?: File | null,
): Promise<KdbxImport> {
  const fd = new FormData()
  fd.append('kdbx_file', file)
  fd.append('master_password', masterPassword)
  if (keyFile) fd.append('key_file', keyFile)
  const data = await parseJson<{
    ok: true
    csv: string
    filename: string
    total: number
    usable: number
    skipped: number
  }>(await fetch(apiUrl('/api/kdbx-csv'), { method: 'POST', body: fd }))
  return {
    csv: data.csv,
    filename: data.filename,
    total: data.total,
    usable: data.usable,
    skipped: data.skipped,
  }
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

/**
 * Delete a plaintext CSV from disk by absolute path. Backend refuses anything
 * that isn't an existing .csv file. Used after encrypt-on-import.
 */
export async function deleteCsvFile(path: string): Promise<void> {
  await parseJson<{ ok: true }>(
    await fetch(apiUrl('/api/delete-csv-file'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  )
}

// --- App settings (folder overrides) -------------------------------------- //
export interface AppSettings {
  csv_dir: string
  scripts_dir: string
  csv_dir_custom: boolean
  scripts_dir_custom: boolean
  default_csv_dir: string
  default_scripts_dir: string
  /** Sandbox target offered in "Input Manually" — '' means none. */
  test_host: string
  default_test_host: string
  test_host_custom: boolean
}

export function getSettings(): Promise<AppSettings & { ok: boolean }> {
  return apiGet<AppSettings & { ok: boolean }>('/api/settings')
}

function jsonPost(path: string, body: unknown): Promise<Response> {
  return fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function saveSettings(patch: {
  csv_dir?: string | null
  scripts_dir?: string | null
  /** '' clears the sandbox target; null restores the built-in default. */
  test_host?: string | null
}): Promise<AppSettings> {
  return parseJson<AppSettings>(await jsonPost('/api/settings', patch))
}

/** Native OS folder picker. Returns the chosen path, or null if cancelled. */
export async function pickFolder(title: string): Promise<string | null> {
  const data = await parseJson<{ ok: true; path: string | null }>(
    await jsonPost('/api/pick-folder', { title }),
  )
  return data.path
}

async function folderPath(which: 'csv' | 'scripts' | 'ships'): Promise<string> {
  const data = await parseJson<{ ok: true; path: string }>(
    await jsonPost('/api/folder-path', { which }),
  )
  return data.path
}

export async function openFolder(which: 'csv' | 'scripts' | 'ships'): Promise<void> {
  // Prefer the Electron app process: a folder opened by the hidden Flask
  // backend lands behind the window (Windows foreground rules), whereas the
  // app — the foreground process on click — brings Explorer to the front.
  if (window.electron?.openPath) {
    const p = await folderPath(which)
    if (p) {
      await window.electron.openPath(p)
      return
    }
  }
  await parseJson<{ ok: true }>(await jsonPost('/api/open-folder', { which }))
}

// --- Customisable ship art ------------------------------------------------ //
export function listShips(): Promise<{ ok: boolean; dir: string; ships: string[] }> {
  return apiGet('/api/ships')
}

export function shipUrl(name: string): string {
  return apiUrl(`/api/ship/${encodeURIComponent(name)}`)
}

export async function uploadShip(file: File): Promise<{ filename: string }> {
  const fd = new FormData()
  fd.append('ship', file)
  return parseJson<{ ok: true; filename: string }>(
    await fetch(apiUrl('/api/ship-upload'), { method: 'POST', body: fd }),
  )
}

export async function deleteShip(name: string): Promise<void> {
  await parseJson<{ ok: true }>(await jsonPost('/api/ship-delete', { name }))
}

// --- SSH auth pre-check (Test Connection) --------------------------------- //
export interface AuthResult {
  label: string
  ok: boolean
  error: string
  /** OS family from `uname -s`: 'linux' | 'openbsd' | '' (unknown). */
  os?: string
}

export interface AuthCheckHandlers {
  /** Total number of systems being checked (arrives first). */
  onMeta?: (total: number) => void
  /** One host finished — pass or fail. Called as each result streams in. */
  onResult?: (r: AuthResult) => void
  /** All hosts done. */
  onDone?: (passed: number, total: number) => void
  /** Pre-run failure (bad CSV, no systems, etc.). */
  onFatal?: (message: string) => void
  signal?: AbortSignal
}

/**
 * Connect-only SSH auth test. Takes the same multipart form as a deploy and
 * streams per-host results (NDJSON) so the caller can update a modal live.
 */
export async function authCheck(form: FormData, h: AuthCheckHandlers): Promise<void> {
  const res = await fetch(apiUrl('/api/auth-check'), { method: 'POST', body: form, signal: h.signal })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `auth-check failed: ${res.status} ${res.statusText}`)
  }
  // Back-compat: an older backend (before streaming) returns a single JSON
  // blob instead of NDJSON. Adapt it to the same callbacks so the modal fills
  // in one shot rather than showing "0 of 0".
  if (!(res.headers.get('Content-Type') || '').includes('ndjson')) {
    const data = (await res.json().catch(() => null)) as
      | { results?: AuthResult[]; passed?: number; total?: number; error?: string }
      | null
    if (data && Array.isArray(data.results)) {
      h.onMeta?.(data.total ?? data.results.length)
      for (const r of data.results) h.onResult?.(r)
      h.onDone?.(data.passed ?? data.results.filter((r) => r.ok).length, data.total ?? data.results.length)
      return
    }
    throw new Error(data?.error || 'auth-check failed')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const flush = (line: string) => {
    const s = line.trim()
    if (!s) return
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(s)
    } catch {
      return
    }
    if (ev.type === 'meta') h.onMeta?.(ev.total as number)
    else if (ev.type === 'result')
      h.onResult?.({ label: ev.label as string, ok: ev.ok as boolean, error: (ev.error as string) ?? '', os: (ev.os as string) ?? '' })
    else if (ev.type === 'done') h.onDone?.(ev.passed as number, ev.total as number)
    else if (ev.type === 'fatal') h.onFatal?.(ev.message as string)
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      flush(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  }
  buf += decoder.decode()
  if (buf) flush(buf)
}
