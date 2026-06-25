import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listShips, shipUrl } from '../api'
import './waves.css'

// --- Built-in ship art (randomly chosen alongside any custom clip-art) ----- //
function Sailboat() {
  return (
    <svg className="ship__bob" viewBox="0 0 48 32" xmlns="http://www.w3.org/2000/svg">
      <line className="ship__mast" x1="23" y1="3" x2="23" y2="21" strokeWidth="1" />
      <path className="ship__sail" d="M23 4 L35 20 L23 20 Z" />
      <path className="ship__sail2" d="M23 6 L13 20 L23 20 Z" />
      <path className="ship__hull" d="M9 21 L39 21 L34 29 L14 29 Z" />
    </svg>
  )
}

function Destroyer() {
  return (
    <svg className="ship__bob" viewBox="0 0 48 32" xmlns="http://www.w3.org/2000/svg">
      <path className="ship__hull" d="M2 23 L46 23 L42 28 L6 28 Z" />
      <path className="ship__hull" d="M18 15 L32 15 L32 23 L18 23 Z" />
      <path className="ship__hull" d="M23 10 L28 10 L28 15 L23 15 Z" />
      <path className="ship__hull" d="M9 20 L14 20 L14 23 L9 23 Z" />
      <path className="ship__hull" d="M35 20 L40 20 L40 23 L35 23 Z" />
      <line className="ship__mast" x1="25.5" y1="3" x2="25.5" y2="10" strokeWidth="1.3" />
    </svg>
  )
}

const DEFAULT_SHIPS = [Sailboat, Destroyer]

type Variant = { kind: 'art'; name: string } | { kind: 'default'; idx: number }

function pickVariant(pool: Variant[]): Variant {
  return pool[Math.floor(Math.random() * pool.length)] ?? { kind: 'default', idx: 0 }
}

/** Calm, slowly-drifting water at the bottom of the app — a touch of soul. */
export function Waves({ frequency = 4 }: { frequency?: number }) {
  // Custom clip-art dropped in the ships folder joins the built-in ships in
  // the random pool. Re-fetched when art is added (via the ships-changed event).
  const [arts, setArts] = useState<string[]>([])
  const refetch = useCallback(() => {
    listShips()
      .then((r) => setArts(r.ships))
      .catch(() => setArts([]))
  }, [])
  useEffect(() => {
    refetch()
    const onChange = () => refetch()
    const onVisible = () => {
      if (!document.hidden) refetch()
    }
    // Refresh on the app-side add event, and whenever the window regains focus
    // (covers files added/removed directly in the folder via Explorer).
    window.addEventListener('fc:ships-changed', onChange)
    window.addEventListener('focus', onChange)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('fc:ships-changed', onChange)
      window.removeEventListener('focus', onChange)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refetch])

  const pool = useMemo<Variant[]>(() => {
    const p: Variant[] = DEFAULT_SHIPS.map((_, idx) => ({ kind: 'default', idx }))
    for (const name of arts) p.push({ kind: 'art', name })
    return p
  }, [arts])

  // Frequency drives BOTH how many ships sail at once and the gap between a
  // ship's passes. 1 = rare (one ship, long gaps) → 10 = busy (a whole fleet).
  const f = Math.min(10, Math.max(1, frequency))
  const gapMs = Math.max(2500, (11 - f) * 4000)
  const count = Math.max(1, Math.min(8, Math.round(f * 0.8)))

  const slots = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        dir: (i % 2 === 0 ? 'ltr' : 'rtl') as 'ltr' | 'rtl',
        bottom: 16 + ((i * 5) % 18), // varied waterline depth, gives layering
        crossMs: 20000 + ((i * 3300) % 9000), // 20–29s, varied speed
      })),
    [count],
  )

  return (
    <div className="waves" aria-hidden="true">
      {slots.map((s, i) => (
        <Ship key={i} dir={s.dir} bottom={s.bottom} crossMs={s.crossMs} pool={pool} gapMs={gapMs} />
      ))}

      <svg className="waves__svg" viewBox="0 24 150 28" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <path
            id="fc-wave"
            d="M-160 44c30 0 58-18 88-18s58 18 88 18 58-18 88-18 58 18 88 18 v44h-352z"
          />
        </defs>
        <g className="waves__parallax">
          {/* Filler wave: half a wavelength (88) out of phase with w1 so its
              crests sit in w1's troughs — keeps the waterline full under the
              ships so they don't appear to float over the gaps. */}
          <use href="#fc-wave" x="136" y="5" className="waves__w0" />
          <use href="#fc-wave" x="48" y="0" className="waves__w1" />
          <use href="#fc-wave" x="48" y="3" className="waves__w2" />
          <use href="#fc-wave" x="48" y="5" className="waves__w3" />
          <use href="#fc-wave" x="48" y="7" className="waves__w4" />
        </g>
      </svg>
    </div>
  )
}

function Ship({
  dir,
  bottom,
  pool,
  crossMs,
  gapMs,
}: {
  dir: 'ltr' | 'rtl'
  bottom: number
  pool: Variant[]
  crossMs: number
  gapMs: number
}) {
  const [variant, setVariant] = useState<Variant>(() => pickVariant(pool))
  const [errored, setErrored] = useState(false)
  const [sailing, setSailing] = useState(false)
  const poolRef = useRef(pool)
  poolRef.current = pool
  const sailingRef = useRef(false)
  sailingRef.current = sailing
  const timer = useRef<number | undefined>(undefined)

  const launch = useCallback(() => {
    setVariant(pickVariant(poolRef.current))
    setErrored(false)
    setSailing(true)
  }, [])

  // When the available ships change (art added/removed), re-pick for any ship
  // that's parked so it adopts the new set instead of a now-deleted image.
  useEffect(() => {
    if (!sailingRef.current) {
      setVariant(pickVariant(pool))
      setErrored(false)
    }
  }, [pool])

  // (Re)schedule the next appearance whenever frequency changes — unless a
  // crossing is already in progress (don't interrupt it).
  useEffect(() => {
    if (sailingRef.current) return
    const delay = 400 + Math.random() * Math.min(gapMs, 6000)
    timer.current = window.setTimeout(launch, delay)
    return () => window.clearTimeout(timer.current)
  }, [gapMs, launch])

  const DefaultComp = DEFAULT_SHIPS[variant.kind === 'default' ? variant.idx : 0]

  return (
    <div
      className={`ship ship--${dir}${sailing ? ' is-sailing' : ''}`}
      style={{ bottom, animationDuration: `${crossMs}ms` }}
      onAnimationEnd={(e) => {
        if (e.animationName !== `fc-ship-cross-${dir}`) return
        setSailing(false)
        const delay = gapMs * (0.6 + Math.random() * 0.8) // jitter so it's not metronomic
        timer.current = window.setTimeout(launch, delay)
      }}
    >
      {sailing &&
        (variant.kind === 'art' && !errored ? (
          <img
            className="ship__bob ship__art"
            src={shipUrl(variant.name)}
            alt=""
            onError={() => setErrored(true)}
          />
        ) : (
          <DefaultComp />
        ))}
    </div>
  )
}
