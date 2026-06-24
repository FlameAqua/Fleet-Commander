import { useEffect, useState } from 'react'
import './splash.css'

const MIN_MS = 1400
const FADE_MS = 500

/**
 * Branded splash shown immediately on launch. A spinner runs while the backend
 * is still connecting; once `ready` (and a minimum hold has elapsed) it fades
 * out and unmounts.
 */
export function Splash({ ready }: { ready: boolean }) {
  const [phase, setPhase] = useState<'show' | 'fading' | 'done'>('show')
  const [minElapsed, setMinElapsed] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), MIN_MS)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (phase !== 'show' || !ready || !minElapsed) return
    setPhase('fading')
    const t = setTimeout(() => setPhase('done'), FADE_MS)
    return () => clearTimeout(t)
  }, [ready, minElapsed, phase])

  if (phase === 'done') return null

  const base = import.meta.env.BASE_URL
  return (
    <div className={`splash ${phase === 'fading' ? 'splash--fading' : ''}`}>
      <div className="splash__inner">
        <img className="splash__fleet" src={`${base}fleet.jpg`} alt="Fleet" />
        <div className="splash__title">Fleet Commander</div>
        <img className="splash__logo" src={`${base}onecontact.png`} alt="OneContact" />
        <div className="splash__status">
          {ready ? (
            <span className="splash__ready">✓ Ready</span>
          ) : (
            <>
              <span className="splash__spinner" aria-hidden="true" />
              <span>Starting up…</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
