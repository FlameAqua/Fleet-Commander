// NDJSON streaming client for POST /api/deploy. The endpoint emits one JSON
// object per line (application/x-ndjson); we read the body incrementally so
// host cards update the moment each remote line arrives.
import { apiUrl } from '../api'

export interface MetaEvent {
  type: 'meta'
  action: string
  mode: string
  version: string
  interpreter: string
  count: number
  interface: string
  hep_server: string
  strict_host_keys: boolean
  warnings: string[]
}
export interface StartEvent {
  type: 'start'
  host: string
}
export interface LogEvent {
  type: 'log'
  host: string
  line: string
}
export interface ResultEvent {
  type: 'result'
  target: string
  ok: boolean
  stage: string
  message: string
  exit_status: number | null
  output: string
  duration_s: number
}
export interface SummaryEvent {
  type: 'summary'
  succeeded: number
  failed: number
  total: number
}
export interface FatalEvent {
  type: 'fatal'
  message: string
}

export type DeployEvent =
  | MetaEvent
  | StartEvent
  | LogEvent
  | ResultEvent
  | SummaryEvent
  | FatalEvent

export interface RunOptions {
  onEvent: (ev: DeployEvent) => void
  signal?: AbortSignal
}

/**
 * POST a multipart form to /api/deploy and dispatch each NDJSON event.
 * Resolves when the stream ends; rejects on network error or abort.
 */
export async function runDeploy(form: FormData, opts: RunOptions): Promise<void> {
  const res = await fetch(apiUrl('/api/deploy'), {
    method: 'POST',
    body: form,
    signal: opts.signal,
  })
  if (!res.ok || !res.body) {
    // A pre-run failure may still arrive as a one-line NDJSON "fatal" with 200;
    // a non-200 here is an unexpected transport error.
    const text = await res.text().catch(() => '')
    throw new Error(text || `deploy failed: ${res.status} ${res.statusText}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  const flushLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      opts.onEvent(JSON.parse(trimmed) as DeployEvent)
    } catch {
      // Ignore malformed lines rather than aborting the whole run.
    }
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      flushLine(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  }
  buf += decoder.decode()
  if (buf) flushLine(buf)
}
