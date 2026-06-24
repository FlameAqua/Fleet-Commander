import './waves.css'

/** Calm, slowly-drifting water at the bottom of the app — a touch of soul. */
export function Waves() {
  return (
    <div className="waves" aria-hidden="true">
      {/* A small ship that occasionally sails across the water, left → right. */}
      <div className="ship">
        <svg className="ship__bob" viewBox="0 0 48 32" xmlns="http://www.w3.org/2000/svg">
          <line x1="23" y1="3" x2="23" y2="21" stroke="rgba(214,226,255,0.7)" strokeWidth="1" />
          <path d="M23 4 L35 20 L23 20 Z" fill="rgba(214,226,255,0.55)" />
          <path d="M23 6 L13 20 L23 20 Z" fill="rgba(214,226,255,0.35)" />
          <path d="M9 21 L39 21 L34 29 L14 29 Z" fill="rgba(120,150,220,0.75)" />
        </svg>
      </div>

      <svg className="waves__svg" viewBox="0 24 150 28" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <path
            id="fc-wave"
            d="M-160 44c30 0 58-18 88-18s58 18 88 18 58-18 88-18 58 18 88 18 v44h-352z"
          />
        </defs>
        <g className="waves__parallax">
          <use href="#fc-wave" x="48" y="0" className="waves__w1" />
          <use href="#fc-wave" x="48" y="3" className="waves__w2" />
          <use href="#fc-wave" x="48" y="5" className="waves__w3" />
          <use href="#fc-wave" x="48" y="7" className="waves__w4" />
        </g>
      </svg>
    </div>
  )
}
