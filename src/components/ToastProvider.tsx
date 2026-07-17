import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import './toast.css'

export type ToastKind = 'ok' | 'error' | 'info' | 'tip'

interface Toast {
  id: number
  text: string
  kind: ToastKind
}

/** Show a transient overlay notification. `null`/empty text is ignored. */
type ToastFn = (text: string | null | undefined, kind?: ToastKind) => void
/** Show a one-off tip (by stable id) that never repeats once seen. */
type TipFn = (id: string, text: string) => void

interface ToastApi {
  toast: ToastFn
  tip: TipFn
}

const ToastCtx = createContext<ToastApi>({ toast: () => {}, tip: () => {} })

/** Fire an overlay toast from anywhere in the tree. */
export function useToast(): ToastFn {
  return useContext(ToastCtx).toast
}
/** Fire a one-off tip (shown once per id, then remembered). */
export function useTip(): TipFn {
  return useContext(ToastCtx).tip
}

// --- One-off tip bookkeeping (persisted so tips don't repeat) -------------- //
const TIPS_KEY = 'fc.tipsSeen'

function seenTips(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(TIPS_KEY) || '[]')
    return new Set(Array.isArray(raw) ? (raw as string[]) : [])
  } catch {
    return new Set()
  }
}
function markTipSeen(id: string) {
  try {
    const s = seenTips()
    s.add(id)
    localStorage.setItem(TIPS_KEY, JSON.stringify([...s]))
  } catch {
    /* ignore */
  }
}
/** Forget all seen tips so they show again (wired to Settings → Reset tips). */
export function resetTips() {
  try {
    localStorage.removeItem(TIPS_KEY)
  } catch {
    /* ignore */
  }
}

// Errors linger longer than successes; tips stay for 2 minutes (and pause while
// hovered) so a first-time user has time to read and act on them.
const DURATION: Record<ToastKind, number> = { ok: 4000, info: 4000, tip: 120000, error: 6500 }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const remove = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const toast: ToastFn = useCallback((text, kind = 'info') => {
    if (!text) return
    const id = nextId.current++
    setToasts((list) => [...list, { id, text, kind }])
  }, [])

  const tip: TipFn = useCallback((id, text) => {
    if (!text || seenTips().has(id)) return
    markTipSeen(id)
    const tid = nextId.current++
    setToasts((list) => [...list, { id: tid, text, kind: 'tip' }])
  }, [])

  return (
    <ToastCtx.Provider value={{ toast, tip }}>
      {children}
      <div className="toast__stack" role="region" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={() => remove(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const [leaving, setLeaving] = useState(false)
  const timerRef = useRef<number | null>(null)

  // Start the exit animation, then remove after it plays.
  const dismiss = useCallback(() => {
    setLeaving(true)
    window.setTimeout(onClose, 200)
  }, [onClose])

  const stopTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])
  const startTimer = useCallback(() => {
    stopTimer()
    timerRef.current = window.setTimeout(dismiss, DURATION[toast.kind])
  }, [dismiss, stopTimer, toast.kind])

  useEffect(() => {
    startTimer()
    return stopTimer
  }, [startTimer, stopTimer])

  const icon = toast.kind === 'ok' ? '✓' : toast.kind === 'error' ? '✕' : toast.kind === 'tip' ? '!' : 'ℹ'

  return (
    <div
      className={`toast toast--${toast.kind} ${leaving ? 'toast--leaving' : ''}`}
      role="status"
      // Pause the auto-dismiss countdown while the pointer is over the toast.
      onMouseEnter={stopTimer}
      onMouseLeave={startTimer}
    >
      <span className="toast__icon">{icon}</span>
      <span className="toast__text">
        {toast.kind === 'tip' && <strong className="toast__tiplabel">Tip · </strong>}
        {toast.text}
      </span>
      <button type="button" className="toast__close" title="Dismiss" onClick={dismiss}>
        ✕
      </button>
    </div>
  )
}
