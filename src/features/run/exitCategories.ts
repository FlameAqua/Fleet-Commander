// User-configurable exit-code categories for the Voyage Results.
//
// Codes 0, 1, 2 are RESERVED and fixed: 0 = Success, 1 = Error, 2 = Failure.
// Codes 3–9 can be given a custom label (e.g. 3 = "Invalid"); an unlabelled or
// unmatched non-zero code falls into "Error". Persisted in localStorage.
//
// (Remote shells wrap exit codes to 0–255, so `exit 777` arrives as 9 — hence
// the 0–9 range here covers the practical cases with a simple fixed grid.)

export interface ExitCategory {
  code: number
  label: string
}

export const FAILURE_CODE = 2
export const FAILURE_LABEL = 'Failure'
/** Codes 0–2 are reserved and cannot be used as custom categories. */
export const RESERVED_CODES = [0, 1, 2]
export const MIN_USER_CODE = 3
export const MAX_USER_CODE = 9

/** Default: exit 2 is a planned "Failure" (always present, not removable). */
export const DEFAULT_EXIT_CATEGORIES: ExitCategory[] = [{ code: FAILURE_CODE, label: FAILURE_LABEL }]

const KEY = 'fc.exitCategories'

function sanitize(raw: unknown): ExitCategory[] {
  // Code 2 = "Failure" is always present and locked.
  const out = new Map<number, string>([[FAILURE_CODE, FAILURE_LABEL]])
  if (Array.isArray(raw)) {
    for (const c of raw) {
      const code = Number((c as ExitCategory)?.code)
      const label = String((c as ExitCategory)?.label ?? '').trim()
      if (Number.isInteger(code) && code >= MIN_USER_CODE && code <= MAX_USER_CODE && label) {
        out.set(code, label)
      }
    }
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([code, label]) => ({ code, label }))
}

export function loadExitCategories(): ExitCategory[] {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored == null) return DEFAULT_EXIT_CATEGORIES
    return sanitize(JSON.parse(stored))
  } catch {
    return DEFAULT_EXIT_CATEGORIES
  }
}

export function saveExitCategories(cats: ExitCategory[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sanitize(cats)))
  } catch {
    /* ignore */
  }
}
