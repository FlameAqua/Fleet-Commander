import { useMemo, type CSSProperties } from 'react'
import './rain.css'

/** Full-screen rain — summoned by flicking Day/Night too many times. */
export function Rain() {
  const drops = useMemo(
    () =>
      Array.from({ length: 110 }, () => ({
        left: Math.random() * 100,
        delay: Math.random() * 1.5,
        dur: 0.5 + Math.random() * 0.55,
        len: 12 + Math.random() * 20,
        opacity: 0.3 + Math.random() * 0.45,
      })),
    [],
  )
  return (
    <div className="rain" aria-hidden="true">
      {drops.map((d, i) => (
        <span
          key={i}
          className="rain__drop"
          style={
            {
              left: `${d.left}%`,
              height: `${d.len}px`,
              opacity: d.opacity,
              animationDelay: `${d.delay}s`,
              animationDuration: `${d.dur}s`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  )
}
