import type { CSSProperties } from 'react'
import './stars.css'

// Generated once for the app's lifetime — stable positions, staggered twinkle.
const STARS = Array.from({ length: 56 }, () => ({
  left: Math.random() * 100,
  top: Math.random() * 70,
  size: 1 + Math.random() * 1.6,
  delay: Math.random() * 6,
  dur: 2.6 + Math.random() * 4,
}))

/** Faint twinkling stars drifting in the night sky behind the app. */
export function Stars() {
  return (
    <div className="stars" aria-hidden="true">
      {STARS.map((s, i) => (
        <span
          key={i}
          className="star"
          style={
            {
              left: `${s.left}%`,
              top: `${s.top}%`,
              width: `${s.size}px`,
              height: `${s.size}px`,
              '--delay': `${s.delay}s`,
              '--dur': `${s.dur}s`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  )
}
