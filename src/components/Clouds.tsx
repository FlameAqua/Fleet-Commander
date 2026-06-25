import { useMemo, type CSSProperties } from 'react'
import './clouds.css'

/** Faint, slowly-drifting clouds for Day Mode. Count scales with `density`. */
export function Clouds({ density = 5 }: { density?: number }) {
  const clouds = useMemo(() => {
    const count = Math.round(Math.min(10, Math.max(1, density)) * 2.2) // 1→2, 5→11, 10→22
    return Array.from({ length: count }, () => ({
      top: 2 + Math.random() * 40,
      width: 150 + Math.random() * 190,
      opacity: 0.5 + Math.random() * 0.35,
      dur: 90 + Math.random() * 110,
      delay: -Math.random() * 160,
      rtl: Math.random() < 0.4,
    }))
  }, [density])

  return (
    <div className="clouds" aria-hidden="true">
      {clouds.map((c, i) => (
        <svg
          key={i}
          className={`cloud${c.rtl ? ' cloud--rtl' : ''}`}
          viewBox="0 0 120 50"
          xmlns="http://www.w3.org/2000/svg"
          style={
            {
              top: `${c.top}%`,
              width: `${c.width}px`,
              opacity: c.opacity,
              animationDuration: `${c.dur}s`,
              animationDelay: `${c.delay}s`,
            } as CSSProperties
          }
        >
          <g fill="#ffffff">
            <ellipse cx="40" cy="34" rx="34" ry="16" />
            <ellipse cx="66" cy="28" rx="26" ry="18" />
            <ellipse cx="86" cy="34" rx="24" ry="14" />
            <ellipse cx="58" cy="38" rx="44" ry="12" />
          </g>
        </svg>
      ))}
    </div>
  )
}
