// The "Step 1 — Source" model: where the fleet's targets + credentials come
// from, and how to turn that into the multipart fields /api/deploy expects.
//
// Modes:
//   compound — one imported CSV (column-mapped, extra cols → host_vars); the
//              operator picks which hosts changes apply to via `excluded`
//   manual   — type-in rows (url/user/password) → virtual ssh + pass CSVs
//   test     — the hardcoded TEST_HOST; password is prompted at run time
import {
  buildCanonicalKeepass,
  buildManualCsvs,
  canonicalCsvFromEntries,
  type ColumnOverrides,
  type ManualRow,
} from '../../lib/csv'

export interface LoadedFile {
  name: string
  text: string
  /** True when this CSV was decrypted from an `.enc` (no plaintext file on disk). */
  fromEncrypted?: boolean
}

export interface CompoundSource {
  mode: 'compound'
  file: LoadedFile | null
  overrides: ColumnOverrides
  useLogin: boolean
  /** Host labels the operator unticked — changes are NOT applied to these. */
  excluded: string[]
}

export interface ManualSource {
  mode: 'manual'
  rows: ManualRow[]
}

export interface TestSource {
  mode: 'test'
}

export type SourceState = CompoundSource | ManualSource | TestSource
export type SourceMode = SourceState['mode']

export function emptySource(mode: SourceMode): SourceState {
  switch (mode) {
    case 'compound':
      return { mode, file: null, overrides: {}, useLogin: false, excluded: [] }
    case 'manual':
      return { mode, rows: [{ url: '', user: '', password: '' }] }
    case 'test':
      return { mode }
  }
}

export interface BuildSourceArgs {
  /** Action being run — controls whether host_vars are attached. */
  action: string
  /** Run mode: 'universal' | 'test' | 'fallback'. */
  runMode: 'universal' | 'test' | 'fallback'
  /** For 3CX csv password mode — expose the password column under this name. */
  forcePwCol?: string | null
  /** Required when source.mode === 'test' (prompted from the operator). */
  testPassword?: string
}

function blob(text: string, type = 'text/csv'): Blob {
  return new Blob([text], { type })
}

/**
 * Append the source-specific multipart fields to `fd`. Throws Error with a
 * user-facing message when the source is incomplete/invalid.
 */
export function appendSourceToForm(fd: FormData, source: SourceState, args: BuildSourceArgs): void {
  if (args.runMode === 'test') {
    if (!args.testPassword) throw new Error('Password required for the test run.')
    fd.append('test_password', args.testPassword)
    return
  }

  switch (source.mode) {
    case 'compound': {
      if (!source.file) throw new Error('Select a CSV first.')
      const res = buildCanonicalKeepass(source.file.text, {
        overrides: source.overrides,
        useLogin: source.useLogin,
        forcePwCol: args.forcePwCol ?? null,
      })
      const excluded = new Set(source.excluded)
      const applied = res.entries.filter((e) => !excluded.has(e.label))
      if (!applied.length) throw new Error('Select at least one system to apply changes to.')
      fd.append('keepass_csv', blob(canonicalCsvFromEntries(applied)), source.file.name)
      if (args.action === 'custom_script' || args.action === 'threecx') {
        const hostVars: Record<string, Record<string, string>> = {}
        for (const e of applied) {
          if (res.hostVars[e.label]) hostVars[e.label] = res.hostVars[e.label]
        }
        if (Object.keys(hostVars).length) fd.append('host_vars', JSON.stringify(hostVars))
      }
      return
    }
    case 'manual': {
      const { sshText, passText } = buildManualCsvs(source.rows)
      fd.append('ssh_csv', blob(sshText), 'manual-urls.csv')
      fd.append('pass_csv', blob(passText), 'manual-passwords.csv')
      return
    }
    case 'test':
      // handled above when runMode === 'test'; a non-test run with a test
      // source is a misconfiguration.
      throw new Error('Test Host source requires the Test run mode.')
  }
}
