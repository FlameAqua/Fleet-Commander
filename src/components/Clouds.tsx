import './clouds.css'

/** Faint, slowly-drifting clouds for Day Mode. */
export function Clouds() {
  return (
    <div className="clouds" aria-hidden="true">
      <Cloud className="cloud cloud--a" />
      <Cloud className="cloud cloud--b" />
      <Cloud className="cloud cloud--c" />
    </div>
  )
}

function Cloud({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 120 50" xmlns="http://www.w3.org/2000/svg">
      <g fill="#ffffff">
        <ellipse cx="40" cy="34" rx="34" ry="16" />
        <ellipse cx="66" cy="28" rx="26" ry="18" />
        <ellipse cx="86" cy="34" rx="24" ry="14" />
        <ellipse cx="58" cy="38" rx="44" ry="12" />
      </g>
    </svg>
  )
}
