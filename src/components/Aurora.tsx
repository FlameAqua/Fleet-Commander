import type { CSSProperties } from 'react'
import './aurora.css'

/** A very gentle aurora borealis across the top of the night sky. `intensity`
 *  (1–10) scales the band brightness. */
export function Aurora({ intensity = 5 }: { intensity?: number }) {
  const mul = Math.min(10, Math.max(1, intensity)) / 3.2 // 1→0.3, 5→1.6, 10→3.1 (vivid)
  return (
    <div className="aurora" aria-hidden="true" style={{ '--aurora-mul': mul } as CSSProperties}>
      <div className="aurora__band aurora__band--1" />
      <div className="aurora__band aurora__band--2" />
      <div className="aurora__band aurora__band--3" />
    </div>
  )
}
