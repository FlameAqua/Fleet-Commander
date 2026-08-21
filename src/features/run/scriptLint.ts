// Pre-flight checks for a custom script. These are warnings, never blockers:
// the operator knows their fleet better than we do. The point is to catch the
// mistakes that are cheap to make on Windows and expensive to discover on 200
// live phone systems.
import type { ScriptInterpreter } from './deployForm'

export type LintLevel = 'danger' | 'warn' | 'info'

export interface LintFinding {
  level: LintLevel
  /** 1-based line the finding refers to, when it's line-specific. */
  line?: number
  message: string
}

/** `rm -rf /`, `rm -rf /*`, `rm -rf $UNSET/` — the classic fleet-wipers. */
const RM_ROOT_RE = /\brm\s+(-[A-Za-z]*\s+)*-[A-Za-z]*[rR][A-Za-z]*(\s+-[A-Za-z]+)*\s+\/(\s|\*|$)/
const MKFS_RE = /\b(mkfs(\.\w+)?|dd\s+if=\S+\s+of=\/dev\/)/
const SHUTDOWN_RE = /\b(reboot|shutdown|halt|poweroff|init\s+[06])\b/
const CURL_PIPE_SH_RE = /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/

/**
 * Inspect a script and return what's worth telling the operator before a run.
 * `interpreter` matters because RouterOS scripts are not POSIX shell — most of
 * the shell-specific advice would be noise there.
 */
export function lintScript(content: string, interpreter: ScriptInterpreter = 'auto'): LintFinding[] {
  const out: LintFinding[] = []
  const text = content ?? ''
  if (!text.trim()) return out

  // --- Portability -------------------------------------------------------
  if (text.includes('\r\n') || text.includes('\r')) {
    out.push({
      level: 'warn',
      message:
        'Windows line endings (CRLF) detected. They break shell scripts on Debian/OpenBSD — they will be converted to LF before the run.',
    })
  }

  const lines = text.split(/\r?\n/)

  if (interpreter !== 'routeros') {
    const first = lines.find((l) => l.trim())?.trim() ?? ''
    if (!first.startsWith('#!')) {
      out.push({
        level: 'info',
        message: 'No shebang — the script will run under `sh`. Add `#!/bin/bash` if you use bashisms.',
      })
    }
    const usesBashisms = /\[\[|\$\(\(|\barray\b|\bdeclare\s+-A|\+=\(/.test(text)
    if (usesBashisms && first.startsWith('#!') && !/bash|ksh|zsh/.test(first)) {
      out.push({
        level: 'warn',
        message: `Bash-only syntax with a "${first}" shebang — this will fail under a POSIX shell.`,
      })
    }
    if (!/\bset\s+-[a-z]*e/.test(text)) {
      out.push({
        level: 'info',
        message: 'No `set -e` — the script keeps going after a failing command, and the host still reports success.',
      })
    }
  }

  // --- Dangerous operations ---------------------------------------------
  lines.forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const at = i + 1
    if (RM_ROOT_RE.test(line)) {
      out.push({ level: 'danger', line: at, message: 'Recursive delete targeting `/` — this would wipe the system.' })
    }
    if (MKFS_RE.test(line)) {
      out.push({ level: 'danger', line: at, message: 'Formats a filesystem / writes to a raw device.' })
    }
    if (interpreter !== 'routeros' && SHUTDOWN_RE.test(line)) {
      out.push({ level: 'warn', line: at, message: 'Reboots or powers off the system — every selected host will go down.' })
    }
    if (CURL_PIPE_SH_RE.test(line)) {
      out.push({
        level: 'warn',
        line: at,
        message: 'Downloads and pipes straight to a shell — the remote content runs unreviewed, as root.',
      })
    }
    // `rm -rf $DIR/` with an unquoted variable becomes `rm -rf /` when unset.
    if (/\brm\b[^\n]*-[A-Za-z]*[rR]/.test(line) && /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\//.test(line) && !/"/.test(line)) {
      out.push({
        level: 'warn',
        line: at,
        message: 'Recursive delete with an unquoted variable path — if it is empty the path becomes `/`.',
      })
    }
  })

  return out
}

/**
 * Normalise a script for transmission: strip CR so a file authored on Windows
 * doesn't arrive with `\r` on every line (which makes the shebang parse fail
 * and appends CR to every variable), and strip a UTF-8 BOM for the same reason.
 */
export function normaliseScript(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}
