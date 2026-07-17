import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Segmented } from '../../components/Segmented'
import { useTip } from '../../components/ToastProvider'
import { readFileText } from '../../lib/file'
import { catalogFor, TCX_ENDPOINTS, type CatalogField } from './catalogs'
import {
  addAttribute,
  ALL_ATTRIBUTES,
  goldenPanels,
  makePanel,
  QUICK_ACTIONS,
  type AttributeRef,
  type CatalogValueState,
  type EntityPanel,
  type FieldValue,
  type ImportStrategy,
  type QuickAction,
  type ThreecxOperation,
  type ThreecxState,
} from './threecxModel'
import './threecx.css'

interface Props {
  value: ThreecxState
  onChange: (v: ThreecxState) => void
  /** "Probe for all available fields" on a single chosen system. */
  onProbe: () => void
  /** Run a Quick Action (Copy BLFs / CID / Audio Cleanup) on the selected systems. */
  onQuickAction: (action: QuickAction, sourceExt: string, targets: string) => void
}

const COMMON_FIELDS_TIP =
  'Loaded common fields that generally automate the tedious parts of new 3CX phone system creation.'

export function ThreecxPanel({ value, onChange, onProbe, onQuickAction }: Props) {
  const set = (patch: Partial<ThreecxState>) => onChange({ ...value, ...patch })
  const tip = useTip()
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  function addPanel(key: string) {
    if (!key) return
    if (value.panels.some((p) => p.key === key)) return
    const p = makePanel(key)
    if (p) set({ panels: [...value.panels, p] })
  }
  function updatePanel(idx: number, next: EntityPanel) {
    set({ panels: value.panels.map((p, i) => (i === idx ? next : p)) })
  }
  function removePanel(idx: number) {
    set({ panels: value.panels.filter((_, i) => i !== idx) })
  }

  async function onImportFile(file: File | null) {
    setImportError(null)
    if (!file) {
      set({ importFile: null })
      return
    }
    try {
      const payload = JSON.parse(await readFileText(file))
      set({ importFile: { name: file.name, payload } })
    } catch (e) {
      setImportError(`Couldn't read JSON: ${e instanceof Error ? e.message : String(e)}`)
      set({ importFile: null })
    }
  }

  const STRATEGIES: { id: ImportStrategy; label: string; hint: string }[] = [
    { id: 'merge', label: 'Merge (add missing & patch existing)', hint: 'Adds missing & overrides existing settings. Does not affect or remove other settings.' },
    { id: 'additive', label: 'Add missing only', hint: 'Adds missing settings only. Does not affect existing or other settings.' },
    { id: 'patch', label: 'Patch existing only', hint: 'Only overrides existing settings. Does not add missing or affect existing settings.' },
    { id: 'mirror', label: 'Mirror (destructive)', hint: 'Adds missing & overrides existing settings. REMOVES any other settings.' },
  ]

  const recommended = TCX_ENDPOINTS.filter((e) => e.recommended)
  const others = TCX_ENDPOINTS.filter((e) => !e.recommended)

  const OPS: { id: ThreecxOperation; label: string }[] = [
    { id: 'quickactions', label: 'Quick Actions' },
    { id: 'audit', label: 'Audit' },
    { id: 'apply', label: 'Modify' },
    { id: 'export', label: 'Export' },
    { id: 'import', label: 'Import' },
  ]

  const isFieldOp = value.operation === 'audit' || value.operation === 'apply'
  const isExportOp = value.operation === 'export'

  return (
    <div className="tcx">
      <div className="tcx__top">
        <Segmented options={OPS} value={value.operation} onChange={(op) => set({ operation: op })} ariaLabel="3CX operation" />
        <button type="button" className="tcx__cog" title="Advanced Settings" onClick={() => setShowAdvanced(true)}>
          ⚙
        </button>
      </div>

      {/* Quick Actions — one-click Users presets. */}
      {value.operation === 'quickactions' && (
        <div className="tcx-qa">
          {QUICK_ACTIONS.map((a) => (
            <QuickActionCard key={a.id} action={a} onRun={onQuickAction} />
          ))}
        </div>
      )}

      {/* Import — pick a previously-exported JSON + strategy. */}
      {value.operation === 'import' && (
        <div className="tcx__import">
          <div className="tcx__add">
            <label className="src-filebtn">
              <input type="file" accept=".json,application/json" onClick={(e) => { (e.target as HTMLInputElement).value = '' }} onChange={(e) => void onImportFile(e.target.files?.[0] ?? null)} />
              Choose Config JSON…
            </label>
            <span className="src-filename">{value.importFile ? value.importFile.name : 'No file selected'}</span>
          </div>
          {importError && <div className="tcx__importerr">{importError}</div>}
          <div className="tcx__strats">
            {STRATEGIES.map((s) => (
              <label key={s.id} className="tcx__strat">
                <input type="radio" name="tcx-strat" checked={value.strategy === s.id} onChange={() => set({ strategy: s.id })} />
                <span>
                  <b>{s.label}</b>
                  <em>{s.hint}</em>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Audit / Modify — search attributes (single fields) or add a whole entity. */}
      {isFieldOp && (
        <>
          <p className="tcx__desc">
            {value.operation === 'audit' ? (
              'Select an attribute and the expected value. All selected 3CX systems will verify if this field matches.'
            ) : (
              <>
                Select an attribute and the desired value. All selected 3CX systems will <strong>apply/override</strong> this new
                value.
              </>
            )}
          </p>
          <div className="tcx__addrow">
            <AttributeSearch onPick={(attr) => onChange(addAttribute(value, attr))} />
            <select
              className="tcx__manualpick"
              value=""
              onChange={(e) => {
                addPanel(e.target.value)
                e.target.value = ''
              }}
            >
              <option value="">Select entity manually…</option>
              <optgroup label="Recommended">
                {recommended.map((e) => (
                  <option key={e.key} value={e.key} disabled={value.panels.some((p) => p.key === e.key)}>
                    {e.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="All endpoints">
                {others.map((e) => (
                  <option key={e.key} value={e.key} disabled={value.panels.some((p) => p.key === e.key)}>
                    {e.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
          {value.panels.map((panel, idx) => (
            <PanelEditor key={panel.key} panel={panel} onChange={(p) => updatePanel(idx, p)} onRemove={() => removePanel(idx)} />
          ))}
          <ProbeHint onProbe={onProbe} />
        </>
      )}

      {/* Export — pick whole entities (+ Default Fields preset). */}
      {isExportOp && (
        <>
          <p className="tcx__desc">
            Select the 3CX entities (e.g. Users, Trunks, etc.) that you want to export as JSON. This can later be
            imported to another system(s).
          </p>
          <div className="tcx__add">
            <select
              value=""
              onChange={(e) => {
                addPanel(e.target.value)
                e.target.value = ''
              }}
            >
              <option value="">+ Add entity…</option>
              <optgroup label="Recommended">
                {recommended.map((e) => (
                  <option key={e.key} value={e.key} disabled={value.panels.some((p) => p.key === e.key)}>
                    {e.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="All endpoints">
                {others.map((e) => (
                  <option key={e.key} value={e.key} disabled={value.panels.some((p) => p.key === e.key)}>
                    {e.label}
                  </option>
                ))}
              </optgroup>
            </select>
            <button
              type="button"
              className="tcx__link"
              onClick={() => {
                set({ panels: goldenPanels() })
                tip('tcx-common-fields', COMMON_FIELDS_TIP)
              }}
            >
              ★ Load Common Fields
            </button>
            {value.panels.length > 0 && (
              <button type="button" className="tcx__link" onClick={() => set({ panels: [] })}>
                Remove all
              </button>
            )}
          </div>
          {value.panels.map((panel, idx) => (
            <PanelEditor key={panel.key} panel={panel} onChange={(p) => updatePanel(idx, p)} onRemove={() => removePanel(idx)} />
          ))}
          <ProbeHint onProbe={onProbe} />
        </>
      )}

      {/* Advanced Settings — opened via the ⚙ cogwheel. PBX credentials.
          Portaled to <body> so the overlay covers the whole viewport instead
          of being trapped inside the frosted (backdrop-filter) step card. */}
      {showAdvanced && createPortal(
        <div className="tcx-modal__overlay" onMouseDown={() => setShowAdvanced(false)}>
          <div className="tcx-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="tcx-modal__head">
              <h3>Advanced Settings</h3>
              <button type="button" className="tcx-modal__close" onClick={() => setShowAdvanced(false)}>
                ✕
              </button>
            </div>
            <p className="tcx-modal__intro">
              If for some reason the SSH login password differs from our default <code>0000</code> admin password, you
              can change the values here.
            </p>
            <label className="tcx__field">
              <span>Login user</span>
              <input value={value.username} onChange={(e) => set({ username: e.target.value })} placeholder="0000" />
            </label>
            <div className="tcx__pwsrc">
              <label>
                <input type="radio" name="tcx-pwsrc" checked={value.pwSource === 'csv'} onChange={() => set({ pwSource: 'csv' })} />
                Read Password from below CSV column title:
              </label>
              {value.pwSource === 'csv' && (
                <input className="tcx__pwinput" value={value.pwColumn} onChange={(e) => set({ pwColumn: e.target.value })} placeholder="Password" />
              )}
              <label>
                <input type="radio" name="tcx-pwsrc" checked={value.pwSource === 'inline'} onChange={() => set({ pwSource: 'inline' })} />
                Set a password manually that applies to all hosts.
              </label>
              {value.pwSource === 'inline' && (
                <input
                  className="tcx__pwinput"
                  type="password"
                  autoComplete="off"
                  value={value.pwInline}
                  onChange={(e) => set({ pwInline: e.target.value })}
                  placeholder="PBX password"
                />
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function ProbeHint({ onProbe }: { onProbe: () => void }) {
  return (
    <p className="tcx__probehint">
      Need a specific field?{' '}
      <button type="button" className="tcx__link" onClick={onProbe}>
        Probe for all available fields
      </button>
    </p>
  )
}

// --------------------------------------------------------------------------
// Attribute search — find a single field across every entity catalog.
// --------------------------------------------------------------------------
function AttributeSearch({ onPick }: { onPick: (attr: AttributeRef) => void }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return ALL_ATTRIBUTES.filter(
      (a) => a.field.toLowerCase().includes(q) || a.entityLabel.toLowerCase().includes(q),
    ).slice(0, 40)
  }, [query])

  // The list is portaled to <body> (see the note on .tcx-search__list), so it
  // has to be anchored to the input's rect by hand. Layout effect, not effect:
  // measure before paint or the list flashes at the wrong spot.
  useLayoutEffect(() => {
    if (!open) return
    const r = box.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 2, left: r.left, width: r.width })
  }, [open])

  // Portaled + fixed means the list won't follow the page, so close it on
  // scroll/resize. Ignore scrolls coming from inside the list itself — it is
  // scrollable, and a capture-phase listener sees those too.
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (e.type === 'scroll' && e.target instanceof Node && list.current?.contains(e.target)) return
      setOpen(false)
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <div className="tcx-search" ref={box}>
      <input
        type="text"
        className="tcx-search__input"
        placeholder="Search attributes (e.g. Language, Codecs, DeliverAudio)…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        spellCheck={false}
      />
      {open && matches.length > 0 && pos &&
        createPortal(
          <ul className="tcx-search__list" ref={list} style={{ top: pos.top, left: pos.left, width: pos.width }}>
            {matches.map((a) => (
              <li key={`${a.entityKey}.${a.field}`}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onPick(a)
                    setQuery('')
                    setOpen(false)
                  }}
                >
                  <span className="tcx-search__field">{a.field}</span>
                  <span className="tcx-search__ent">{a.entityLabel}</span>
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  )
}

// --------------------------------------------------------------------------
// Quick Action card
// --------------------------------------------------------------------------
function QuickActionCard({
  action,
  onRun,
}: {
  action: QuickAction
  onRun: (action: QuickAction, sourceExt: string, targets: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [src, setSrc] = useState('')
  const [targets, setTargets] = useState('')
  return (
    <div className={`tcx-qacard ${open ? 'is-open' : ''}`}>
      <button type="button" className="tcx-qacard__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="tcx-qacard__title">{action.label}</span>
        <span className="tcx-qacard__chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tcx-qacard__body">
          <p className="tcx-qacard__desc">{action.desc}</p>
          {action.needsSource && (
            <label className="tcx-qacard__field">
              <span>Source extension</span>
              <input value={src} onChange={(e) => setSrc(e.target.value)} placeholder="e.g. 2901" spellCheck={false} />
            </label>
          )}
          <label className="tcx-qacard__field">
            <span>Target extensions</span>
            <input
              value={targets}
              onChange={(e) => setTargets(e.target.value)}
              placeholder="e.g. 2902-2920, 29*, or 2902, 2903"
              spellCheck={false}
            />
          </label>
          <button type="button" className="run__btn run__btn--primary" onClick={() => onRun(action, src, targets)}>
            Apply to targets
          </button>
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
function PanelEditor({
  panel,
  onChange,
  onRemove,
}: {
  panel: EntityPanel
  onChange: (p: EntityPanel) => void
  onRemove: () => void
}) {
  const catalog = catalogFor(panel.key)
  // Compact panels (from attribute search) show only their ticked fields.
  const visible = panel.compact ? catalog.filter((d) => panel.fields[d.field]?.checked) : catalog
  // Collapsed by default for full panels (e.g. Default Fields); compact panels
  // stay open so the just-searched field is visible.
  const [open, setOpen] = useState(!!panel.compact)
  const checkedCount =
    catalog.filter((d) => panel.fields[d.field]?.checked).length + panel.customFields.filter((c) => c.field.trim()).length

  function setField(field: string, patch: Partial<CatalogValueState>) {
    const cur = panel.fields[field] ?? { checked: false, value: '' }
    onChange({ ...panel, fields: { ...panel.fields, [field]: { ...cur, ...patch } } })
  }
  function addCustom() {
    onChange({ ...panel, customFields: [...panel.customFields, { field: '', value: '' }] })
  }
  function setCustom(i: number, patch: Partial<{ field: string; value: string }>) {
    onChange({ ...panel, customFields: panel.customFields.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) })
  }
  function removeCustom(i: number) {
    onChange({ ...panel, customFields: panel.customFields.filter((_, idx) => idx !== i) })
  }

  return (
    <section className={`tcx-panel ${open ? 'is-open' : ''}`}>
      <header className="tcx-panel__head">
        <button type="button" className="tcx-panel__toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="tcx-panel__chev">{open ? '▾' : '▸'}</span>
          <span className="tcx-panel__title">{panel.label}</span>
          {!open && checkedCount > 0 && (
            <span className="tcx-panel__count">
              {checkedCount} field{checkedCount === 1 ? '' : 's'}
            </span>
          )}
        </button>
        <code className="tcx-panel__path">{panel.path}</code>
        <button
          type="button"
          className="tcx-panel__remove"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          title="Remove panel"
        >
          ✕
        </button>
      </header>

      {open && visible.length > 0 && (
        <div className="tcx-panel__fields">
          {visible.map((def) => {
            const s = panel.fields[def.field] ?? { checked: false, value: def.default }
            return (
              <div key={def.field} className={`tcx-row ${s.checked ? 'is-on' : ''}`}>
                {panel.compact ? (
                  <span className="tcx-row__name">{def.field}</span>
                ) : (
                  <label className="tcx-row__check">
                    <input type="checkbox" checked={s.checked} onChange={(e) => setField(def.field, { checked: e.target.checked })} />
                    <span className="tcx-row__name">{def.field}</span>
                  </label>
                )}
                <div className="tcx-row__right">
                  <ValueControl def={def} value={s.value} onChange={(v) => setField(def.field, { value: v })} />
                  {panel.compact && (
                    <button type="button" className="tcx-row__del" title="Remove field" onClick={() => setField(def.field, { checked: false })}>
                      ✕
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {open && !panel.singleton && (
        <label className="tcx-panel__filter">
          <span>Apply only to items:</span>
          <input
            value={panel.itemFilter}
            onChange={(e) => onChange({ ...panel, itemFilter: e.target.value })}
            placeholder="2001-2005, 20*  (default blank = all)"
            spellCheck={false}
          />
        </label>
      )}

      {open && (
        <div className="tcx-panel__custom">
          <div className="tcx-panel__customhead">
            <span>Custom fields</span>
            <button type="button" className="tcx__link" onClick={addCustom}>
              + Add field
            </button>
          </div>
          {panel.customFields.map((c, i) => (
            <div key={i} className="tcx-custom">
              <input className="tcx-custom__field" placeholder="Field.Path" value={c.field} onChange={(e) => setCustom(i, { field: e.target.value })} spellCheck={false} />
              <input className="tcx-custom__value" placeholder="value" value={c.value} onChange={(e) => setCustom(i, { value: e.target.value })} spellCheck={false} />
              <button type="button" className="tcx-custom__del" onClick={() => removeCustom(i)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// --------------------------------------------------------------------------
function ValueControl({
  def,
  value,
  onChange,
}: {
  def: CatalogField
  value: FieldValue
  onChange: (v: FieldValue) => void
}) {
  if (def.type === 'bool') {
    return (
      <select className="tcx-row__val" value={value === true ? 'true' : 'false'} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    )
  }
  if (def.type === 'enum') {
    return (
      <select className="tcx-row__val" value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {(def.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  if (def.type === 'int') {
    return <input className="tcx-row__val" type="number" value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} />
  }
  if (def.type === 'list') {
    const arr = Array.isArray(value) ? value : []
    return (
      <input
        className="tcx-row__val"
        value={arr.join(', ')}
        placeholder="comma,separated"
        onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
        spellCheck={false}
      />
    )
  }
  return <input className="tcx-row__val" value={String(value)} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
}
