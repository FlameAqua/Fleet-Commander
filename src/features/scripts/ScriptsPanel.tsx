import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ScriptEditor } from '../../components/LazyScriptEditor'
import { usePrompt } from '../../components/PromptProvider'
import { useToast } from '../../components/ToastProvider'
import {
  errMsg,
  createScriptCategory,
  deleteScript,
  deleteScriptCategory,
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

/** Label shown for the default (root) category. */
const DEFAULT_CAT_LABEL = 'General'
/** Sentinel used in the list filter <select> for "all categories". */
const ALL_CATS = ' all'
/** Sentinel used in the category <select>s for the "create new" option. */
const NEW_CAT = ' new'

function catLabel(cat: string): string {
  return cat || DEFAULT_CAT_LABEL
}

interface ScriptsPanelProps {
  /** Reports the currently-open script (name + editor content) — used by the
   *  Custom Script action to pick which script to run. */
  onActiveChange?: (name: string, content: string) => void
  /** Per-system variables from the loaded Compound CSV (for `$` autocomplete). */
  variables?: string[]
  /** Interpreter selector (cmd icon) — forwarded to the embedded editor. */
  interpreter?: 'auto' | 'routeros'
  onInterpreterChange?: (i: 'auto' | 'routeros') => void
}

export function ScriptsPanel({
  onActiveChange,
  variables = [],
  interpreter,
  onInterpreterChange,
}: ScriptsPanelProps = {}) {
  const { dir, setDir } = useScriptsDir()
  const prompt = usePrompt()
  const toast = useToast()

  const [scripts, setScripts] = useState<ScriptInfo[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [resolvedDir, setResolvedDir] = useState<string>('')
  const [loading, setLoading] = useState(false)
  // List filter: null = show every category.
  const [filterCat, setFilterCat] = useState<string | null>(null)

  // Editor state. `selected` is the open script's (name, category), null = a
  // fresh unsaved script. Name/category are only asked for on Create, via the
  // modal — the editor column itself is just the script box plus its actions.
  const [selected, setSelected] = useState<{ name: string; category: string } | null>(null)
  const [content, setContent] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [busy, setBusy] = useState(false)

  // Surface the active script to a parent (Custom Script run target) whenever
  // the open script or its content changes. Via a ref so a changing callback
  // identity doesn't re-fire the effect.
  const activeName = selected?.name ?? ''
  const onActiveRef = useRef(onActiveChange)
  onActiveRef.current = onActiveChange
  useEffect(() => {
    onActiveRef.current?.(activeName, content)
  }, [activeName, content])

  async function refresh() {
    setLoading(true)
    try {
      const res = await listScripts(dir)
      // Defensive against an older backend that predates categories.
      setScripts((res.scripts ?? []).map((s) => ({ ...s, category: s.category ?? '' })))
      setCategories(res.categories ?? [])
      setResolvedDir(res.dir)
    } catch (err) {
      toast(errMsg(err))
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

  async function openScript(name: string, cat: string) {
    setBusy(true)
    try {
      const res = await getScript(name, dir, cat)
      setSelected({ name: res.name, category: res.category ?? cat ?? '' })
      setContent(res.content)
    } catch (err) {
      toast(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  async function clearEditor() {
    // Guard against wiping unsaved work in the editor.
    if (content.trim()) {
      const ok = await prompt({
        title: 'Clear the editor?',
        message: 'Any unsaved changes to the current script will be lost.',
        confirm: true,
        confirmLabel: 'Discard & clear',
      })
      if (ok === null) return
    }
    setSelected(null)
    setContent('')
  }

  async function removeCategory(cat: string) {
    if (!cat) return // General can't be deleted
    const ok = await prompt({
      title: 'Delete category',
      message: `Delete the "${cat}" category? Its scripts move to ${DEFAULT_CAT_LABEL}; the folder is then removed.`,
      confirm: true,
      confirmLabel: 'Delete category',
    })
    if (ok === null) return
    setBusy(true)
    try {
      const moved = await deleteScriptCategory(cat, dir)
      if (filterCat === cat) setFilterCat(null)
      if (selected?.category === cat) setSelected({ name: selected.name, category: '' })
      toast(`Deleted "${cat}"${moved ? ` — moved ${moved} script${moved === 1 ? '' : 's'} to ${DEFAULT_CAT_LABEL}` : ''}.`, 'ok')
      await refresh()
    } catch (err) {
      toast(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  /** Write the editor to (name, category), creating `newCat` first if asked. */
  async function create(name: string, cat: string, newCat: string) {
    if (!content.trim()) {
      toast('Script content is empty.')
      return
    }
    setBusy(true)
    try {
      const target = cat === NEW_CAT ? await createScriptCategory(newCat.trim(), dir) : cat
      const info = await saveScript(name, content, dir, target)
      const savedCat = info.category ?? target
      setSelected({ name: info.name, category: savedCat })
      setShowCreate(false)
      toast(`Saved ${info.name} to ${catLabel(savedCat)} (${formatBytes(info.size)}).`, 'ok')
      await refresh()
    } catch (err) {
      toast(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  /** Write the editor back over the script it was opened from. */
  async function overwrite() {
    if (!selected) return
    if (!content.trim()) {
      toast('Script content is empty.')
      return
    }
    const ok = await prompt({
      title: 'Overwrite script',
      message: `This will overwrite the existing script "${selected.name}".`,
      confirm: true,
      confirmLabel: 'Overwrite',
    })
    if (ok === null) return
    setBusy(true)
    try {
      const info = await saveScript(selected.name, content, dir, selected.category)
      const savedCat = info.category ?? selected.category
      setSelected({ name: info.name, category: savedCat })
      toast(`Saved ${info.name} to ${catLabel(savedCat)} (${formatBytes(info.size)}).`, 'ok')
      await refresh()
    } catch (err) {
      toast(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove(name: string, cat: string) {
    const ok = await prompt({
      title: 'Delete script',
      message: `Delete "${name}" from ${catLabel(cat)}? This cannot be undone.`,
      confirm: true,
      confirmLabel: 'Delete',
    })
    if (ok === null) return
    setBusy(true)
    try {
      await deleteScript(name, dir, cat)
      if (selected && selected.name === name && selected.category === cat) {
        setSelected(null)
        setContent('')
      }
      toast(`Deleted ${name}.`, 'ok')
      await refresh()
    } catch (err) {
      toast(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  /** Prompt for a new category name, create it, and return it (or null). */
  async function promptNewCategory(): Promise<string | null> {
    const name = await prompt({
      title: 'New category',
      message: 'Name for the new category (a subfolder of your scripts folder):',
      confirmLabel: 'Create',
      placeholder: 'e.g. RouterOS',
    })
    if (name === null || !name.trim()) return null
    try {
      const created = await createScriptCategory(name.trim(), dir)
      await refresh()
      toast(`Created category "${created}".`, 'ok')
      return created
    } catch (err) {
      toast(errMsg(err))
      return null
    }
  }

  async function onFilterChange(next: string) {
    if (next === NEW_CAT) {
      const created = await promptNewCategory()
      if (created) setFilterCat(created)
      return
    }
    setFilterCat(next === ALL_CATS ? null : next)
  }

  async function chooseDir() {
    try {
      const path = await pickScriptsDir()
      if (path) setDir(path) // refresh() runs via the dir effect
    } catch (err) {
      toast(errMsg(err))
    }
  }

  const shown = filterCat === null ? scripts : scripts.filter((s) => s.category === filterCat)

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

      <div className="scripts__body">
        <aside className="scripts__list">
          <div className="scripts__list-head">
            <span>{loading ? 'Loading…' : `${shown.length} script${shown.length === 1 ? '' : 's'}`}</span>
            <select
              className="scripts__filter"
              value={filterCat === null ? ALL_CATS : filterCat}
              onChange={(e) => void onFilterChange(e.target.value)}
              disabled={busy}
              title="Filter by category"
            >
              <option value={ALL_CATS}>All categories</option>
              <option value="">{DEFAULT_CAT_LABEL}</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value={NEW_CAT}>＋ New Category</option>
            </select>
            {filterCat && (
              <button
                type="button"
                className="scripts__catdel"
                title={`Delete the "${filterCat}" category (scripts move to ${DEFAULT_CAT_LABEL})`}
                onClick={() => void removeCategory(filterCat)}
                disabled={busy}
              >
                🗑
              </button>
            )}
          </div>
          <ul>
            {shown.map((s) => (
              <li
                key={`${s.category}/${s.name}`}
                className={selected && selected.name === s.name && selected.category === s.category ? 'is-selected' : ''}
              >
                <button
                  type="button"
                  className="scripts__item"
                  onClick={() => void openScript(s.name, s.category)}
                  disabled={busy}
                >
                  <span className="scripts__item-name">{s.name}</span>
                  <span className="scripts__item-meta">
                    {filterCat === null && <span className="scripts__cat">{catLabel(s.category)}</span>}
                    {formatBytes(s.size)} · {formatModified(s.modified)}
                  </span>
                </button>
                <button
                  type="button"
                  className="scripts__del"
                  title={`Delete ${s.name}`}
                  onClick={() => void remove(s.name, s.category)}
                  disabled={busy}
                >
                  ✕
                </button>
              </li>
            ))}
            {!loading && shown.length === 0 && <li className="scripts__empty">No scripts here yet.</li>}
          </ul>
        </aside>

        <div className="scripts__editor">
          <div className="scripts__editor-head">
            <span className="scripts__editor-title">
              {selected ? (
                <>
                  {selected.name}
                  <em className="scripts__cat">{catLabel(selected.category)}</em>
                </>
              ) : (
                <em className="scripts__editor-new">New script</em>
              )}
            </span>
            <button type="button" onClick={() => void clearEditor()} disabled={busy}>
              Clear
            </button>
            {selected && (
              <button type="button" onClick={() => void overwrite()} disabled={busy}>
                Overwrite
              </button>
            )}
            <button
              type="button"
              className="scripts__create"
              onClick={() => setShowCreate(true)}
              disabled={busy}
            >
              Create
            </button>
          </div>
          <ScriptEditor
            value={content}
            onChange={setContent}
            variables={variables}
            interpreter={interpreter}
            onInterpreterChange={onInterpreterChange}
          />
        </div>
      </div>

      {showCreate && (
        <CreateScriptModal
          categories={categories}
          // Default the new file's category to whatever the list is filtered to,
          // else to the open script's category.
          initialCategory={filterCat ?? selected?.category ?? ''}
          busy={busy}
          onCancel={() => setShowCreate(false)}
          onCreate={(name, cat, newCat) => void create(name, cat, newCat)}
        />
      )}
    </section>
  )
}

/** Name + category for a new script. Creating a category is inlined here rather
 *  than opening the shared prompt, so two overlays never stack. */
function CreateScriptModal({
  categories,
  initialCategory,
  busy,
  onCancel,
  onCreate,
}: {
  categories: string[]
  initialCategory: string
  busy: boolean
  onCancel: () => void
  onCreate: (name: string, category: string, newCategory: string) => void
}) {
  const [name, setName] = useState('')
  const [cat, setCat] = useState(initialCategory)
  const [newCat, setNewCat] = useState('')

  const ready = name.trim() !== '' && (cat !== NEW_CAT || newCat.trim() !== '')

  return createPortal(
    <div className="prompt__overlay" onMouseDown={onCancel}>
      <form
        className="prompt__box"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (ready && !busy) onCreate(name.trim(), cat, newCat)
        }}
      >
        <h3 className="prompt__title">Create script</h3>
        <input
          autoFocus
          type="text"
          placeholder="script-name.sh"
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
        />
        <p className="scripts__hint">
          Names: letters, digits, dots, dashes, underscores (max 80). <code>.sh</code> is appended automatically.
        </p>
        <select
          className="scripts__modalcat"
          value={cat}
          onChange={(e) => setCat(e.target.value)}
          title="Category for the new script"
        >
          <option value="">{DEFAULT_CAT_LABEL}</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value={NEW_CAT}>＋ New Category</option>
        </select>
        {cat === NEW_CAT && (
          <input
            type="text"
            placeholder="New category name (e.g. RouterOS)"
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            spellCheck={false}
          />
        )}
        <div className="prompt__actions">
          <button type="button" className="prompt__btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="prompt__btn prompt__btn--primary" disabled={!ready || busy}>
            Create
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
