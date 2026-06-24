// Detect and decode the 3CX "Golden export" block the backend emits between
// sentinel lines, so the results panel can offer a JSON download. Mirrors the
// original maybeOfferThreecxExport().
export const EXPORT_BEGIN = '###BSM_3CX_EXPORT_BEGIN###'
export const EXPORT_END = '###BSM_3CX_EXPORT_END###'

export interface ExportData {
  jsonText: string
  filename: string
  /** "trunks:3  users:35" style summary, or '' if it couldn't be derived. */
  summary: string
}

export interface ExportResult {
  /** The host output with the base64 block replaced by a short note. */
  cleaned: string
  data: ExportData
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

/**
 * Extract the export payload from a host's full output. Returns null when there
 * is no (valid) export block.
 */
export function extractExport(output: string, hostLabel: string): ExportResult | null {
  if (!output || !output.includes(EXPORT_BEGIN)) return null
  const lines = output.split(/\r?\n/)
  const startIdx = lines.indexOf(EXPORT_BEGIN)
  const endIdx = lines.indexOf(EXPORT_END, startIdx + 1)
  if (startIdx === -1 || endIdx === -1) return null

  const b64 = lines.slice(startIdx + 1, endIdx).join('').trim()
  let jsonText: string
  let parsed: unknown
  try {
    jsonText = atob(b64)
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }

  const cleaned = lines
    .slice(0, startIdx)
    .concat(['[Config export captured — see the download above the log]'])
    .concat(lines.slice(endIdx + 1))
    .join('\n')

  const safeHost = String(hostLabel).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'host'
  const filename = `3cx-config_${safeHost}_${timestamp()}.json`

  let summary = ''
  try {
    const entities = (parsed as { entities?: Record<string, { items?: unknown[] }> }).entities ?? {}
    summary = Object.entries(entities)
      .map(([k, v]) => `${k}:${v.items?.length ?? 0}`)
      .join('  ')
  } catch {
    summary = ''
  }

  return { cleaned, data: { jsonText, filename, summary } }
}
