import { useRef, useState } from 'react'
import { runDeploy, type DeployEvent, type MetaEvent, type SummaryEvent } from '../../lib/stream'
import { EXPORT_BEGIN, EXPORT_END, extractExport, type ExportData } from '../threecx/exportChip'

export type CardStatus = 'queued' | 'running' | 'ok' | 'fail' | 'skipped'

export interface HostCard {
  label: string
  status: CardStatus
  lines: string[]
  output?: string
  message?: string
  stage?: string
  exitStatus?: number | null
  durationS?: number
  /** 3CX Golden export captured from this host's output, if any. */
  exportData?: ExportData
}

const MAX_LINES = 2000

function blankCard(label: string): HostCard {
  return { label, status: 'queued', lines: [] }
}

export interface DeployRun {
  status: 'idle' | 'running' | 'done'
  meta: MetaEvent | null
  summary: SummaryEvent | null
  fatal: string | null
  cards: HostCard[]
  failedLabels: string[]
  start: (form: FormData, opts?: { append?: boolean }) => Promise<void>
  cancel: () => void
}

/**
 * Drives a /api/deploy run: assembles host cards from the NDJSON event stream
 * and batches high-frequency log lines into one state update per animation
 * frame (the original UI's scheduleLogFlush trick, in React form).
 */
export function useDeployRun(): DeployRun {
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const [meta, setMeta] = useState<MetaEvent | null>(null)
  const [summary, setSummary] = useState<SummaryEvent | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [cardMap, setCardMap] = useState<Record<string, HostCard>>({})
  const [order, setOrder] = useState<string[]>([])

  const pendingRef = useRef<Map<string, string[]>>(new Map())
  const rafRef = useRef<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Set when the operator hits Stop, so unfinished hosts become "skipped".
  const cancelledRef = useRef(false)
  // Hosts whose live log is currently inside a 3CX export base64 block.
  const suppressRef = useRef<Set<string>>(new Set())

  function flushPending() {
    rafRef.current = null
    const pending = pendingRef.current
    if (pending.size === 0) return
    pendingRef.current = new Map()
    setCardMap((prev) => {
      const next = { ...prev }
      for (const [label, lines] of pending) {
        const c = next[label] ?? blankCard(label)
        const merged = c.lines.concat(lines)
        next[label] = {
          ...c,
          status: c.status === 'queued' ? 'running' : c.status,
          lines: merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged,
        }
      }
      return next
    })
  }

  function scheduleFlush() {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(flushPending)
  }

  function onEvent(ev: DeployEvent) {
    switch (ev.type) {
      case 'meta':
        setMeta(ev)
        break
      case 'start':
        setCardMap((prev) => (prev[ev.host] ? prev : { ...prev, [ev.host]: blankCard(ev.host) }))
        setOrder((prev) => (prev.includes(ev.host) ? prev : [...prev, ev.host]))
        break
      case 'log': {
        // Suppress the 3CX export base64 wall in the live log (it's still
        // captured server-side and processed from ev.output at result time).
        if (ev.line === EXPORT_BEGIN) {
          suppressRef.current.add(ev.host)
          const arr = pendingRef.current.get(ev.host) ?? []
          arr.push('[export payload streaming… download appears when done]')
          pendingRef.current.set(ev.host, arr)
          scheduleFlush()
          break
        }
        if (ev.line === EXPORT_END) {
          suppressRef.current.delete(ev.host)
          break
        }
        if (suppressRef.current.has(ev.host)) break
        const arr = pendingRef.current.get(ev.host) ?? []
        arr.push(ev.line)
        pendingRef.current.set(ev.host, arr)
        scheduleFlush()
        break
      }
      case 'result': {
        // Apply any buffered lines first so none are lost behind the result.
        flushPending()
        suppressRef.current.delete(ev.target)
        const ex = extractExport(ev.output, ev.target)
        setCardMap((prev) => {
          const c = prev[ev.target] ?? blankCard(ev.target)
          return {
            ...prev,
            [ev.target]: {
              ...c,
              status: ev.ok ? 'ok' : 'fail',
              output: ex ? ex.cleaned : ev.output,
              message: ev.message,
              stage: ev.stage,
              exitStatus: ev.exit_status,
              durationS: ev.duration_s,
              exportData: ex?.data,
            },
          }
        })
        break
      }
      case 'summary':
        setSummary(ev)
        break
      case 'fatal':
        setFatal(ev.message)
        break
    }
  }

  async function start(form: FormData, opts?: { append?: boolean }) {
    // Reset — unless appending (staged batch rollout) where prior results stay.
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    pendingRef.current = new Map()
    suppressRef.current = new Set()
    if (!opts?.append) {
      setMeta(null)
      setSummary(null)
      setFatal(null)
      setCardMap({})
      setOrder([])
    }
    setStatus('running')
    cancelledRef.current = false

    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      await runDeploy(form, { onEvent, signal: ctrl.signal })
    } catch (e) {
      if (!ctrl.signal.aborted) setFatal(e instanceof Error ? e.message : String(e))
    } finally {
      flushPending()
      abortRef.current = null
      // A stopped run: any host that never returned a result is "skipped".
      if (cancelledRef.current) {
        setCardMap((prev) => {
          const next = { ...prev }
          for (const label of Object.keys(next)) {
            const c = next[label]
            if (c.status === 'queued' || c.status === 'running') {
              next[label] = { ...c, status: 'skipped', stage: c.stage ?? 'stopped', message: c.message ?? 'stopped before completion' }
            }
          }
          return next
        })
        cancelledRef.current = false
      }
      setStatus('done')
    }
  }

  function cancel() {
    cancelledRef.current = true
    abortRef.current?.abort()
  }

  const cards = order.map((l) => cardMap[l]).filter(Boolean)
  const failedLabels = cards.filter((c) => c.status === 'fail').map((c) => c.label)

  return { status, meta, summary, fatal, cards, failedLabels, start, cancel }
}
