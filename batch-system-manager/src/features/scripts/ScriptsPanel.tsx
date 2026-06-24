import { useEffect, useRef, useState } from 'react'
import { ScriptEditor } from '../../components/ScriptEditor'
import {
  ApiError,
  deleteScript,
  getScript,
  listScripts,
  pickScriptsDir,
  saveScript,
  type ScriptInfo,
} from '../../api'
import { useScriptsDir } from './useScriptsDir'
import './scripts.css'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatModified(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString()
}

type Notice = { kind: 'info' | 'error'; text: string } | null

interface ScriptsPanelProps {
  /** Reports the currently-open script (name + editor content) — used by the
   *  Custom Script action to pick which script to run. */
  onActiveChange?: (name: string, content: string) => void
  /** Per-system variables from the loaded Compound CSV (for `$` autocomplete). */
  variables?: string[]
}

export function ScriptsPanel({ onActiveChange, variables = [] }: ScriptsPanelProps = {}) {
  const { dir, setDir } = useScriptsDir()

  const [scripts, setScripts] = useState<ScriptInfo[]>([])
  const [resolvedDir, setResolvedDir] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  // Editor state. `selected` is the name currently open (null = new script).
  const [selected, setSelected] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)

  // Surface the active script to a parent (Custom Script run target) whenever
  // the editor's name/content changes. Via a ref so a changing callback
  // identity doesn't re-fire the effect.
  const onActiveRef = useRef(onActiveChange)
  onActiveRef.current = onActiveChange
  useEffect(() => {
    onActiveRef.current?.(nameInput, content)
  }, [nameInput, content])

  function reportError(err: unknown) {
    const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err)
    setNotice({ kind: 'error', text: msg })
  }

  async function refresh() {
    setLoading(true)
    setNotice(null)
    try {
      const res = await listScripts(dir)
      setScripts(res.scripts)
      setResolvedDir(res.dir)
    } catch (err) {
      reportError(err)
      setScripts([])
    } finally {
      setLoading(false)
    }
  }

  // Reload whenever the active directory changes (and on mount).
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir])

  async function openScript(name: string) {
    setBusy(true)
    setNotice(null)
    try {
      const res = await getScript(name, dir)
      setSelected(name)
      setNameInput(res.name)
      setContent(res.content)
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(false)
    }
  }

  function newScript() {
    setSelected(null)
    setNameInput('')
    setContent('')
    setNotice(null)
  }

  async function save() {
    if (!content.trim()) {
      setNotice({ kind: 'error', text: 'Script content is empty.' })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const info = await saveScript(nameInput, content, dir)
      setSelected(info.name)
      setNameInput(info.name)
      setNotice({ kind: 'info', text: `Saved ${info.name} (${formatBytes(info.size)}).` })
      await refresh()
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(false)
    }
  }

  async function remove(name: string) {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return
    setBusy(true)
    setNotice(null)
    try {
      await deleteScript(name, dir)
      if (selected === name) newScript()
      setNotice({ kind: 'info', text: `Deleted ${name}.` })
      await refresh()
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(false)
    }
  }

  async function chooseDir() {
    setNotice(null)
    try {
      const path = await pickScriptsDir()
      if (path) setDir(path) // refresh() runs via the dir effect
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <section className="scripts">
      <header className="scripts__header">
        <h2>Script library</h2>
        <div className="scripts__dirbar">
          <span className="scripts__dirlabel">Folder:</span>
          <code className="scripts__dir" title={resolvedDir}>
            {dir ? resolvedDir || dir : '(default)'}
          </code>
          <button type="button" onClick={chooseDir} disabled={busy}>
            Choose folder…
          </button>
          {dir && (
            <button type="button" onClick={() => setDir('')} disabled={busy}>
              Reset to default
            </button>
          )}
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            Refresh
          </button>
        </div>
      </header>

      {notice && <div className={`scripts__notice scripts__notice--${notice.kind}`}>{notice.text}</div>}

      <div className="scripts__body">
        <aside className="scripts__list">
          <div className="scripts__list-head">
            <span>{loading ? 'Loading…' : `${scripts.length} script${scripts.length === 1 ? '' : 's'}`}</span>
            <button type="button" onClick={newScript} disabled={busy}>
              + New
            </button>
          </div>
          <ul>
            {scripts.map((s) => (
              <li key={s.name} className={s.name === selected ? 'is-selected' : ''}>
                <button type="button" className="scripts__item" onClick={() => void openScript(s.name)} disabled={busy}>
                  <span className="scripts__item-name">{s.name}</span>
                  <span className="scripts__item-meta">
                    {formatBytes(s.size)} · {formatModified(s.modified)}
                  </span>
                </button>
                <button
                  type="button"
                  className="scripts__del"
                  title={`Delete ${s.name}`}
                  onClick={() => void remove(s.name)}
                  disabled={busy}
                >
                  ✕
                </button>
              </li>
            ))}
            {!loading && scripts.length === 0 && <li className="scripts__empty">No scripts yet.</li>}
          </ul>
        </aside>

        <div className="scripts__editor">
          <div className="scripts__editor-head">
            <input
              type="text"
              placeholder="script-name.sh"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              spellCheck={false}
            />
            <button type="button" className="scripts__save" onClick={() => void save()} disabled={busy}>
              {selected ? 'Save' : 'Create'}
            </button>
          </div>
          <p className="scripts__hint">
            Names: letters, digits, dots, dashes, underscores (max 80). <code>.sh</code> is appended automatically.
          </p>
          <ScriptEditor
            value={content}
            onChange={setContent}
            variables={variables}
            placeholder={'#!/bin/bash\nset -e\necho "Hello from $(hostname)"'}
          />
        </div>
      </div>
    </section>
  )
}
