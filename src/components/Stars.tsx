import { useMemo, type CSSProperties } from 'react'
import './stars.css'

/** Faint twinkling stars behind the night sky. Count scales with `density`. */
export function Stars({ density = 5 }: { density?: number }) {
  const stars = useMemo(() => {
    const d = Math.min(10, Math.max(1, density))
    const count = Math.round(d * d * 2.5) // 1→3, 5→63, 10→250 (rich sky at max)
    return Array.from({ length: count }, () => ({
      left: Math.random() * 100,
      top: Math.random() * 70,
      size: 1 + Math.random() * 1.6,
      delay: Math.random() * 6,
      dur: 2.6 + Math.random() * 4,
    }))
  }, [density])

  return (
    <div className="stars" aria-hidden="true">
      {stars.map((s, i) => (
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
