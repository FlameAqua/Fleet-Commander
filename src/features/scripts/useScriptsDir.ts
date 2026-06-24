import { useState } from 'react'

const STORAGE_KEY = 'bsm.scriptsDir'

/**
 * The operator's chosen scripts directory, persisted to localStorage.
 * Empty string means "use the backend default (~/AppData/.../scripts)".
 */
export function useScriptsDir() {
  const [dir, setDirState] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? ''
    } catch {
      return ''
    }
  })

  function setDir(value: string) {
    const next = (value || '').trim()
    setDirState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // localStorage unavailable — keep the in-memory value
    }
  }

  return { dir, setDir }
}
