import './windowControls.css'

/** DOM-drawn min/max/close for the frameless window. Hidden outside Electron. */
export function WindowControls() {
  const bridge = window.electron
  if (!bridge?.windowControl) return null
  const ctl = bridge.windowControl
  return (
    <div className="wc">
      <button type="button" className="wc__btn" title="Minimize" onClick={() => ctl('minimize')} aria-label="Minimize">
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
        </svg>
      </button>
      <button type="button" className="wc__btn" title="Maximize" onClick={() => ctl('maximize')} aria-label="Maximize">
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button type="button" className="wc__btn wc__btn--close" title="Close" onClick={() => ctl('close')} aria-label="Close">
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  )
}
