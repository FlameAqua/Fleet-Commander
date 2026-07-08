import { useRef, useState } from 'react'
import './scriptEditor.css'

interface Menu {
  left: number
  top: number
  query: string
}

// Compute the pixel position of a caret index inside a textarea, using a hidden
// mirror element that replicates the textarea's text layout.
function caretXY(ta: HTMLTextAreaElement, index: number): { left: number; top: number } {
  const div = document.createElement('div')
  const cs = getComputedStyle(ta)
  const props = [
    'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'textTransform',
  ] as const
  for (const p of props) div.style[p as never] = cs[p as never]
  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.whiteSpace = 'pre-wrap'
  div.style.wordWrap = 'break-word'
  div.style.overflowWrap = 'break-word'
  div.textContent = ta.value.slice(0, index)
  const span = document.createElement('span')
  span.textContent = ta.value.slice(index) || '.'
  div.appendChild(span)
  document.body.appendChild(div)
  const left = span.offsetLeft
  const top = span.offsetTop
  document.body.removeChild(div)
  return { left, top }
}

type Interpreter = 'auto' | 'routeros'

// Placeholder examples per interpreter. When the interpreter picker is shown,
// switching it swaps these so RouterOS users see MikroTik-style examples.
const PLACEHOLDERS: Record<Interpreter, string> = {
  auto: '#!/bin/bash\nset -e\necho "Hello from $(hostname)"',
  routeros:
    '# RouterOS — commands run straight on the MikroTik console\n' +
    '/system resource print\n' +
    '/system identity print\n' +
    '/interface print',
}

interface Props {
  value: string
  onChange: (v: string) => void
  /** Per-system variable names available from a Compound CSV (no `$`). */
  variables: string[]
  placeholder?: string
  className?: string
  /** When provided, a cmd icon (left of the `?`) lets the operator pick the interpreter. */
  interpreter?: Interpreter
  onInterpreterChange?: (i: Interpreter) => void
}

/** Script textarea with a `$`-triggered variable dropdown and a help hint. */
export function ScriptEditor({
  value,
  onChange,
  variables,
  placeholder,
  className,
  interpreter = 'auto',
  onInterpreterChange,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [interpOpen, setInterpOpen] = useState(false)

  function refreshMenu(ta: HTMLTextAreaElement) {
    if (!variables.length) {
      setMenu(null)
      return
    }
    const pos = ta.selectionStart
    const before = ta.value.slice(0, pos)
    const m = /\$([A-Za-z0-9_]*)$/.exec(before)
    if (!m) {
      setMenu(null)
      return
    }
    const dollarIdx = pos - m[0].length
    const xy = caretXY(ta, dollarIdx)
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18
    setMenu({ left: xy.left, top: xy.top - ta.scrollTop + lh + 2, query: m[1].toLowerCase() })
  }

  function insert(name: string) {
    const ta = ref.current
    if (!ta) return
    const pos = ta.selectionStart
    const before = ta.value.slice(0, pos)
    const m = /\$([A-Za-z0-9_]*)$/.exec(before)
    const start = pos - (m ? m[0].length : 0)
    const next = ta.value.slice(0, start) + '$' + name + ta.value.slice(pos)
    onChange(next)
    setMenu(null)
    requestAnimationFrame(() => {
      ta.focus()
      const c = start + name.length + 1
      ta.setSelectionRange(c, c)
    })
  }

  const filtered = menu ? variables.filter((v) => v.toLowerCase().includes(menu.query)).slice(0, 10) : []

  // When the interpreter picker is present, the interpreter drives the
  // placeholder (RouterOS shows MikroTik examples); otherwise honour the prop.
  const effectivePlaceholder = onInterpreterChange ? PLACEHOLDERS[interpreter] : placeholder

  return (
    <div className={`se ${className ?? ''}`}>
      {onInterpreterChange && (
        <>
          <button
            type="button"
            className={`se__cmd${interpreter === 'routeros' ? ' is-active' : ''}`}
            tabIndex={-1}
            title={`Interpreter: ${interpreter === 'routeros' ? 'RouterOS (MikroTik)' : 'Auto-detect (bash / sh)'}`}
            onClick={() => setInterpOpen((o) => !o)}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
              <rect x="2.5" y="4" width="19" height="16" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="M6 9 l3 2.6 -3 2.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="11.5" y1="15" x2="16" y2="15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
          {interpOpen && (
            <>
              <div className="se__interpback" onClick={() => setInterpOpen(false)} />
              <ul className="se__interpmenu" role="menu">
                <li>
                  <button
                    type="button"
                    className={interpreter === 'auto' ? 'is-sel' : ''}
                    onClick={() => { onInterpreterChange('auto'); setInterpOpen(false) }}
                  >
                    Auto-detect (bash / sh)
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    className={interpreter === 'routeros' ? 'is-sel' : ''}
                    onClick={() => { onInterpreterChange('routeros'); setInterpOpen(false) }}
                  >
                    RouterOS (MikroTik)
                  </button>
                </li>
              </ul>
            </>
          )}
        </>
      )}
      <button
        type="button"
        className="se__help"
        tabIndex={-1}
        title={
          'You can use your CSV column titles as per-system variables. Type $ to insert one ' +
          '(e.g. $SiteCode), and the value for each host comes from that column in your CSV.'
        }
      >
        ?
      </button>
      <textarea
        ref={ref}
        className="se__ta"
        value={value}
        placeholder={effectivePlaceholder}
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value)
          refreshMenu(e.target)
        }}
        onKeyUp={(e) => refreshMenu(e.currentTarget)}
        onClick={(e) => refreshMenu(e.currentTarget)}
        onScroll={(e) => menu && refreshMenu(e.currentTarget)}
        onBlur={() => setTimeout(() => setMenu(null), 150)}
      />
      {menu && filtered.length > 0 && (
        <ul className="se__menu" style={{ left: menu.left, top: menu.top }}>
          {filtered.map((v) => (
            <li key={v}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); insert(v) }}>
                ${v}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
