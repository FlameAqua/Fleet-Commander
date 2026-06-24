import type { CSSProperties } from 'react'
import './segmented.css'

export interface SegOption<T extends string> {
  id: T
  label: string
}

/** Segmented pill control with an indicator that slides smoothly to the active option. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly SegOption<T>[]
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
}) {
  const idx = Math.max(0, options.findIndex((o) => o.id === value))
  const style = { '--seg-count': options.length, '--seg-index': idx } as CSSProperties
  return (
    <div className="seg" role="tablist" aria-label={ariaLabel} style={style}>
      <span className="seg__slider" aria-hidden="true" />
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          className={value === o.id ? 'is-active' : ''}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
