import { useEffect, useMemo } from 'react'
import { ScriptsPanel } from '../scripts/ScriptsPanel'
import { Segmented } from '../../components/Segmented'
import { ScriptEditor } from '../../components/LazyScriptEditor'
import { useTip } from '../../components/ToastProvider'
import { readFileText } from '../../lib/file'
import { lintScript, normaliseScript } from './scriptLint'
import type { CustomScriptArgs, RootMode, ScriptInterpreter } from './deployForm'
import './run.css'

const EXIT_CODE_TIP = 'Use Exit Code 2 as a planned failure (e.g. a failed audit). Add more custom codes in the settings!'

export type ScriptSource = 'library' | 'paste' | 'upload'

export interface CustomScriptState {
  source: ScriptSource
  library: { name: string; content: string }
  paste: string
  upload: { name: string; content: string }
  interpreter: ScriptInterpreter
  rootMode: RootMode
  rootPassword: string
  rootColumn: string
}

export function emptyCustomScript(): CustomScriptState {
  return {
    source: 'paste',
    library: { name: '', content: '' },
    paste: '',
    upload: { name: '', content: '' },
    interpreter: 'auto',
    rootMode: 'none',
    rootPassword: '',
    rootColumn: '',
  }
}

/** Resolve the script-to-run from the active sub-mode, or null if none. */
export function resolveCustomScript(cs: CustomScriptState): CustomScriptArgs | null {
  const root = {
    rootMode: cs.rootMode,
    rootPassword: cs.rootPassword,
    rootColumn: cs.rootColumn,
    interpreter: cs.interpreter,
  }
  // normaliseScript(): a CRLF script silently fails on the target (the shebang
  // parses as bash-plus-CR and every value picks up a trailing CR), and scripts get
  // authored on Windows here, so strip them on the way out.
  if (cs.source === 'library') {
    return cs.library.content.trim()
      ? { content: normaliseScript(cs.library.content), filename: cs.library.name || 'library-script.sh', ...root }
      : null
  }
  if (cs.source === 'paste') {
    return cs.paste.trim()
      ? { content: normaliseScript(cs.paste), filename: 'pasted-script.sh', ...root }
      : null
  }
  return cs.upload.content.trim()
    ? { content: normaliseScript(cs.upload.content), filename: cs.upload.name || 'uploaded-script.sh', ...root }
    : null
}

const SOURCES: { id: ScriptSource; label: string }[] = [
  { id: 'paste', label: 'Write your own' },
  { id: 'library', label: 'Use from Library' },
  { id: 'upload', label: 'Import Script' },
]

interface Props {
  value: CustomScriptState
  onChange: (v: CustomScriptState) => void
  /** Per-system variables from the loaded Compound CSV (for `$` autocomplete). */
  variables: string[]
  /**
   * Raw CSV header names. Distinct from `variables`: the backend matches the
   * root-password column against the untouched header, not the $var form.
   */
  columns: string[]
  /** True when the source is an imported CSV — enables the per-host root column. */
  csvAvailable: boolean
}

export function CustomScriptPanel({ value, onChange, variables, columns, csvAvailable }: Props) {
  const set = (patch: Partial<CustomScriptState>) => onChange({ ...value, ...patch })
  const tip = useTip()
  const showExitTip = () => tip('exit-codes', EXIT_CODE_TIP)
  // Pre-flight checks on whichever script is actually selected.
  const active =
    value.source === 'library' ? value.library.content : value.source === 'paste' ? value.paste : value.upload.content
  const findings = useMemo(() => lintScript(active, value.interpreter), [active, value.interpreter])

  // The "root password from a CSV column" mode only makes sense with an
  // imported CSV. If the source changes away from CSV while it's selected,
  // fall back to the current SSH user.
  useEffect(() => {
    if (!csvAvailable && value.rootMode === 'csv') set({ rootMode: 'none' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csvAvailable, value.rootMode])

  async function onUpload(file: File | null) {
    if (!file) {
      set({ upload: { name: '', content: '' } })
      return
    }
    const content = await readFileText(file)
    set({ upload: { name: file.name, content } })
  }

  return (
    <div className="cs">
      <Segmented options={SOURCES} value={value.source} onChange={(s) => set({ source: s })} ariaLabel="Script source" />

      {value.source === 'library' && (
        <ScriptsPanel
          onActiveChange={(name, content) => set({ library: { name, content } })}
          variables={variables}
          interpreter={value.interpreter}
          onInterpreterChange={(i) => set({ interpreter: i })}
        />
      )}

      {value.source === 'paste' && (
        <ScriptEditor
          value={value.paste}
          onChange={(v) => set({ paste: v })}
          variables={variables}
          interpreter={value.interpreter}
          onInterpreterChange={(i) => set({ interpreter: i })}
          onFocus={showExitTip}
        />
      )}

      {value.source === 'upload' && (
        <div className="cs__upload">
          <label className="src-filebtn">
            <input type="file" accept=".sh,text/x-sh,text/plain" onChange={(e) => void onUpload(e.target.files?.[0] ?? null)} />
            Choose .sh file…
          </label>
          <span className="src-filename">{value.upload.name || 'No file selected'}</span>
        </div>
      )}

      {findings.length > 0 && (
        <ul className="cs__lint">
          {findings.map((f, i) => (
            <li key={i} className={`cs__lint--${f.level}`}>
              <span className="cs__linticon" aria-hidden="true">
                {f.level === 'danger' ? '⛔' : f.level === 'warn' ? '⚠' : 'ℹ'}
              </span>
              {f.line != null && <code className="cs__lintline">line {f.line}</code>}
              <span>{f.message}</span>
            </li>
          ))}
        </ul>
      )}

      {value.interpreter === 'routeros' ? (
        <p className="run__note">
          Commands are sent straight to the RouterOS console (e.g. <code>/system resource print</code>).
          POSIX features — <code>su</code> escalation and <code>$variable</code> injection — don’t apply on
          RouterOS.
        </p>
      ) : (
        <fieldset className="cs__root">
          <legend>Run as</legend>
          <label className="cs__radio">
            <input
              type="radio"
              name="cs-root"
              checked={value.rootMode === 'none'}
              onChange={() => set({ rootMode: 'none' })}
            />
            Current SSH user
          </label>
        <label className="cs__radio">
          <input
            type="radio"
            name="cs-root"
            checked={value.rootMode === 'inline'}
            onChange={() => set({ rootMode: 'inline' })}
          />
          Root (input same root password for all hosts)
        </label>
        {value.rootMode === 'inline' && (
          <input
            className="cs__rootinput"
            type="password"
            autoComplete="off"
            placeholder="root password"
            value={value.rootPassword}
            onChange={(e) => set({ rootPassword: e.target.value })}
          />
        )}
        {csvAvailable && (
          <>
            <label className="cs__radio">
              <input
                type="radio"
                name="cs-root"
                checked={value.rootMode === 'csv'}
                onChange={() => set({ rootMode: 'csv' })}
              />
              Root (take root password from a CSV column)
            </label>
            {value.rootMode === 'csv' &&
              (columns.length ? (
                <select
                  className="cs__rootinput"
                  value={value.rootColumn}
                  onChange={(e) => set({ rootColumn: e.target.value })}
                  aria-label="CSV column holding the root password"
                >
                  <option value="">Choose a column…</option>
                  {columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  {/* A column remembered from a previous CSV that this one lacks —
                      keep it visible rather than silently switching selection. */}
                  {value.rootColumn && !columns.includes(value.rootColumn) && (
                    <option value={value.rootColumn}>{value.rootColumn} (not in this CSV)</option>
                  )}
                </select>
              ) : (
                <input
                  className="cs__rootinput"
                  type="text"
                  placeholder="CSV column to read from"
                  value={value.rootColumn}
                  onChange={(e) => set({ rootColumn: e.target.value })}
                  spellCheck={false}
                />
              ))}
          </>
        )}
          <p className="run__note">
            Escalation uses <code>su</code> with the root password (no sudoers needed). The password is held in
            memory only.
          </p>
        </fieldset>
      )}
    </div>
  )
}
