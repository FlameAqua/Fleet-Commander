import { useEffect, useRef, useState } from 'react'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { tags } from '@lezer/highlight'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
} from '@codemirror/view'
import { useToast } from './ToastProvider'
import './scriptEditor.css'

const VARIABLES_HELP =
  'Use your CSV column titles as per-system variables — type $ to insert one (e.g. $SiteCode). Each host gets that column’s value.'

type Interpreter = 'auto' | 'routeros'

// Placeholder examples per interpreter. When the interpreter picker is shown,
// switching it swaps these so RouterOS users see MikroTik-style examples.
const PLACEHOLDERS: Record<Interpreter, string> = {
  auto: [
    '#!/bin/bash',
    'set -e',
    'echo "Hello from $(hostname)"',
    '',
    '# Type $ for your CSV column names — each host gets its own value,',
    '#   e.g. echo "$Account is at $Web_Site"',
    '# Ctrl+F to find & replace.',
  ].join('\n'),
  routeros: [
    '# RouterOS — commands run straight on the MikroTik console',
    '/system resource print',
    '/system identity print',
    '/interface print',
    '',
    '# Ctrl+F to find & replace.',
  ].join('\n'),
}

/**
 * Colours come from the app's theme variables so the editor follows Day/Night
 * without a second palette. `.cm-*` classes are CodeMirror's own.
 */
const themeExt = EditorView.theme({
  '&': {
    fontSize: '0.85rem',
    backgroundColor: 'var(--code-bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
  },
  '&.cm-focused': { outline: 'none', borderColor: 'var(--accent)' },
  '.cm-content': { fontFamily: 'var(--mono)', padding: '0.5rem 0' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted)',
    border: 'none',
    fontFamily: 'var(--mono)',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(127, 127, 127, 0.08)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(142, 162, 255, 0.28)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--text-h)' },
  '.cm-placeholder': { color: 'var(--muted)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    color: 'var(--text)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'rgba(142, 162, 255, 0.2)',
    color: 'var(--text-h)',
  },
  '.cm-searchMatch': { backgroundColor: 'rgba(224, 176, 79, 0.35)', borderRadius: '2px' },
  '.cm-searchMatch-selected': { backgroundColor: 'rgba(224, 176, 79, 0.65)' },

  // --- Find & replace panel -------------------------------------------------
  // CodeMirror ships an unstyled browser-default panel; dress it to match the
  // app's controls (pill inputs, panel background, accent focus ring).
  '.cm-panels': {
    backgroundColor: 'var(--panel)',
    color: 'var(--text)',
    border: 'none',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  // Block flow, not flex: CodeMirror separates the find and replace rows with a
  // plain <br>, which a flex container would ignore (and a flex item with
  // basis:100% still shrinks onto the same line). Inline children + the <br>
  // give the original two-row layout, just restyled.
  '.cm-panel.cm-search': {
    position: 'relative',
    padding: '0.85rem 2.4rem 0.9rem 0.9rem',
    fontFamily: 'var(--sans)',
    fontSize: '0.8rem',
    // Drives the gap between the find and replace rows (block flow, so the
    // line box is what separates them).
    lineHeight: '2.9',
  },
  '.cm-panel.cm-search .cm-textfield': {
    font: 'inherit',
    verticalAlign: 'middle',
    margin: '0 0.6rem 0 0',
    padding: '0.4rem 0.65rem',
    minWidth: '200px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
  },
  '.cm-panel.cm-search .cm-textfield:focus': {
    outline: 'none',
    borderColor: 'var(--accent)',
  },
  '.cm-panel.cm-search button[name]': {
    font: 'inherit',
    verticalAlign: 'middle',
    margin: '0 0.45rem 0 0',
    padding: '0.34rem 0.85rem',
    border: '1px solid var(--border)',
    borderRadius: '999px',
    backgroundColor: 'rgba(127, 127, 127, 0.12)',
    backgroundImage: 'none',
    color: 'var(--text)',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search button[name]:hover': {
    borderColor: 'var(--accent)',
    color: 'var(--text-h)',
  },
  '.cm-panel.cm-search label': {
    verticalAlign: 'middle',
    margin: '0 0.85rem 0 0.25rem',
    color: 'var(--muted)',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search label input': {
    verticalAlign: 'middle',
    margin: '0 0.25rem 0 0',
    cursor: 'pointer',
  },
  // The close [x] sits in the corner by default and overlaps the inputs.
  '.cm-panel.cm-search button[name="close"]': {
    position: 'absolute',
    top: '0.5rem',
    right: '0.6rem',
    padding: '0.1rem 0.45rem',
    border: 'none',
    borderRadius: '6px',
    background: 'none',
    color: 'var(--muted)',
    fontSize: '1.05rem',
    lineHeight: 1,
  },
  '.cm-panel.cm-search button[name="close"]:hover': {
    color: 'var(--text-h)',
    backgroundColor: 'rgba(127, 127, 127, 0.16)',
  },
})

/**
 * Token colours come from CSS variables (index.css defines a set per theme), so
 * highlighting stays readable on both the Day and Night backgrounds.
 */
const highlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--tok-comment)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword], color: 'var(--tok-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--tok-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--tok-number)' },
  { tag: [tags.variableName, tags.propertyName], color: 'var(--tok-variable)' },
  { tag: [tags.atom, tags.definition(tags.variableName)], color: 'var(--tok-variable)' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: 'var(--tok-function)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--tok-operator)' },
  { tag: tags.meta, color: 'var(--tok-meta)' },
  { tag: tags.invalid, color: 'var(--error-text)' },
])

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
  /** Fired when the editor gains focus (used for a one-off first-use tip). */
  onFocus?: () => void
}

/**
 * Script editor: CodeMirror with shell highlighting, line numbers, undo/redo,
 * find (Ctrl+F) and a `$`-triggered dropdown of the CSV's per-system variables.
 * Tab indents rather than moving focus — this is a code field, not a form field.
 */
export function ScriptEditor({
  value,
  onChange,
  variables,
  placeholder,
  className,
  interpreter = 'auto',
  onInterpreterChange,
  onFocus,
}: Props) {
  const toast = useToast()
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [interpOpen, setInterpOpen] = useState(false)

  // Read through refs inside CodeMirror callbacks: the view is created once, so
  // it must never close over a stale render's props.
  const onChangeRef = useRef(onChange)
  const onFocusRef = useRef(onFocus)
  const varsRef = useRef(variables)
  useEffect(() => {
    onChangeRef.current = onChange
    onFocusRef.current = onFocus
    varsRef.current = variables
  })

  // Parts that change with props get their own compartment so they can be
  // reconfigured without tearing down the editor (and losing undo history).
  const [langComp] = useState(() => new Compartment())
  const [phComp] = useState(() => new Compartment())

  const effectivePlaceholder = onInterpreterChange ? PLACEHOLDERS[interpreter] : (placeholder ?? '')

  useEffect(() => {
    if (!host.current || view.current) return

    /** `$` + partial name → the CSV's column variables. */
    function completeVariable(ctx: CompletionContext): CompletionResult | null {
      const before = ctx.matchBefore(/\$[A-Za-z0-9_]*/)
      if (!before || (before.from === before.to && !ctx.explicit)) return null
      const names = varsRef.current
      if (!names.length) return null
      return {
        from: before.from,
        options: names.map((v) => ({ label: '$' + v, type: 'variable' })),
        validFor: /^\$[A-Za-z0-9_]*$/,
      }
    }

    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          bracketMatching(),
          closeBrackets(),
          search({ top: true }),
          highlightSelectionMatches(),
          autocompletion({ override: [completeVariable] }),
          // Tab indents inside the editor (Escape then Tab still moves focus).
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          indentUnit.of('  '),
          EditorView.lineWrapping,
          themeExt,
          syntaxHighlighting(highlightStyle),
          langComp.of([]),
          phComp.of(cmPlaceholder(effectivePlaceholder)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
            if (u.focusChanged && u.view.hasFocus) onFocusRef.current?.()
          }),
        ],
      }),
    })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // Mount once — later prop changes are pushed in through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Controlled value: only write back when the prop genuinely diverges (e.g. a
  // library script was loaded), otherwise every keystroke would reset the caret.
  useEffect(() => {
    const v = view.current
    if (!v) return
    const current = v.state.doc.toString()
    if (current === value) return
    v.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  // RouterOS commands aren't POSIX shell, so don't pretend to highlight them.
  useEffect(() => {
    view.current?.dispatch({
      effects: langComp.reconfigure(
        interpreter === 'routeros' ? [] : StreamLanguage.define(shell),
      ),
    })
  }, [interpreter, langComp])

  useEffect(() => {
    view.current?.dispatch({ effects: phComp.reconfigure(cmPlaceholder(effectivePlaceholder)) })
  }, [effectivePlaceholder, phComp])

  return (
    <div className={`se ${className ?? ''}`}>
      {onInterpreterChange && (
        <>
          <button
            type="button"
            className={`se__cmd${interpreter === 'routeros' ? ' is-active' : ''}`}
            tabIndex={-1}
            title={`Interpreter: ${interpreter === 'routeros' ? 'RouterOS (MikroTik)' : 'Auto-detect shell (bash / sh) — not RouterOS'}`}
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
                    Auto-detect shell (bash / sh)
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
        aria-label="How variables work"
        onClick={() => toast(VARIABLES_HELP, 'tip')}
      >
        ?
      </button>
      <div className="se__cm" ref={host} />
    </div>
  )
}
