import './aurora.css'

/** A very gentle aurora borealis across the top of the night sky. */
export function Aurora() {
  return (
    <div className="aurora" aria-hidden="true">
      <div className="aurora__band aurora__band--1" />
      <div className="aurora__band aurora__band--2" />
      <div className="aurora__band aurora__band--3" />
    </div>
  )
}
