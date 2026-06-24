// 3CX manager state + the threecx_config builder the backend consumes
// (build_threecx_script). Mirrors the original buildThreecxConfig().
import {
  catalogFor,
  endpointByKey,
  GOLDEN_PARAMETERS_FILTER,
  GOLDEN_STANDARD_PRESET,
  TCX_EXTRA_CATALOGS,
  type CatalogField,
} from './catalogs'

export type ThreecxOperation = 'quickactions' | 'probe' | 'audit' | 'apply' | 'export' | 'import'
export type ImportStrategy = 'merge' | 'additive' | 'patch' | 'mirror'
export type FieldValue = boolean | number | string | string[]

export interface CatalogValueState {
  checked: boolean
  value: FieldValue
}

export interface CustomField {
  field: string
  value: string
}

export interface EntityPanel {
  key: string
  label: string
  path: string
  singleton: boolean
  /** Catalog rows keyed by field name → {checked, value}. */
  fields: Record<string, CatalogValueState>
  customFields: CustomField[]
  itemFilter: string
  expand: string
  cloneFrom: string
  /** Compact panels (built by attribute search) show only their ticked fields. */
  compact?: boolean
}

export interface ImportFile {
  name: string
  /** Parsed JSON payload from a prior export. */
  payload: unknown
}

export interface ThreecxState {
  operation: ThreecxOperation
  username: string
  pwSource: 'csv' | 'inline'
  pwInline: string
  pwColumn: string
  panels: EntityPanel[]
  importFile: ImportFile | null
  strategy: ImportStrategy
}

export function emptyThreecx(): ThreecxState {
  return {
    operation: 'quickactions',
    username: '0000',
    pwSource: 'csv',
    pwInline: '',
    pwColumn: 'Password',
    panels: [],
    importFile: null,
    strategy: 'merge',
  }
}

/** Default-Fields preset: the entities that never change between fresh PBXes. */
export function goldenPanels(): EntityPanel[] {
  const panels: EntityPanel[] = []
  for (const key of GOLDEN_STANDARD_PRESET) {
    const p = makePanel(key)
    if (!p) continue
    if (key === 'parameters') p.itemFilter = GOLDEN_PARAMETERS_FILTER
    panels.push(p)
  }
  return panels
}

function defaultsFor(catalog: CatalogField[]): Record<string, CatalogValueState> {
  const out: Record<string, CatalogValueState> = {}
  for (const def of catalog) out[def.field] = { checked: false, value: def.default }
  return out
}

/** Build a fresh panel for an endpoint key (catalog rows pre-seeded, unchecked). */
export function makePanel(key: string): EntityPanel | null {
  const ep = endpointByKey(key)
  if (!ep) return null
  return {
    key: ep.key,
    label: ep.label,
    path: ep.path,
    singleton: !!ep.singleton,
    fields: defaultsFor(catalogFor(key)),
    customFields: [],
    itemFilter: '',
    expand: key === 'users' ? 'Phones' : '',
    cloneFrom: '',
  }
}

// --- Attribute search: a flat index of every catalog field across entities ---
export interface AttributeRef {
  entityKey: string
  entityLabel: string
  field: string
  type: CatalogField['type']
  options?: string[]
  default: FieldValue
}

export const ALL_ATTRIBUTES: AttributeRef[] = (() => {
  const out: AttributeRef[] = []
  for (const [key, fields] of Object.entries(TCX_EXTRA_CATALOGS)) {
    const label = endpointByKey(key)?.label ?? key
    for (const f of fields) {
      out.push({ entityKey: key, entityLabel: label, field: f.field, type: f.type, options: f.options, default: f.default })
    }
  }
  return out
})()

/** Add one searched attribute as a ticked field on its (compact) entity panel. */
export function addAttribute(state: ThreecxState, attr: AttributeRef): ThreecxState {
  const panels = [...state.panels]
  let idx = panels.findIndex((p) => p.key === attr.entityKey)
  if (idx === -1) {
    const p = makePanel(attr.entityKey)
    if (!p) return state
    p.compact = true
    panels.push(p)
    idx = panels.length - 1
  }
  const p = panels[idx]
  const cur = p.fields[attr.field] ?? { checked: false, value: attr.default }
  panels[idx] = { ...p, fields: { ...p.fields, [attr.field]: { ...cur, checked: true } } }
  return { ...state, panels }
}

// --- Quick Actions (Users presets) ---
export interface QuickAction {
  id: string
  label: string
  desc: string
  needsSource: boolean
  /** Fields applied; for clone presets the value is '' and cloneFrom drives it. */
  fields: { field: string; value: FieldValue }[]
  expand?: string
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'copy-blfs',
    label: 'Copy BLFs',
    desc: 'Clone the BLF (busy-lamp-field) XML layout from one source extension onto a range of target extensions.',
    needsSource: true,
    fields: [{ field: 'Blfs', value: '' }],
  },
  {
    id: 'copy-cid',
    label: 'Copy CID',
    desc: "Copy one extension's OutboundCallerID onto a range of others.",
    needsSource: true,
    fields: [{ field: 'OutboundCallerID', value: '' }],
  },
  {
    id: 'audio-cleanup',
    label: 'Fix Default User Settings',
    desc: 'Apply the standard settings: PbxDeliversAudio = true, SendEmailMissedCalls = false, Codecs = [PCMA, G722].',
    needsSource: false,
    fields: [
      { field: 'PbxDeliversAudio', value: true },
      { field: 'SendEmailMissedCalls', value: false },
      { field: 'Phones.*.Settings.Codecs', value: ['PCMA', 'G722'] },
    ],
    expand: 'Phones',
  },
]

/** Build an apply config for a Quick Action: a single Users panel + clone/filter. */
export function buildQuickActionConfig(
  state: ThreecxState,
  action: QuickAction,
  sourceExt: string,
  targets: string,
  sourceIsCompound: boolean,
): ThreecxConfig {
  let pwSrc: 'csv' | 'inline' | 'ssh' = state.pwSource
  if (pwSrc === 'csv' && !sourceIsCompound) pwSrc = 'ssh'
  return {
    username: state.username.trim() || '0000',
    password_source: pwSrc,
    password_inline: state.pwInline,
    password_column: state.pwColumn.trim() || 'Password',
    trunks: [],
    users: [],
    active_keys: ['users'],
    extras: [
      {
        key: 'users',
        label: 'Users',
        path: '/xapi/v1/Users',
        singleton: false,
        fields: action.fields.map((f) => ({ field: f.field, value: f.value })),
      },
    ],
    filters: targets.trim() ? { users: targets.trim() } : {},
    expands: action.expand ? { users: action.expand } : {},
    clone_sources: action.needsSource && sourceExt.trim() ? { users: sourceExt.trim() } : {},
    mode: 'apply',
    probe_first: false,
  }
}

function gather(panel: EntityPanel): { field: string; value: FieldValue }[] {
  const out: { field: string; value: FieldValue }[] = []
  for (const def of catalogFor(panel.key)) {
    const s = panel.fields[def.field]
    if (s?.checked) out.push({ field: def.field, value: s.value })
  }
  for (const c of panel.customFields) {
    const f = c.field.trim()
    if (f) out.push({ field: f, value: c.value })
  }
  return out
}

/** Count ticked/custom targets across all panels (for apply/audit validation). */
export function targetCount(state: ThreecxState): number {
  return state.panels.reduce((n, p) => n + gather(p).length, 0)
}

export interface ThreecxConfig {
  username: string
  password_source: 'csv' | 'inline' | 'ssh'
  password_inline: string
  password_column: string
  trunks: never[]
  users: never[]
  active_keys: string[]
  extras: { key: string; label: string; path: string; singleton: boolean; fields: { field: string; value: FieldValue }[] }[]
  filters: Record<string, string>
  expands: Record<string, string>
  clone_sources: Record<string, string>
  mode: ThreecxOperation
  probe_first: boolean
  import_payload?: unknown
  import_strategy?: ImportStrategy
}

/**
 * Build the threecx_config object. `sourceIsCompound` is true only for the
 * imported-CSV source; for Manual/Test the CSV password mode is rewritten to
 * "ssh" so the backend reuses the SSH password (single-prompt UX).
 */
export function buildThreecxConfig(state: ThreecxState, sourceIsCompound: boolean): ThreecxConfig {
  let pwSrc: 'csv' | 'inline' | 'ssh' = state.pwSource
  if (pwSrc === 'csv' && !sourceIsCompound) pwSrc = 'ssh'

  const extras: ThreecxConfig['extras'] = []
  const filters: Record<string, string> = {}
  const expands: Record<string, string> = {}
  const clone_sources: Record<string, string> = {}

  for (const p of state.panels) {
    const fields = gather(p)
    // Probe and Export read every panel regardless of ticked fields.
    if (!fields.length && state.operation !== 'probe' && state.operation !== 'export') continue
    extras.push({ key: p.key, label: p.label, path: p.path, singleton: p.singleton, fields })
    if (!p.singleton && p.itemFilter.trim()) filters[p.key] = p.itemFilter.trim()
    if (p.expand.trim()) expands[p.key] = p.expand.trim()
    if (p.cloneFrom.trim()) clone_sources[p.key] = p.cloneFrom.trim()
  }

  const config: ThreecxConfig = {
    username: state.username.trim() || '0000',
    password_source: pwSrc,
    password_inline: state.pwInline,
    password_column: state.pwColumn.trim() || 'Password',
    trunks: [],
    users: [],
    active_keys: state.panels.map((p) => p.key),
    extras,
    filters,
    expands,
    clone_sources,
    mode: state.operation,
    probe_first: false,
  }

  if (state.operation === 'import' && state.importFile) {
    config.import_payload = state.importFile.payload
    config.import_strategy = state.strategy
  }

  return config
}
