import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import './prompt.css'

export interface PromptOptions {
  title?: string
  message: string
  password?: boolean
  placeholder?: string
  confirmLabel?: string
  /** Yes/No confirm — no input field; resolves 'ok' on confirm, null on cancel. */
  confirm?: boolean
  /** When set, render a single-choice list instead of a text input. */
  options?: { value: string; label: string }[]
}

type PromptFn = (opts: PromptOptions) => Promise<string | null>

const PromptCtx = createContext<PromptFn>(() => Promise.resolve(null))

/** Imperative text/password prompt (Electron has no window.prompt). */
export function usePrompt(): PromptFn {
  return useContext(PromptCtx)
}

export function PromptProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<PromptOptions | null>(null)
  const [value, setValue] = useState('')
  const resolverRef = useRef<((v: string | null) => void) | null>(null)

  const prompt: PromptFn = (o) =>
    new Promise((resolve) => {
      resolverRef.current = resolve
      setValue(o.options?.length ? o.options[0].value : '')
      setOpts(o)
    })

  function close(result: string | null) {
    setOpts(null)
    const resolve = resolverRef.current
    resolverRef.current = null
    resolve?.(result)
  }

  return (
    <PromptCtx.Provider value={prompt}>
      {children}
      {opts && (
        <div className="prompt__overlay" onMouseDown={() => close(null)}>
          <form
            className="prompt__box"
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              close(opts.confirm ? 'ok' : value)
            }}
          >
            {opts.title && <h3 className="prompt__title">{opts.title}</h3>}
            <p className="prompt__msg">{opts.message}</p>
            {opts.confirm ? null : opts.options?.length ? (
              <div className="prompt__choices">
                {opts.options.map((o) => (
                  <label key={o.value} className="prompt__choice">
                    <input
                      type="radio"
                      name="prompt-choice"
                      checked={value === o.value}
                      onChange={() => setValue(o.value)}
                    />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
            ) : (
              <input
                autoFocus
                type={opts.password ? 'password' : 'text'}
                value={value}
                placeholder={opts.placeholder}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') close(null)
                }}
              />
            )}
            <div className="prompt__actions">
              <button type="button" className="prompt__btn" onClick={() => close(null)}>
                Cancel
              </button>
              <button type="submit" className="prompt__btn prompt__btn--primary">
                {opts.confirmLabel ?? 'OK'}
              </button>
            </div>
          </form>
        </div>
      )}
    </PromptCtx.Provider>
  )
}
