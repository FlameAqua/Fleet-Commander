// CSV + SSH-target helpers ported faithfully from the original vanilla-JS UI.
// These are pure functions (no DOM / FileReader) so they can be unit-tested and
// reused by the Source feature. They mirror deployer.py's parsing so the
// per-host labels we compute match what the backend will generate.

/** RFC-4180-ish CSV parser. Handles quotes, "" and \" escapes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false
  for (let i = 0; i <= text.length; i++) {
    const c = i < text.length ? text[i] : '\n'
    if ((c === '\n' || c === '\r') && !inQ) {
      row.push(field)
      field = ''
      if (row.some((f) => f.trim())) rows.push(row)
      row = []
      if (c === '\r' && text[i + 1] === '\n') i++
    } else if (inQ) {
      if (c === '\\' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') {
        const nxt = text[i + 1]
        if (nxt === undefined || nxt === ',' || nxt === '\n' || nxt === '\r') inQ = false
        else field += '"'
      } else {
        field += c
      }
    } else if (c === '"') {
      inQ = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else {
      field += c
    }
  }
  if (field || row.length) {
    row.push(field)
    if (row.some((f) => f.trim())) rows.push(row)
  }
  return rows
}

/**
 * Sanitise a CSV column header into the shell variable name the backend
 * exposes it as (mirrors deployer._sanitise_var_name): non-[A-Za-z0-9_] → _,
 * and a leading digit gets a `_` prefix. e.g. "Web Site" → "Web_Site".
 */
export function sanitizeVarName(raw: string): string {
  let s = (raw || '').trim().replace(/[^A-Za-z0-9_]/g, '_')
  if (!s) return ''
  if (/^[0-9]/.test(s)) s = '_' + s
  return s
}

/**
 * The CSV's header names, exactly as written. These are the keys the backend
 * uses for host_vars (and therefore what `root_password_column` must match) —
 * unlike csvVariableNames(), which sanitises them into $variable form.
 */
export function csvHeaderNames(text: string): string[] {
  const header = parseCsv(text)[0] ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const h of header) {
    const name = (h || '').trim()
    if (name && !seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

/** The per-system shell variables available from a Compound CSV's columns. */
export function csvVariableNames(text: string): string[] {
  const header = parseCsv(text)[0] ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const h of header) {
    const v = sanitizeVarName(h)
    if (v && !seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

/** Quote a CSV cell when it contains a comma, quote, or newline. */
export function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Coerce a URL cell into a clean `ssh://...` string parse_ssh_url() accepts.
 * Accepts ssh:// verbatim and bare host / user@host / host:port. Rejects any
 * other scheme (http(s)://, etc.) by returning null — those are usually the
 * web-management URL, not the SSH endpoint.
 */
export function normaliseSshTarget(rawUrl: string): string | null {
  const s = String(rawUrl || '').trim()
  if (!s) return null
  if (/^ssh:\/\//i.test(s)) return s
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null
  return 'ssh://' + s
}

/** Rewrite an ssh URL (or bare host) to use a specific login user. */
export function injectUserIntoUrl(url: string, user: string): string {
  if (!user) return url
  const u = encodeURIComponent(user)
  if (/^ssh:\/\//i.test(url)) {
    if (/^ssh:\/\/[^/@]+@/i.test(url)) return url.replace(/^(ssh:\/\/)[^/@]+@/i, `$1${u}@`)
    return url.replace(/^ssh:\/\//i, `ssh://${u}@`)
  }
  return `ssh://${u}@${url}`
}

/** Canonical Target.label the backend produces (default user=root, port=22). */
export function canonicalLabel(rawUrl: string): string {
  let url = (rawUrl || '').trim()
  if (!url) return ''
  if (!url.includes('://')) url = 'ssh://' + url
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return ''
  }
  if (u.protocol !== 'ssh:') return ''
  const user = u.username || 'root'
  const port = u.port || '22'
  return `ssh://${user}@${u.hostname}:${port}`
}

/** `ssh://root@pbx.example:22` → `pbx.example` — for display. */
export function displayHost(label: string): string {
  return label.replace(/^ssh:\/\/[^@]+@/, '').replace(/:\d+$/, '')
}

/** `ssh://root@pbx.example:22` → `root@pbx.example:22` — for copying. */
export function bareHost(label: string): string {
  return label.replace(/^ssh:\/\//, '')
}

export interface ColumnOverrides {
  website?: string
  password?: string
  loginName?: string
  account?: string
}

export interface CompoundColumns {
  urlIdx: number
  pwIdx: number
  loginIdx: number
  acctIdx: number
}

/**
 * Resolve compound-CSV column indices honoring operator overrides, falling back
 * to standard KeePass / common header names. Returns null if no URL column.
 */
export function resolveCompoundColumns(
  header: string[],
  overrides: ColumnOverrides = {},
): CompoundColumns | null {
  const lower = header.map((h) => h.trim().toLowerCase())
  const pick = (override: string | undefined, fallbacks: string[]): number => {
    const o = (override || '').trim().toLowerCase()
    if (o) {
      const i = lower.indexOf(o)
      if (i !== -1) return i
    }
    for (const f of fallbacks) {
      const i = lower.indexOf(f)
      if (i !== -1) return i
    }
    return -1
  }
  const urlIdx = pick(overrides.website, ['web site', 'website', 'url', 'ssh', 'ssh_url', 'host'])
  const pwIdx = pick(overrides.password, ['password', 'pass', 'pwd'])
  const loginIdx = pick(overrides.loginName, ['login name', 'login', 'username', 'user'])
  const acctIdx = pick(overrides.account, ['account', 'name', 'title', 'label'])
  if (urlIdx === -1) return null
  return { urlIdx, pwIdx, loginIdx, acctIdx }
}

/**
 * Every non-empty column becomes a $variable for the script. The Password
 * column is reserved (excluded) unless includePassword is set.
 */
export function collectHostExtras(
  row: string[],
  header: string[],
  cols: CompoundColumns,
  includePassword: boolean,
): Record<string, string> {
  const reserved = new Set<number>()
  if (!includePassword) reserved.add(cols.pwIdx)
  const extras: Record<string, string> = {}
  for (let c = 0; c < header.length; c++) {
    if (reserved.has(c)) continue
    const name = (header[c] || '').trim()
    if (!name) continue
    const val = row[c]
    if (val === undefined || val === null || val === '') continue
    extras[name] = String(val)
  }
  return extras
}

/** Canonical KeePass header the backend loader recognises. */
export const CANONICAL_HEADER = 'Account,Login Name,Password,Web Site,Comments'

export interface HostEntry {
  /** Canonical Target.label the backend will generate. */
  label: string
  /** Display name (Account column, or the label). */
  name: string
  /** Normalised ssh:// url. */
  url: string
  /** The canonical CSV row for this host. */
  csvLine: string
}

export interface CompoundResult {
  /** One entry per unique host (deduped by label, matching the backend). */
  entries: HostEntry[]
  /** Per-host { canonicalLabel: { col: val } } sent as host_vars JSON. */
  hostVars: Record<string, Record<string, string>>
  /** Rows skipped (empty/unparseable URL). */
  skipped: number
  /** Header names detected, for the columns hint. */
  detectedColumns: string[]
}

/** Rebuild a canonical CSV from a (possibly filtered) set of host entries. */
export function canonicalCsvFromEntries(entries: HostEntry[]): string {
  return [CANONICAL_HEADER, ...entries.map((e) => e.csvLine)].join('\n') + '\n'
}

export interface BuildCompoundOptions {
  overrides?: ColumnOverrides
  /** Use the Login Name column as the SSH user (overrides user@ in URL). */
  useLogin?: boolean
  /** Expose the Password column under this name in host_vars (3CX csv mode). */
  forcePwCol?: string | null
}

/**
 * Normalise a compound CSV into the canonical KeePass format plus per-host vars.
 * Mirrors the original buildCanonicalKeepassCsv. $Password is always exposed
 * (the original UI retired the opt-in checkbox); forcePwCol only affects the
 * key name used.
 */
export function buildCanonicalKeepass(text: string, opts: BuildCompoundOptions = {}): CompoundResult {
  const rows = parseCsv(text)
  if (!rows.length) throw new Error('CSV is empty')
  const header = rows[0]
  const cols = resolveCompoundColumns(header, opts.overrides)
  if (!cols) throw new Error("Couldn't find a URL column. Set 'URL column' under Column mapping.")
  if (cols.pwIdx === -1) throw new Error("Couldn't find a Password column. Set it under Column mapping.")
  const useLogin = !!opts.useLogin && cols.loginIdx !== -1

  const entries: HostEntry[] = []
  const hostVars: Record<string, Record<string, string>> = {}
  const seen = new Set<string>()
  let skipped = 0

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const rawUrl = (row[cols.urlIdx] || '').trim()
    let url = normaliseSshTarget(rawUrl)
    if (!url) {
      if (rawUrl) skipped++
      continue
    }
    const pw = row[cols.pwIdx] || ''
    const login = cols.loginIdx !== -1 ? row[cols.loginIdx] || '' : ''
    const acct = cols.acctIdx !== -1 ? row[cols.acctIdx] || '' : ''
    if (useLogin && login.trim()) url = injectUserIntoUrl(url, login.trim())
    const label = canonicalLabel(url)
    if (!label) {
      skipped++
      continue
    }
    if (seen.has(label)) continue // dedupe by label, matching the backend loader
    seen.add(label)
    const csvLine = [acct, login, pw, url, ''].map(csvCell).join(',')
    const extras = collectHostExtras(row, header, cols, true)
    if (Object.keys(extras).length) hostVars[label] = extras
    entries.push({ label, name: acct.trim() || label, url, csvLine })
  }
  if (!entries.length)
    throw new Error('No usable host rows found. Ensure you have valid SSH URLs in your URL column.')

  return {
    entries,
    hostVars,
    skipped,
    detectedColumns: header.map((h) => h.trim()).filter(Boolean),
  }
}

export interface ManualRow {
  url: string
  user: string
  password: string
}

export interface PastedRow extends ManualRow {
  /** 0-based index of the source line, so the raw text can be filtered later. */
  line: number
}

export interface PasteResult {
  rows: PastedRow[]
  /** Non-empty lines that weren't a usable SSH target. */
  skipped: number
  /** True when the first line looked like a spreadsheet header and was dropped. */
  droppedHeader: boolean
}

const PASTE_HEADER_RE = /^(host|hosts|url|ssh|ssh_url|web ?site|target|ip|address)$/i

/**
 * Parse a pasted block of hosts into manual rows.
 *
 * One host per line, fields separated by TAB (so a spreadsheet selection pastes
 * straight in) or comma:
 *
 *     10.0.0.5
 *     ssh://admin@pbx.example:2222
 *     pbx2.example,admin,hunter2
 *     pbx3.example<TAB>admin<TAB>hunter2
 *
 * Fields 2 and 3 (user, password) are optional and fall back to the defaults.
 * A `user@host` first field supplies the user too; an explicit user field wins.
 * Blank lines and `#` comments are ignored, as is a leading spreadsheet header.
 */
export function parsePastedHosts(
  text: string,
  defaults: { user?: string; password?: string } = {},
): PasteResult {
  const rows: PastedRow[] = []
  const seen = new Set<string>()
  let skipped = 0
  let droppedHeader = false
  const lines = String(text || '').split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = (line.includes('\t') ? line.split('\t') : line.split(',')).map((f) => f.trim())
    const target = parts[0] ?? ''
    if (!target) continue
    // A pasted spreadsheet usually brings its header row along.
    if (!rows.length && !skipped && PASTE_HEADER_RE.test(target)) {
      droppedHeader = true
      continue
    }
    const url = normaliseSshTarget(target)
    if (!url) {
      skipped++
      continue
    }
    const user = parts[1] || defaults.user || ''
    const full = user ? injectUserIntoUrl(url, user) : url
    const label = canonicalLabel(full)
    if (!label) {
      skipped++
      continue
    }
    if (seen.has(label)) continue // same host twice in one paste
    seen.add(label)
    rows.push({ line: i, url, user, password: parts[2] || defaults.password || '' })
  }
  return { rows, skipped, droppedHeader }
}

/** Keep only the lines of a pasted block whose hosts pass `keep`. */
export function filterPastedText(
  text: string,
  defaults: { user?: string; password?: string },
  keep: (label: string) => boolean,
): string {
  const lines = String(text || '').split(/\r?\n/)
  const drop = new Set<number>()
  for (const row of parsePastedHosts(text, defaults).rows) {
    const label = canonicalLabel(row.user ? injectUserIntoUrl(row.url, row.user) : row.url)
    if (label && !keep(label)) drop.add(row.line)
  }
  return lines.filter((_l, i) => !drop.has(i)).join('\n')
}

/**
 * Render manual rows as a canonical KeePass-format CSV, so a fleet typed by
 * hand can be saved and later re-imported through "Import CSV". The output uses
 * CANONICAL_HEADER, which resolveCompoundColumns() maps back onto url/login/
 * password without the operator touching Column mapping.
 *
 * Unlike buildManualCsvs (which feeds a run) this tolerates blank passwords —
 * exporting a partly-filled fleet to finish later is legitimate.
 */
export function manualRowsToCanonicalCsv(rows: ManualRow[]): string {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const raw = row.url.trim()
    if (!raw) continue
    const base = normaliseSshTarget(raw)
    if (!base) continue
    const usr = row.user.trim()
    const url = usr ? injectUserIntoUrl(base, usr) : base
    const label = canonicalLabel(url)
    if (!label || seen.has(label)) continue
    seen.add(label)
    // Account is display-only; the hostname keeps the exported file readable.
    let host = url
    try {
      host = new URL(url).hostname || url
    } catch {
      /* keep the raw url as the name */
    }
    const login = usr || 'root'
    lines.push([host, login, row.password, url, ''].map(csvCell).join(','))
  }
  if (!lines.length) throw new Error('Enter at least one SSH URL or host first.')
  return [CANONICAL_HEADER, ...lines].join('\n') + '\n'
}

/** Build the two virtual CSVs (ssh urls + host,password) from manual rows. */
export function buildManualCsvs(rows: ManualRow[]): { sshText: string; passText: string } {
  const sshLines = ['url']
  const passLines = ['host,password']
  let kept = 0
  for (const row of rows) {
    const url = row.url.trim()
    if (!url) continue
    const usr = row.user.trim()
    const pw = row.password
    if (!pw) throw new Error(`Row ${kept + 1}: enter a password for ${url}.`)
    const fullUrl = usr
      ? injectUserIntoUrl(url, usr)
      : url.toLowerCase().startsWith('ssh://')
        ? url
        : `ssh://root@${url}`
    sshLines.push(csvCell(fullUrl))
    passLines.push(`${csvCell(fullUrl)},${csvCell(pw)}`)
    kept++
  }
  if (!kept) throw new Error('Enter at least one SSH URL or host first.')
  return { sshText: sshLines.join('\n') + '\n', passText: passLines.join('\n') + '\n' }
}
