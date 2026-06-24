import { appendSourceToForm, type SourceState } from '../source/sourceModel'

export type ActionId = 'deploy' | 'apt_upgrade' | 'quick_diag' | 'custom_script' | 'threecx'
export type RunMode = 'universal' | 'test' | 'fallback'

export interface DeployConfigForm {
  version: string
  interface: string
  hep_server: string
  capture_mode: string
  discard_methods: string
  maxWorkers: number
  strictHostKeys: boolean
}

export type RootMode = 'none' | 'inline' | 'csv'

export interface CustomScriptArgs {
  content: string
  filename: string
  rootMode: RootMode
  rootPassword?: string
  rootColumn?: string
}

export interface BuildArgs {
  action: ActionId
  runMode: RunMode
  config: DeployConfigForm
  source: SourceState
  /** Required for runMode==='test'. */
  testPassword?: string
  /** Host labels to re-run for runMode==='fallback'. */
  fallbackHosts?: string[]
  /** Required when action==='custom_script'. */
  customScript?: CustomScriptArgs
  /** Required when action==='threecx' — the threecx_config object. */
  threecxConfig?: object
}

/**
 * Assemble the multipart form /api/deploy expects. Throws Error (user-facing)
 * when the source is incomplete. The deploy-only fields are harmless for the
 * apt/diag actions (the backend ignores them).
 */
export function buildDeployForm(args: BuildArgs): FormData {
  const { action, runMode, config, source } = args
  const fd = new FormData()
  fd.append('mode', runMode)
  fd.append('action', action)
  fd.append('version', config.version || 'latest')
  fd.append('interface', config.interface)
  fd.append('hep_server', config.hep_server)
  fd.append('capture_mode', config.capture_mode)
  fd.append('discard_methods', config.discard_methods)
  fd.append('max_workers', String(config.maxWorkers))
  if (config.strictHostKeys) fd.append('strict_host_keys', 'on')

  if (action === 'custom_script') {
    const cs = args.customScript
    if (!cs || !cs.content.trim()) {
      throw new Error('Provide a script to run (library, paste, or upload).')
    }
    fd.append('custom_script', new Blob([cs.content], { type: 'text/x-sh' }), cs.filename || 'script.sh')
    if (cs.rootMode === 'csv') {
      if (cs.rootColumn?.trim()) fd.append('root_password_column', cs.rootColumn.trim())
    } else if (cs.rootMode === 'inline') {
      if (cs.rootPassword) fd.append('root_password', cs.rootPassword)
    }
  }

  if (action === 'threecx') {
    if (!args.threecxConfig) throw new Error('3CX configuration is missing.')
    fd.append('threecx_config', JSON.stringify(args.threecxConfig))
  }

  appendSourceToForm(fd, source, {
    action,
    runMode,
    testPassword: args.testPassword,
  })

  if (runMode === 'fallback' && args.fallbackHosts?.length) {
    fd.append('fallback_hosts', JSON.stringify(args.fallbackHosts))
  }
  return fd
}
