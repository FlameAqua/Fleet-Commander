import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import './toast.css'

export type ToastKind = 'ok' | 'error' | 'info'

interface Toast {
  id: number
  text: string
  kind: ToastKind
}

/** Show a transient overlay notification. `null`/empty text is ignored. */
type ToastFn = (text: string | null | undefined, kind?: ToastKind) => void

const ToastCtx = createContext<ToastFn>(() => {})

/** Fire an overlay toast from anywhere in the tree. */
export function useToast(): ToastFn {
  return useContext(ToastCtx)
}

// Errors linger a little longer than successes — they're more important to read.
const DURATION: Record<ToastKind, number> = { ok: 4000, info: 4000, error: 6500 }

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

  return (
    <ToastCtx.Provider value={toast}>
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

  // Start the exit animation, then remove after it plays.
  const dismiss = useCallback(() => {
    setLeaving(true)
    window.setTimeout(onClose, 200)
  }, [onClose])

  useEffect(() => {
    const timer = window.setTimeout(dismiss, DURATION[toast.kind])
    return () => window.clearTimeout(timer)
  }, [toast.kind, dismiss])

  const icon = toast.kind === 'ok' ? '✓' : toast.kind === 'error' ? '✕' : 'ℹ'

  return (
    <div className={`toast toast--${toast.kind} ${leaving ? 'toast--leaving' : ''}`} role="status">
      <span className="toast__icon">{icon}</span>
      <span className="toast__text">{toast.text}</span>
      <button type="button" className="toast__close" title="Dismiss" onClick={dismiss}>
        ✕
      </button>
    </div>
  )
}
