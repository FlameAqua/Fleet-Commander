// Enumerate / restrict the hosts implied by a Source, for the "Test on one
// host" chooser. Labels are the canonical Target.label the backend generates.
import { buildCanonicalKeepass, canonicalLabel, injectUserIntoUrl } from '../../lib/csv'
import type { SourceState } from '../source/sourceModel'

export interface HostOption {
  value: string
  label: string
}

function display(label: string): string {
  return label.replace(/^ssh:\/\/[^@]+@/, '').replace(/:\d+$/, '')
}

function manualLabel(url: string, user: string): string | null {
  const u = url.trim()
  if (!u) return null
  const full = user.trim()
    ? injectUserIntoUrl(u, user.trim())
    : u.toLowerCase().startsWith('ssh://')
      ? u
      : `ssh://root@${u}`
  return canonicalLabel(full) || null
}

/** The hosts currently selected for a run (checklist minus exclusions). */
export function selectedHosts(source: SourceState): HostOption[] {
  if (source.mode === 'compound') {
    if (!source.file) return []
    try {
      const res = buildCanonicalKeepass(source.file.text, {
        overrides: source.overrides,
        useLogin: source.useLogin,
      })
      const ex = new Set(source.excluded)
      return res.entries
        .filter((e) => !ex.has(e.label))
        .map((e) => ({
          value: e.label,
          label: e.name && e.name !== e.label ? `${e.name} (${display(e.label)})` : display(e.label),
        }))
    } catch {
      return []
    }
  }
  if (source.mode === 'manual') {
    const out: HostOption[] = []
    const seen = new Set<string>()
    for (const r of source.rows) {
      const label = manualLabel(r.url, r.user)
      if (!label || seen.has(label)) continue
      seen.add(label)
      out.push({ value: label, label: display(label) })
    }
    return out
  }
  return []
}

/** Split an array into chunks of at most `size`. */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr]
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Restrict a source so a run only targets the given set of host labels. */
export function restrictToHosts(source: SourceState, labels: string[]): SourceState {
  const keep = new Set(labels)
  if (source.mode === 'compound') {
    if (!source.file) return source
    try {
      const res = buildCanonicalKeepass(source.file.text, { overrides: source.overrides, useLogin: source.useLogin })
      const excluded = res.entries.map((e) => e.label).filter((l) => !keep.has(l))
      return { ...source, excluded }
    } catch {
      return source
    }
  }
  if (source.mode === 'manual') {
    return { ...source, rows: source.rows.filter((r) => { const l = manualLabel(r.url, r.user); return l !== null && keep.has(l) }) }
  }
  return source
}

/** Deselect (exclude) the given host labels from the current selection. */
export function deselectHosts(source: SourceState, labels: string[]): SourceState {
  if (!labels.length) return source
  const drop = new Set(labels)
  if (source.mode === 'compound') {
    const ex = new Set(source.excluded)
    for (const l of labels) ex.add(l)
    return { ...source, excluded: [...ex] }
  }
  if (source.mode === 'manual') {
    return {
      ...source,
      rows: source.rows.filter((r) => {
        const l = manualLabel(r.url, r.user)
        return l === null || !drop.has(l)
      }),
    }
  }
  return source
}

/** Restrict a source so a run only targets the single given host label. */
export function restrictToHost(source: SourceState, label: string): SourceState {
  if (source.mode === 'compound') {
    if (!source.file) return source
    try {
      const res = buildCanonicalKeepass(source.file.text, {
        overrides: source.overrides,
        useLogin: source.useLogin,
      })
      const excluded = res.entries.map((e) => e.label).filter((l) => l !== label)
      return { ...source, excluded }
    } catch {
      return source
    }
  }
  if (source.mode === 'manual') {
    return { ...source, rows: source.rows.filter((r) => manualLabel(r.url, r.user) === label) }
  }
  return source
}
