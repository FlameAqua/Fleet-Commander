import { Suspense, lazy, type ComponentProps } from 'react'
import type { ScriptEditor as ScriptEditorType } from './ScriptEditor'
import './scriptEditor.css'

// CodeMirror is by far the heaviest thing the renderer imports, and most runs
// never open a script tab at all (3CX, Quick Diagnostic, Upgrade). Splitting it
// out keeps it off the initial load — which in dev is a per-restart transform
// cost, and in the packaged build is dead weight in the main chunk.
const ScriptEditorImpl = lazy(() =>
  import('./ScriptEditor').then((m) => ({ default: m.ScriptEditor })),
)

type Props = ComponentProps<typeof ScriptEditorType>

/** Drop-in for <ScriptEditor>, loaded on first use. */
export function ScriptEditor(props: Props) {
  return (
    <Suspense
      fallback={
        <div className={`se ${props.className ?? ''}`}>
          <div className="se__cm se__loading">Loading editor…</div>
        </div>
      }
    >
      <ScriptEditorImpl {...props} />
    </Suspense>
  )
}
