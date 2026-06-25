import { useEffect, useState } from 'react'
import './updateBanner.css'

/**
 * Listens for electron-updater status (packaged builds only) and surfaces an
 * "update available → Confirm" prompt. No-op in the browser / dev where the
 * electron bridge isn't present.
 */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const el = window.electron
    if (!el?.onUpdateStatus) return
    el.onUpdateStatus((s) => {
      setStatus(s)
      setDismissed(false) // a fresh status re-shows the banner
    })
    el.checkForUpdate?.()
  }, [])

  if (!status || dismissed) return null

  if (status.state === 'checking') return null
  if (status.state === 'none' || status.state === 'error') return null

  if (status.state === 'available' || status.state === 'downloading') {
    const pct = status.state === 'downloading' ? status.percent : undefined
    const ver = status.state === 'available' ? status.version : undefined
    return (
      <div className="upd">
        <span className="upd__spinner" aria-hidden="true" />
        <span className="upd__msg">
          Downloading update{ver ? ` ${ver}` : ''}
          {pct != null ? ` — ${pct}%` : '…'}
        </span>
      </div>
    )
  }

  // downloaded → ready to install
  return (
    <div className="upd upd--ready">
      <span className="upd__msg">
        A new version{status.version ? ` (${status.version})` : ''} is ready.
      </span>
      <button type="button" className="upd__btn" onClick={() => window.electron?.installUpdate?.()}>
        Confirm &amp; restart
      </button>
      <button type="button" className="upd__x" title="Later" onClick={() => setDismissed(true)}>
        ✕
      </button>
    </div>
  )
}
