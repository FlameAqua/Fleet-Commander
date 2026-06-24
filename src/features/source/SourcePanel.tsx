import { useEffect, useMemo, useState } from 'react'
import { usePrompt } from '../../components/PromptProvider'
import {
  ApiError,
  decryptCsv,
  decryptServerCsv,
  encryptCsv,
  getServerCsv,
  listCsvFiles,
  type CsvFileInfo,
} from '../../api'
import { buildCanonicalKeepass, type HostEntry } from '../../lib/csv'
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
  const [notice, setNotice] = useState<string | null>(null)
  const [showMapping, setShowMapping] = useState(false)
  const [serverFiles, setServerFiles] = useState<CsvFileInfo[]>([])
  const prompt = usePrompt()

  useEffect(() => {
    let cancelled = false
    listCsvFiles()
      .then((r) => !cancelled && setServerFiles(r.files))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  async function loadServerFile(name: string) {
    setNotice(null)
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
      setNotice(errMsg(e))
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
    setNotice(null)
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
        setNotice(errMsg(e))
      }
      return
    }
    try {
      const text = await readFileText(file)
      onChange({ ...source, file: { name: file.name, text, fromEncrypted: false }, excluded: [] })
    } catch (e) {
      setNotice(errMsg(e))
    }
  }

  function removeFile() {
    // Only confirm for plaintext CSVs — an .enc-sourced load has no plaintext
    // passwords sitting around, so clearing it is low-stakes.
    if (source.file && !source.file.fromEncrypted) {
      if (!window.confirm('Remove the loaded plaintext CSV (clears its passwords from the app)?')) return
    }
    onChange({ ...source, file: null })
    setNotice(null)
  }

  return (
    <div className="src-pane">
      <div className="src-row">
        {serverFiles.length > 0 && (
          <select
            className="src-serverpick"
            value=""
            onChange={(e) => {
              const v = e.target.value
              e.target.value = ''
              if (v) void loadServerFile(v)
            }}
          >
            <option value="">Import from csv folder…</option>
            {serverFiles.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
                {f.encrypted ? ' 🔒' : ''}
              </option>
            ))}
          </select>
        )}
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
          {serverFiles.length > 0 ? 'Import your own…' : 'Choose CSV / .enc…'}
        </label>
        <span className="src-filename">
          {source.file ? source.file.name : 'No file selected'}
          {source.file?.fromEncrypted && <span className="src-badge">decrypted</span>}
        </span>
        {source.file && (
          <button type="button" className="src-remove" title="Remove loaded file" onClick={removeFile}>
            ✕
          </button>
        )}
        <EncryptControl onNotice={setNotice} />
      </div>

      <button type="button" className="src-link" onClick={() => setShowMapping((v) => !v)}>
        {showMapping ? '▾' : '▸'} Column mapping & options
      </button>
      {showMapping && (
        <div className="src-mapping">
          <ColInput
            label="URL column"
            value={source.overrides.website ?? ''}
            onChange={(v) => onChange({ ...source, overrides: { ...source.overrides, website: v } })}
            placeholder="Web Site"
          />
          <ColInput
            label="Password column"
            value={source.overrides.password ?? ''}
            onChange={(v) => onChange({ ...source, overrides: { ...source.overrides, password: v } })}
            placeholder="Password"
          />
          <ColInput
            label="Login Name column"
            value={source.overrides.loginName ?? ''}
            onChange={(v) =>
              onChange({ ...source, overrides: { ...source.overrides, loginName: v } })
            }
            placeholder="Login Name"
          />
          <ColInput
            label="Account column"
            value={source.overrides.account ?? ''}
            onChange={(v) => onChange({ ...source, overrides: { ...source.overrides, account: v } })}
            placeholder="Account"
          />
          <label className="src-check">
            <input
              type="checkbox"
              checked={source.useLogin}
              onChange={(e) => onChange({ ...source, useLogin: e.target.checked })}
            />
            Use Login Name column as the SSH user (overrides user@ in the URL)
          </label>
        </div>
      )}

      {notice && <div className="src-notice src-notice--error">{notice}</div>}

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
// Decrypt (.enc → CSV) + Encrypt utility
// --------------------------------------------------------------------------
/** Utility: encrypt a plaintext CSV into the `.enc` format and download it. */
function EncryptControl({ onNotice }: { onNotice: (msg: string | null) => void }) {
  const [busy, setBusy] = useState(false)
  const prompt = usePrompt()

  async function encrypt(file: File) {
    const pw = await prompt({
      title: 'Encrypt CSV',
      message: `Set a master password to encrypt ${file.name}:`,
      password: true,
      confirmLabel: 'Encrypt',
    })
    if (pw === null) return
    if (!pw) {
      onNotice('Master password is required.')
      return
    }
    setBusy(true)
    onNotice(null)
    try {
      const { blob, filename } = await encryptCsv(file, pw)
      downloadBlob(blob, filename)
    } catch (e) {
      onNotice(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="src-encdec">
      <label className="src-link" aria-disabled={busy}>
        <input
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void encrypt(f)
            e.target.value = ''
          }}
        />
        Encrypt a CSV…
      </label>
    </span>
  )
}

// --------------------------------------------------------------------------
// Manual entry
// --------------------------------------------------------------------------
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

  return (
    <div className="src-pane">
      {source.rows.map((row, i) => (
        <div className="src-manualrow" key={i}>
          <input
            type="text"
            className="src-manualrow__url"
            placeholder="ssh://root@host.example  or  10.0.0.5"
            value={row.url}
            onChange={(e) => update(i, { url: e.target.value })}
            spellCheck={false}
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
      ))}
      <button type="button" className="src-addrow" onClick={add}>
        + Add host
      </button>
    </div>
  )
}

// --------------------------------------------------------------------------
// Test Host
// --------------------------------------------------------------------------
function TestEditor({ testHost }: { testHost: string | null }) {
  return (
    <div className="src-pane">
      <p>Runs against the single safe test target:</p>
      <code className="src-testhost">{testHost ?? '(loading…)'}</code>
      <p className="src-hint">You'll be prompted for the host password when you start a run.</p>
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
