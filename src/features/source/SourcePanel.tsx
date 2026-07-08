import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePrompt } from '../../components/PromptProvider'
import { useToast } from '../../components/ToastProvider'
import {
  ApiError,
  decryptCsv,
  decryptServerCsv,
  deleteCsvFile,
  encryptCsvToFolder,
  getServerCsv,
  listCsvFiles,
  openFolder,
  type CsvFileInfo,
} from '../../api'
import { buildCanonicalKeepass, canonicalLabel, normaliseSshTarget, type HostEntry } from '../../lib/csv'
import { downloadBlob, readFileText } from '../../lib/file'
import {
  type CompoundSource,
  type ManualSource,
  type SourceMode,
  type SourceState,
} from './sourceModel'
import './source.css'

const MODES: { id: SourceMode; label: string }[] = [
  { id: 'compound', label: 'Import CSV' },
  { id: 'manual', label: 'Input Manually' },
  { id: 'test', label: 'Test Host' },
]

interface Props {
  source: SourceState
  onChange: (next: SourceState) => void
  onModeChange: (mode: SourceMode) => void
  testHost: string | null
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err)
}

type NoticeKind = 'error' | 'ok'
type Notify = (text: string | null, kind?: NoticeKind) => void

export function SourcePanel({ source, onChange, onModeChange, testHost }: Props) {
  return (
    <section className="source">
      <div className="source__tabs" role="tablist">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={source.mode === m.id}
            className={source.mode === m.id ? 'is-active' : ''}
            onClick={() => onModeChange(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="source__body">
        {source.mode === 'compound' && <CompoundEditor source={source} onChange={onChange} />}
        {source.mode === 'manual' && <ManualEditor source={source} onChange={onChange} />}
        {source.mode === 'test' && <TestEditor testHost={testHost} />}
      </div>
    </section>
  )
}

// --------------------------------------------------------------------------
// Compound / KeePass CSV
// --------------------------------------------------------------------------
function CompoundEditor({
  source,
  onChange,
}: {
  source: CompoundSource
  onChange: (s: SourceState) => void
}) {
  const [serverFiles, setServerFiles] = useState<CsvFileInfo[]>([])
  const prompt = usePrompt()
  const toast = useToast()

  const notify: Notify = (text, kind = 'error') => toast(text, kind)

  const refreshServerFiles = useCallback(async () => {
    try {
      const r = await listCsvFiles()
      setServerFiles(r.files)
    } catch {
      /* the folder may not exist yet — leave the list empty */
    }
  }, [])

  useEffect(() => {
    void refreshServerFiles()
  }, [refreshServerFiles])

  /** After importing a raw CSV, offer to keep an encrypted copy in the folder. */
  async function offerEncryptToFolder(file: File) {
    const pw = await prompt({
      title: 'Encrypt for future use?',
      message: `Save an encrypted copy of "${file.name}" to your CSV folder so you can reuse it later? Enter a master password, or cancel to skip.`,
      password: true,
      confirmLabel: 'Encrypt & save',
    })
    if (pw === null) return // skipped — keep using the loaded plaintext
    if (!pw) {
      notify('Master password is required to encrypt.')
      return
    }
    try {
      const { filename } = await encryptCsvToFolder(file, pw)
      await refreshServerFiles()
      // Encryption succeeded — delete the plaintext original from disk so the
      // cleartext copy doesn't linger. The loaded CSV stays in memory (we don't
      // touch source.file), so the operator keeps working without re-entering
      // the password. Only possible in the desktop build, where we can resolve
      // the picked file's real path.
      const diskPath = window.electron?.filePath?.(file)
      let deleted = false
      if (diskPath && /\.csv$/i.test(diskPath)) {
        try {
          await deleteCsvFile(diskPath)
          deleted = true
        } catch {
          // Non-fatal — the encrypted copy is saved regardless.
        }
      }
      notify(
        `Saved encrypted copy "${filename}" to your CSV folder.` +
          (deleted ? ' Removed the plaintext original.' : ''),
        'ok',
      )
    } catch (e) {
      notify(errMsg(e))
    }
  }

  async function loadServerFile(name: string) {
    notify(null)
    const info = serverFiles.find((f) => f.name === name)
    if (!info) return
    try {
      if (info.encrypted) {
        const pw = await prompt({
          title: 'Decrypt CSV',
          message: `"${name}" is encrypted. Enter the master password:`,
          password: true,
          confirmLabel: 'Decrypt',
        })
        if (pw === null) return
        const { csv, filename } = await decryptServerCsv(name, pw)
        onChange({ ...source, file: { name: filename, text: csv, fromEncrypted: true }, excluded: [] })
      } else {
        const { csv, filename } = await getServerCsv(name)
        onChange({ ...source, file: { name: filename, text: csv, fromEncrypted: false }, excluded: [] })
      }
    } catch (e) {
      notify(errMsg(e))
    }
  }

  // Live preview parsed from the loaded CSV text.
  const preview = useMemo(() => {
    if (!source.file) return null
    try {
      return {
        ok: true as const,
        ...buildCanonicalKeepass(source.file.text, {
          overrides: source.overrides,
          useLogin: source.useLogin,
        }),
      }
    } catch (e) {
      return { ok: false as const, error: errMsg(e) }
    }
  }, [source.file, source.overrides, source.useLogin])

  async function onFile(file: File | null) {
    notify(null)
    if (!file) {
      onChange({ ...source, file: null, excluded: [] })
      return
    }
    // Encrypted input: prompt for the master password and decrypt in place.
    if (/\.enc$/i.test(file.name)) {
      const pw = await prompt({
        title: 'Decrypt CSV',
        message: `"${file.name}" looks encrypted. Enter the master password:`,
        password: true,
        confirmLabel: 'Decrypt',
      })
      if (pw === null) return
      try {
        const { csv, filename } = await decryptCsv(file, pw)
        onChange({ ...source, file: { name: filename, text: csv, fromEncrypted: true }, excluded: [] })
      } catch (e) {
        notify(errMsg(e))
      }
      return
    }
    try {
      const text = await readFileText(file)
      onChange({ ...source, file: { name: file.name, text, fromEncrypted: false }, excluded: [] })
      // A raw plaintext CSV — offer to keep an encrypted copy for next time.
      await offerEncryptToFolder(file)
    } catch (e) {
      notify(errMsg(e))
    }
  }

  async function removeFile() {
    // Only confirm for plaintext CSVs — an .enc-sourced load has no plaintext
    // passwords sitting around, so clearing it is low-stakes.
    if (source.file && !source.file.fromEncrypted) {
      const ok = await prompt({
        title: 'Remove CSV',
        message: 'Remove the loaded plaintext CSV? This clears its passwords from the app.',
        confirm: true,
        confirmLabel: 'Remove',
      })
      if (ok === null) return
    }
    onChange({ ...source, file: null })
    notify(null)
  }

  const folderEmpty = serverFiles.length === 0

  return (
    <div className="src-pane">
      <div className="src-row">
        <select
          className="src-serverpick"
          value=""
          disabled={folderEmpty}
          onChange={(e) => {
            const v = e.target.value
            e.target.value = ''
            if (v) void loadServerFile(v)
          }}
        >
          <option value="">{folderEmpty ? 'Folder is empty… Import a file…' : 'Import from csv folder…'}</option>
          {serverFiles.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
              {f.encrypted ? ' 🔒' : ''}
            </option>
          ))}
        </select>
        <label className="src-filebtn">
          {/* clear on click so re-picking the SAME file (e.g. after a wrong
              decrypt password) still fires onChange */}
          <input
            type="file"
            accept=".csv,.enc,text/csv"
            onClick={(e) => {
              ;(e.target as HTMLInputElement).value = ''
            }}
            onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
          />
          Import your own…
        </label>
        <span className="src-filename">
          {source.file ? source.file.name : 'No file selected'}
          {source.file?.fromEncrypted && <span className="src-badge">decrypted</span>}
        </span>
        {source.file && (
          <button type="button" className="src-remove" title="Remove loaded file" onClick={() => void removeFile()}>
            ✕
          </button>
        )}
        <CsvToolsMenu source={source} onChange={onChange} onChanged={refreshServerFiles} />
      </div>

      {preview && !preview.ok && <div className="src-notice src-notice--error">{preview.error}</div>}
      {preview && preview.ok && (
        <HostChecklist
          entries={preview.entries}
          excluded={source.excluded}
          onChange={(excluded) => onChange({ ...source, excluded })}
          skipped={preview.skipped}
          columns={preview.detectedColumns}
        />
      )}
    </div>
  )
}

function ColInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <label className="src-col">
      <span>{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </label>
  )
}

// --------------------------------------------------------------------------
// CSV tools cog — encrypt / decrypt / open the CSV library folder
// --------------------------------------------------------------------------
function CsvToolsMenu({
  source,
  onChange,
  onChanged,
}: {
  source: CompoundSource
  onChange: (s: SourceState) => void
  onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showMapping, setShowMapping] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const prompt = usePrompt()
  const toast = useToast()
  const onNotice: Notify = (text, kind = 'error') => toast(text, kind)
  const cog = useRef<HTMLButtonElement>(null)
  const encInput = useRef<HTMLInputElement>(null)
  const decInput = useRef<HTMLInputElement>(null)

  function openMenu() {
    const r = cog.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) })
    setOpen(true)
  }

  // The menu is portaled to <body>; close it on scroll/resize so it never
  // floats out of place relative to the cog.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // Encrypt a chosen plaintext CSV and save the .enc into the library folder.
  async function encryptPick(file: File) {
    const pw = await prompt({
      title: 'Encrypt a CSV',
      message: `Set a master password to encrypt "${file.name}" and save it to your CSV folder:`,
      password: true,
      confirmLabel: 'Encrypt & save',
    })
    if (pw === null) return
    if (!pw) {
      onNotice('Master password is required.')
      return
    }
    setBusy(true)
    onNotice(null)
    try {
      const { filename } = await encryptCsvToFolder(file, pw)
      await onChanged()
      onNotice(`Encrypted and saved "${filename}" to your CSV folder.`, 'ok')
    } catch (e) {
      onNotice(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  // Decrypt a chosen .enc and download the plaintext CSV.
  async function decryptPick(file: File) {
    const pw = await prompt({
      title: 'Decrypt a CSV',
      message: `Enter the master password for "${file.name}":`,
      password: true,
      confirmLabel: 'Decrypt',
    })
    if (pw === null) return
    if (!pw) {
      onNotice('Master password is required.')
      return
    }
    setBusy(true)
    onNotice(null)
    try {
      const { csv, filename } = await decryptCsv(file, pw)
      const base = (filename || file.name).replace(/\.enc$/i, '').replace(/\.csv$/i, '')
      downloadBlob(new Blob([csv], { type: 'text/csv' }), `${base}.csv`)
      onNotice(`Decrypted "${file.name}" — downloaded ${base}.csv.`, 'ok')
    } catch (e) {
      onNotice(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function onOpenFolder() {
    setOpen(false)
    try {
      await openFolder('csv')
    } catch (e) {
      onNotice(errMsg(e))
    }
  }

  return (
    <span className="src-tools">
      <button
        ref={cog}
        type="button"
        className="src-cog"
        title="CSV tools"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        ⚙
      </button>
      {open && pos &&
        createPortal(
          <>
            <div className="src-tools__backdrop" onClick={() => setOpen(false)} />
            <div className="src-tools__menu" role="menu" style={{ top: pos.top, right: pos.right }}>
              <button type="button" role="menuitem" onClick={() => { setOpen(false); setShowMapping(true) }}>
                Column mapping & options…
              </button>
              <button type="button" role="menuitem" onClick={() => { setOpen(false); encInput.current?.click() }}>
                Encrypt a CSV…
              </button>
              <button type="button" role="menuitem" onClick={() => { setOpen(false); decInput.current?.click() }}>
                Decrypt a CSV…
              </button>
              <button type="button" role="menuitem" onClick={onOpenFolder}>
                Open CSV folder
              </button>
            </div>
          </>,
          document.body,
        )}
      <input
        ref={encInput}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void encryptPick(f)
        }}
      />
      <input
        ref={decInput}
        type="file"
        accept=".enc"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void decryptPick(f)
        }}
      />
      {showMapping && (
        <ColumnMappingModal source={source} onChange={onChange} onClose={() => setShowMapping(false)} />
      )}
    </span>
  )
}

// --------------------------------------------------------------------------
// Column mapping & options — modal launched from the CSV-tools cog
// --------------------------------------------------------------------------
function ColumnMappingModal({
  source,
  onChange,
  onClose,
}: {
  source: CompoundSource
  onChange: (s: SourceState) => void
  onClose: () => void
}) {
  const setOverride = (key: keyof CompoundSource['overrides'], v: string) =>
    onChange({ ...source, overrides: { ...source.overrides, [key]: v } })

  return createPortal(
    <div className="prompt__overlay" onMouseDown={onClose}>
      <div className="prompt__box src-mapmodal" onMouseDown={(e) => e.stopPropagation()}>
        <h3 className="prompt__title">Column mapping & options</h3>
        <p className="prompt__msg">
          Map your CSV's column headers to each field. Leave a box empty to use its default (shown as
          placeholder — KeePass export names).
        </p>
        <div className="src-mapping">
          <ColInput
            label="URL column"
            value={source.overrides.website ?? ''}
            onChange={(v) => setOverride('website', v)}
            placeholder="Web Site"
          />
          <ColInput
            label="Password column"
            value={source.overrides.password ?? ''}
            onChange={(v) => setOverride('password', v)}
            placeholder="Password"
          />
          <ColInput
            label="Login Name column"
            value={source.overrides.loginName ?? ''}
            onChange={(v) => setOverride('loginName', v)}
            placeholder="Login Name"
          />
          <ColInput
            label="Title column"
            value={source.overrides.account ?? ''}
            onChange={(v) => setOverride('account', v)}
            placeholder="Account"
          />
        </div>
        <label className="src-check">
          <input
            type="checkbox"
            checked={source.useLogin}
            onChange={(e) => onChange({ ...source, useLogin: e.target.checked })}
          />
          Use Login Name column as the SSH user (overrides user@ in the URL)
        </label>
        <div className="prompt__actions">
          <button type="button" className="prompt__btn prompt__btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// --------------------------------------------------------------------------
// Manual entry
// --------------------------------------------------------------------------
/** 'empty' | 'valid' | 'invalid' for a manually-typed SSH URL / host / IP. */
function manualUrlState(url: string): 'empty' | 'valid' | 'invalid' {
  const u = url.trim()
  if (!u) return 'empty'
  const norm = normaliseSshTarget(u)
  if (!norm) return 'invalid'
  const label = canonicalLabel(norm) // ssh://user@host:port, or '' if unparseable
  if (!label) return 'invalid'
  // Sanity-check the host is a plausible hostname or IPv4 (not exotic chars).
  const host = /^ssh:\/\/[^@]+@([^:]+):\d+$/.exec(label)?.[1] ?? ''
  return /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/i.test(host) ? 'valid' : 'invalid'
}

function ManualEditor({
  source,
  onChange,
}: {
  source: ManualSource
  onChange: (s: SourceState) => void
}) {
  function update(i: number, patch: Partial<ManualSource['rows'][number]>) {
    const rows = source.rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r))
    onChange({ ...source, rows })
  }
  function add() {
    onChange({ ...source, rows: [...source.rows, { url: '', user: '', password: '' }] })
  }
  function remove(i: number) {
    const rows = source.rows.filter((_, idx) => idx !== i)
    onChange({ ...source, rows: rows.length ? rows : [{ url: '', user: '', password: '' }] })
  }

  const invalidCount = source.rows.filter((r) => manualUrlState(r.url) === 'invalid').length

  return (
    <div className="src-pane">
      {source.rows.map((row, i) => {
        const urlState = manualUrlState(row.url)
        return (
          <div className="src-manualrow" key={i}>
            <input
              type="text"
              className={`src-manualrow__url${urlState === 'invalid' ? ' is-invalid' : ''}`}
              placeholder="ssh://root@host.example  or  10.0.0.5"
              value={row.url}
              onChange={(e) => update(i, { url: e.target.value })}
              spellCheck={false}
              aria-invalid={urlState === 'invalid'}
              title={urlState === 'invalid' ? 'Not a valid SSH URL, host, or IP' : undefined}
            />
            <input
              type="text"
              className="src-manualrow__user"
              placeholder="root"
              value={row.user}
              onChange={(e) => update(i, { user: e.target.value })}
              spellCheck={false}
            />
            <input
              type="password"
              className="src-manualrow__pw"
              placeholder="password"
              autoComplete="off"
              value={row.password}
              onChange={(e) => update(i, { password: e.target.value })}
            />
            <button type="button" className="src-manualrow__del" onClick={() => remove(i)} title="Remove row">
              ✕
            </button>
          </div>
        )
      })}
      <button type="button" className="src-addrow" onClick={add}>
        + Add host
      </button>
      {invalidCount > 0 && (
        <div className="src-manual-hint">
          ⚠ {invalidCount} {invalidCount === 1 ? 'entry isn’t' : 'entries aren’t'} a valid SSH URL,
          host, or IP — use <code>ssh://root@host</code>, <code>host.example.com</code>, or{' '}
          <code>10.0.0.5</code>.
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// Test Host
// --------------------------------------------------------------------------
function TestEditor({ testHost }: { testHost: string | null }) {
  return (
    <div className="src-pane">
      <p className="src-hint">Run actions on the test phone system (Debian) only:</p>
      <code className="src-testhost">{testHost ?? '(loading…)'}</code>
    </div>
  )
}

// --------------------------------------------------------------------------
// Host checklist — pick which systems changes are applied to
// --------------------------------------------------------------------------
function HostChecklist({
  entries,
  excluded,
  onChange,
  skipped,
  columns,
}: {
  entries: HostEntry[]
  excluded: string[]
  onChange: (excluded: string[]) => void
  skipped: number
  columns: string[]
}) {
  const exSet = new Set(excluded)
  const selectedCount = entries.reduce((n, e) => (exSet.has(e.label) ? n : n + 1), 0)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const filtered = q
    ? entries.filter((e) => e.name.toLowerCase().includes(q) || e.url.toLowerCase().includes(q))
    : entries

  function toggle(label: string) {
    const s = new Set(exSet)
    if (s.has(label)) s.delete(label)
    else s.add(label)
    onChange([...s])
  }
  // Select/Deselect act on the currently-filtered hosts.
  function selectFiltered() {
    const s = new Set(exSet)
    for (const e of filtered) s.delete(e.label)
    onChange([...s])
  }
  function deselectFiltered() {
    const s = new Set(exSet)
    for (const e of filtered) s.add(e.label)
    onChange([...s])
  }

  return (
    <div className="src-checklist">
      <div className="src-checklist__head">
        <span className={selectedCount ? 'is-ok' : 'is-warn'}>
          {selectedCount} of {entries.length} selected
        </span>
        <span className="src-checklist__actions">
          <input
            type="text"
            className="src-checklist__search"
            placeholder="Search hosts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          <button type="button" className="src-link" onClick={selectFiltered}>
            Select all
          </button>
          <button type="button" className="src-link" onClick={deselectFiltered}>
            Deselect all
          </button>
        </span>
      </div>
      <ul className="src-checklist__list">
        {filtered.map((e) => {
          const host = e.url.replace(/^ssh:\/\/[^@]+@/, '').replace(/:\d+$/, '')
          return (
            <li key={e.label}>
              <label>
                <input type="checkbox" checked={!exSet.has(e.label)} onChange={() => toggle(e.label)} />
                <span className="src-preview__name">{e.name}</span>
                <span className="src-preview__host">→ {host}</span>
              </label>
            </li>
          )
        })}
        {filtered.length === 0 && <li className="src-checklist__none">No hosts match “{query}”.</li>}
      </ul>
      {columns.length > 0 && (
        <div className="src-preview__cols">
          Detected columns: <span>{columns.join(', ')}</span>
        </div>
      )}
      {skipped > 0 && <div className="src-preview__skip">{skipped} row(s) skipped (empty/unparseable URL)</div>}
    </div>
  )
}
