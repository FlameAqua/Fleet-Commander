import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { apiGet, authCheck, getConfig, type AuthResult } from './api'
import { buildCanonicalKeepass, csvVariableNames } from './lib/csv'
import { SourcePanel } from './features/source/SourcePanel'
import { emptySource, type SourceMode, type SourceState } from './features/source/sourceModel'
import { ActionPanel } from './features/run/ActionPanel'
import { ResultsPanel } from './features/run/ResultsPanel'
import { useDeployRun } from './features/run/useDeployRun'
import { buildDeployForm, type ActionId, type DeployConfigForm, type RunMode } from './features/run/deployForm'
import { selectedHosts, restrictToHost, restrictToHosts, deselectHosts, chunk } from './features/run/hosts'
import { assessRisk, type RiskAssessment } from './features/run/riskAssessment'
import { loadExitCategories, saveExitCategories, type ExitCategory } from './features/run/exitCategories'
import {
  CustomScriptPanel,
  emptyCustomScript,
  resolveCustomScript,
  type CustomScriptState,
} from './features/run/CustomScriptPanel'
import { ThreecxPanel } from './features/threecx/ThreecxPanel'
import {
  buildQuickActionConfig,
  buildThreecxConfig,
  emptyThreecx,
  targetCount,
  type QuickAction,
  type ThreecxOperation,
  type ThreecxState,
} from './features/threecx/threecxModel'
import { usePrompt } from './components/PromptProvider'
import { Splash } from './components/Splash'
import { Stars } from './components/Stars'
import { Aurora } from './components/Aurora'
import { Clouds } from './components/Clouds'
import { Waves } from './components/Waves'
import { Rain } from './components/Rain'
import { WindowControls } from './components/WindowControls'
import { CsvGuide } from './components/CsvGuide'
import { Settings, DEFAULT_ANIM, DEFAULT_FX, type AnimPrefs, type FxLevels } from './components/Settings'
import { UpdateBanner } from './components/UpdateBanner'
import './App.css'

type Theme = 'night' | 'day'

type Health = 'checking' | 'ok' | 'down'
type Step = 'source' | 'action' | 'results'

const STAGES: { id: Step; label: string }[] = [
  { id: 'source', label: 'Choose your Fleet' },
  { id: 'action', label: 'Choose Action' },
  { id: 'results', label: 'Voyage Results' },
]

const INITIAL_CONFIG: DeployConfigForm = {
  version: 'latest',
  interface: '',
  hep_server: '',
  capture_mode: '',
  discard_methods: '',
  maxWorkers: 10,
  strictHostKeys: false,
}

interface LastRun {
  src: SourceState
  pw?: string
  op?: ThreecxOperation
  act: ActionId
  tcxConfig?: object
}

function App() {
  const [health, setHealth] = useState<Health>('checking')
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem('fc.theme') === 'day' ? 'day' : 'night'
    } catch {
      return 'night'
    }
  })
  // Each decorative animation can be toggled independently (e.g. over RDP,
  // where GPU compositing is limited and they render broken). Persisted as
  // JSON per machine; merged with defaults so new keys turn on by default.
  const [anim, setAnim] = useState<AnimPrefs>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('fc.anim') || '{}')
      return { ...DEFAULT_ANIM, ...saved }
    } catch {
      return DEFAULT_ANIM
    }
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Easter egg: flicking Day/Night too fast makes it rain (click the drop to clear).
  const [rainMode, setRainMode] = useState(false)
  const themeFlicks = useRef<number[]>([])
  const rainStart = useRef(0)
  const [fx, setFx] = useState<FxLevels>(() => {
    try {
      return { ...DEFAULT_FX, ...JSON.parse(localStorage.getItem('fc.fx') || '{}') }
    } catch {
      return DEFAULT_FX
    }
  })
  const [shipFreq, setShipFreq] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem('fc.shipFreq') || '', 10)
      return Number.isFinite(v) ? Math.min(10, Math.max(1, v)) : 5
    } catch {
      return 5
    }
  })
  const [exitCategories, setExitCategories] = useState<ExitCategory[]>(() => loadExitCategories())
  const [testHost, setTestHost] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('source')
  // Per-mode source state so switching tabs doesn't wipe your selection.
  const [sourceMode, setSourceMode] = useState<SourceMode>('compound')
  const [sourceStates, setSourceStates] = useState<Record<SourceMode, SourceState>>(() => ({
    compound: emptySource('compound'),
    manual: emptySource('manual'),
    test: emptySource('test'),
  }))
  const [testPassword, setTestPassword] = useState('')
  const [action, setAction] = useState<ActionId>('custom_script')
  const [config, setConfig] = useState<DeployConfigForm>(INITIAL_CONFIG)
  const [customScript, setCustomScript] = useState<CustomScriptState>(() => emptyCustomScript())
  const [threecx, setThreecx] = useState<ThreecxState>(() => emptyThreecx())
  const [runError, setRunError] = useState<string | null>(null)
  const run = useDeployRun()
  const prompt = usePrompt()
  const lastRunRef = useRef<LastRun | null>(null)

  const source = sourceStates[sourceMode]
  const setSource = (s: SourceState) => setSourceStates((prev) => ({ ...prev, [s.mode]: s }))

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('fc.theme', theme)
    } catch {
      /* ignore */
    }
  }, [theme])

  useEffect(() => {
    // Panel-transition toggle drives the CSS; persist the whole prefs object.
    document.documentElement.dataset.anim = anim.panel ? 'on' : 'off'
    try {
      localStorage.setItem('fc.anim', JSON.stringify(anim))
    } catch {
      /* ignore */
    }
  }, [anim])

  useEffect(() => {
    try {
      localStorage.setItem('fc.shipFreq', String(shipFreq))
    } catch {
      /* ignore */
    }
  }, [shipFreq])

  useEffect(() => {
    saveExitCategories(exitCategories)
  }, [exitCategories])

  useEffect(() => {
    try {
      localStorage.setItem('fc.fx', JSON.stringify(fx))
    } catch {
      /* ignore */
    }
  }, [fx])

  useEffect(() => {
    document.documentElement.dataset.rain = rainMode ? 'on' : 'off'
  }, [rainMode])

  useEffect(() => {
    let cancelled = false
    apiGet('/api/scripts')
      .then(() => !cancelled && setHealth('ok'))
      .catch(() => !cancelled && setHealth('down'))
    getConfig()
      .then((c) => {
        if (cancelled) return
        setTestHost(c.test_host)
        setConfig((prev) => ({
          ...prev,
          interface: c.defaults.interface,
          hep_server: c.defaults.hep_server,
          capture_mode: c.defaults.capture_mode,
          discard_methods: c.defaults.discard_methods,
          maxWorkers: c.defaults.max_workers,
        }))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Per-system variables available to custom scripts (Compound CSV column names).
  // Test/Manual have no CSV, but the backend mirrors each host's SSH password
  // into $Password for them, so offer that one.
  const availableVars = useMemo(
    () =>
      source.mode === 'compound'
        ? source.file
          ? csvVariableNames(source.file.text)
          : []
        : ['Password'],
    [source],
  )

  // Map each host's canonical label → its title/account, to show in results.
  const resultTitles = useMemo<Record<string, string>>(() => {
    if (source.mode !== 'compound' || !source.file) return {}
    try {
      const { entries } = buildCanonicalKeepass(source.file.text, {
        overrides: source.overrides,
        useLogin: source.useLogin,
      })
      const m: Record<string, string> = {}
      for (const e of entries) if (e.name && e.name !== e.label) m[e.label] = e.name
      return m
    } catch {
      return {}
    }
  }, [source])

  const isTest = source.mode === 'test'
  const hostCount = isTest ? 1 : selectedHosts(source).length
  const canProceed = isTest || hostCount > 0
  const systemsLabel = isTest ? 'the test host' : `${hostCount} system${hostCount === 1 ? '' : 's'}`
  // Newline-separated list of every selected system, for a native tooltip.
  const systemsTooltip = (isTest ? [testHost ?? 'test host'] : selectedHosts(source).map((h) => h.label)).join('\n')
  // Signature of a selection — used to cache/invalidate validation results.
  const sigForSource = (src: SourceState): string =>
    src.mode === 'test' ? `test:${testHost ?? ''}` : selectedHosts(src).map((h) => h.value).sort().join('|')
  const selectionSig = sigForSource(source)

  function onModeChange(m: SourceMode) {
    setSourceMode(m)
  }

  // Advancing to Step 2 asks for the Test-host password once (reused per run).
  async function continueToActions() {
    if (isTest && !testPassword) {
      const pw = await prompt({
        title: 'Test host password',
        message: `Enter the password for ${testHost ?? 'the test host'} (reused for every action):`,
        password: true,
        confirmLabel: 'Continue',
      })
      if (!pw) return
      setTestPassword(pw)
    }
    // Nudge to validate connections first — but only when advancing from the
    // fleet step. Navigating back to Actions from Results must never re-prompt.
    if (step === 'source' && !isTest && !hasValidatedCurrent) {
      const choice = await prompt({
        title: 'Continue without validating?',
        message:
          "You haven't validated the SSH connections for these systems yet. Validate them first, or continue anyway?",
        options: [
          { value: 'validate', label: 'Validate connections first' },
          { value: 'continue', label: 'Continue anyway' },
        ],
        confirmLabel: 'OK',
      })
      if (choice === null) return
      if (choice === 'validate') {
        onValidateClick()
        return
      }
    }
    setStep('action')
  }

  // Which roadmap stages are reachable right now (for the top stepper).
  function stageReachable(id: Step): boolean {
    if (id === 'source') return true
    if (id === 'action') return canProceed
    return run.status !== 'idle' || run.cards.length > 0
  }

  // Reset to a fresh boot: clears the loaded fleet, chosen action, and results.
  // A reload is the most faithful "as if you rebooted" — settings persist via
  // localStorage, and the in-memory fleet/action/results state is wiped.
  async function resetApp() {
    const ok = await prompt({
      title: 'Reset app?',
      message:
        'This clears your loaded fleet, selected action, and results — like restarting the app. Your settings (theme, folders, animations) are kept.',
      confirm: true,
      confirmLabel: 'Reset',
    })
    if (ok === null) return
    window.location.reload()
  }

  function goToStage(target: Step) {
    if (target === step || !stageReachable(target)) return
    // Going to actions may need the Test-host password first.
    if (target === 'action') {
      void continueToActions()
      return
    }
    setStep(target)
  }

  // --- Validate Connections: connect-only SSH auth check ------------------- #
  const [authChecking, setAuthChecking] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [authResults, setAuthResults] = useState<{ results: AuthResult[]; passed: number; total: number } | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authFilter, setAuthFilter] = useState<'all' | 'passed' | 'failed'>('all')
  // Which selection the cached results belong to (so we can reopen vs re-run).
  const [authSig, setAuthSig] = useState('')
  const authAbort = useRef<AbortController | null>(null)

  // True when the current selection already has (finished) validation results.
  const hasValidatedCurrent =
    !authChecking && authResults !== null && authResults.results.length > 0 && authSig === selectionSig

  // Close the modal, but KEEP the results cached so re-clicking reopens them.
  function closeAuth() {
    authAbort.current?.abort()
    authAbort.current = null
    setAuthOpen(false)
    setAuthError(null)
  }

  // Validate button: reopen cached results if the selection is unchanged,
  // otherwise run a fresh validation.
  function onValidateClick() {
    if (hasValidatedCurrent) {
      setAuthError(null)
      setAuthOpen(true)
      return
    }
    void onTestConnection()
  }

  async function onTestConnection() {
    setAuthError(null)
    let testPw: string | undefined
    if (isTest) {
      // Always re-prompt so a wrong password can be corrected and re-tried.
      const pw = await prompt({
        title: 'Test host password',
        message: `Password for ${testHost ?? 'the test host'} (used for the connection test):`,
        password: true,
        confirmLabel: 'Test',
      })
      if (pw === null) return
      if (!pw) {
        setAuthError('Password is required.')
        return
      }
      testPw = pw
      setTestPassword(pw) // remember the verified password for the run
    } else if (selectedHosts(source).length === 0) {
      setAuthError('Select at least one system first.')
      return
    }
    setAuthChecking(true)
    setAuthFilter('all')
    setAuthOpen(true)
    setAuthSig(selectionSig) // these results correspond to the current selection
    // Open the modal immediately with an empty list; it fills in live as each
    // host's result streams back from the backend.
    setAuthResults({ results: [], passed: 0, total: 0 })
    authAbort.current?.abort()
    const ac = new AbortController()
    authAbort.current = ac
    try {
      const form = buildDeployForm({
        action: 'quick_diag', // ignored by /api/auth-check; just needs the source
        runMode: isTest ? 'test' : 'universal',
        config,
        source,
        testPassword: testPw,
      })
      // Null-guarded updaters: if the operator closes the modal mid-stream
      // (authResults → null), late events are ignored instead of re-opening it.
      const families = new Set<string>()
      await authCheck(form, {
        signal: ac.signal,
        onMeta: (total) => setAuthResults((r) => (r ? { ...r, total } : r)),
        onResult: (res) => {
          if (res.ok && res.os) families.add(res.os)
          setAuthResults((r) => {
            if (!r) return r
            const results = [...r.results, res]
            return { results, passed: results.filter((x) => x.ok).length, total: r.total }
          })
        },
        onDone: (passed, total) => setAuthResults((r) => (r ? { ...r, passed, total } : r)),
        onFatal: (message) => {
          setAuthResults(null)
          setAuthError(message)
        },
      })
      // A pure-RouterOS fleet (nothing else detected) → default the Custom
      // Script interpreter to RouterOS. Mixed fleets are left untouched.
      if (families.size === 1 && families.has('routeros')) {
        setCustomScript((cs) => (cs.interpreter === 'routeros' ? cs : { ...cs, interpreter: 'routeros' }))
      }
    } catch (e) {
      // Aborting (operator closed the modal) is not an error.
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setAuthError(e instanceof Error ? e.message : String(e))
        setAuthResults(null)
      }
    } finally {
      setAuthChecking(false)
    }
  }

  // Let the operator correct a mistyped Test-host password from the Action step.
  async function reenterTestPassword() {
    const pw = await prompt({
      title: 'Test host password',
      message: `Re-enter the password for ${testHost ?? 'the test host'}:`,
      password: true,
      confirmLabel: 'Save',
    })
    if (pw === null) return
    if (!pw) {
      setRunError('Password is required.')
      return
    }
    setTestPassword(pw)
    // Update the remembered run so "Retry failed hosts" replays with the new password.
    if (lastRunRef.current) lastRunRef.current.pw = pw
    setRunError(null)
  }

  function toggleTheme() {
    setTheme((t) => (t === 'night' ? 'day' : 'night'))
    const now = Date.now()
    const recent = themeFlicks.current.filter((t) => now - t < 2500)
    recent.push(now)
    themeFlicks.current = recent
    if (recent.length >= 6) {
      setRainMode(true)
      rainStart.current = Date.now()
      themeFlicks.current = []
    }
  }

  async function ensureTestPassword(): Promise<string | null> {
    if (testPassword) return testPassword
    const pw = await prompt({
      title: 'Test host password',
      message: `Password for ${testHost ?? 'the test host'}:`,
      password: true,
      confirmLabel: 'Run',
    })
    if (pw === null) return null
    if (!pw) {
      setRunError('Password is required.')
      return null
    }
    setTestPassword(pw)
    return pw
  }

  /** Pick one of the shortlisted systems (Step 1). Returns its label or null. */
  async function chooseHost(message: string, confirmLabel = 'Run'): Promise<string | null> {
    const hosts = selectedHosts(source)
    if (!hosts.length) {
      setRunError('No systems selected — go back to Step 1 and select at least one.')
      return null
    }
    if (hosts.length === 1) return hosts[0].value
    return prompt({ title: 'Choose a system', message, options: hosts, confirmLabel })
  }

  async function startRun(
    runMode: RunMode,
    srcOverride?: SourceState,
    testPw?: string,
    opOverride?: ThreecxOperation,
    actionOverride?: ActionId,
    tcxConfigOverride?: object,
    append?: boolean,
  ) {
    setRunError(null)
    const src = srcOverride ?? source
    const act = actionOverride ?? action
    const op = opOverride ?? threecx.operation
    // Skip validation on a fallback replay or a prebuilt (Quick Action) config.
    if (act === 'threecx' && !opOverride && !tcxConfigOverride && runMode !== 'fallback') {
      if ((op === 'audit' || op === 'apply') && targetCount(threecx) === 0) {
        setRunError('Tick at least one field — or use “Probe for all available fields” to discover them.')
        return
      }
      if (op === 'import') {
        if (!threecx.importFile) {
          setRunError('Pick a previously-exported Config JSON file to import.')
          return
        }
        if (threecx.strategy === 'mirror') {
          const confirmText = await prompt({
            title: 'Confirm MIRROR',
            message: 'Mirror DELETES items on the target that are absent from the source. Type MIRROR to confirm:',
            confirmLabel: 'Confirm',
          })
          if (confirmText === null) return
          if (confirmText.trim() !== 'MIRROR') {
            setRunError('Mirror not confirmed — you must type MIRROR exactly.')
            return
          }
        }
      }
    }
    try {
      const form = buildDeployForm({
        action: act,
        runMode,
        config,
        source: src,
        testPassword: testPw,
        fallbackHosts: run.failedLabels,
        customScript: act === 'custom_script' ? resolveCustomScript(customScript) ?? undefined : undefined,
        threecxConfig:
          act === 'threecx'
            ? (tcxConfigOverride ??
              buildThreecxConfig(opOverride ? { ...threecx, operation: opOverride } : threecx, src.mode === 'compound'))
            : undefined,
      })
      // Remember this run so "Retry failed hosts" replays exactly what we did.
      if (runMode !== 'fallback') {
        lastRunRef.current = { src, pw: testPw, op: act === 'threecx' ? op : undefined, act, tcxConfig: tcxConfigOverride }
      }
      void run.start(form, { append })
      setStep('results') // jump to the Voyage Results stage on run
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e))
    }
  }

  // Pre-run approval ("second approval") + staged batch rollout state.
  const [approval, setApproval] = useState<{ assessment: RiskAssessment; systems: number; canBatch: boolean; act?: ActionId } | null>(null)
  const [batchOn, setBatchOn] = useState(false)
  const [batchSize, setBatchSize] = useState(5)
  const [batchQueue, setBatchQueue] = useState<{ batches: string[][]; idx: number; act?: ActionId } | null>(null)

  // Primary "Run" — read-only actions run straight away; modifying/destructive
  // ones go through the approval modal first.
  function onRun(actionOverride?: ActionId) {
    setRunError(null)
    const act = actionOverride ?? action
    if (actionOverride && actionOverride !== action) setAction(actionOverride)
    const assessment = assessRisk(act, threecx, customScript)
    const canBatch = !isTest && hostCount > 1
    // Read-only actions on a single host (or a Test run) run straight away.
    // With multiple hosts we still show the modal so the operator can choose
    // to batch the rollout, even for read-only actions.
    if (assessment.level === 'read-only' && !canBatch) {
      void execute(0, actionOverride)
      return
    }
    setBatchOn(false)
    setApproval({ assessment, systems: isTest ? 1 : hostCount, canBatch, act: actionOverride })
  }

  // Execute the current action: all selected hosts at once, or in batches of N.
  async function execute(size: number, act?: ActionId) {
    setApproval(null)
    setBatchQueue(null)
    if (isTest) {
      const pw = await ensureTestPassword()
      if (pw === null) return
      return startRun('test', source, pw, undefined, act)
    }
    if (size > 0) {
      const labels = selectedHosts(source).map((h) => h.value)
      const batches = chunk(labels, size)
      setBatchQueue({ batches, idx: 0, act })
      return startRun('universal', restrictToHosts(source, batches[0]), undefined, undefined, act)
    }
    startRun('universal', undefined, undefined, undefined, act)
  }

  function continueBatch() {
    const bq = batchQueue
    if (!bq) return
    const idx = bq.idx + 1
    if (idx >= bq.batches.length) {
      setBatchQueue(null)
      return
    }
    setBatchQueue({ ...bq, idx })
    void startRun('universal', restrictToHosts(source, bq.batches[idx]), undefined, undefined, bq.act, undefined, true)
  }

  // 3CX "Probe for all available fields" — runs probe on ONE chosen system.
  async function onProbe() {
    setRunError(null)
    if (isTest) {
      const pw = await ensureTestPassword()
      if (pw === null) return
      return startRun('test', source, pw, 'probe')
    }
    const chosen = await chooseHost('Choose a system to probe for all available fields:', 'Probe')
    if (chosen === null) return
    startRun('universal', restrictToHost(source, chosen), undefined, 'probe')
  }

  function onFallback() {
    const lr = lastRunRef.current
    if (!lr) return void startRun('fallback')
    void startRun('fallback', lr.src, lr.pw, lr.op, lr.act, lr.tcxConfig)
  }

  // 3CX Quick Action (Copy BLFs / CID / Audio Cleanup): builds an apply config
  // for the Users entity and runs it on the shortlisted systems.
  async function onQuickAction(act: QuickAction, sourceExt: string, targets: string) {
    setRunError(null)
    if (act.needsSource && !sourceExt.trim()) return setRunError('Source extension is required.')
    if (!targets.trim()) return setRunError('Target extensions are required.')
    const cfg = buildQuickActionConfig(threecx, act, sourceExt, targets, source.mode === 'compound')
    if (isTest) {
      const pw = await ensureTestPassword()
      if (pw === null) return
      return startRun('test', source, pw, undefined, undefined, cfg)
    }
    const hosts = selectedHosts(source)
    if (hosts.length > 1) {
      const ok = await prompt({
        title: act.label,
        message: `“${act.label}” will be applied to ${hosts.length} systems. Extensions are often custom per-system — apply to all of them?`,
        confirm: true,
        confirmLabel: 'Apply to all',
      })
      if (ok === null) return
    }
    startRun('universal', undefined, undefined, undefined, undefined, cfg)
  }

  // Quick Actions have their own per-card buttons; hide the shared Run button.
  const runHidden = action === 'threecx' && threecx.operation === 'quickactions'

  // Why the primary Run button is disabled (3CX needs entities / a file).
  function runDisabledReason(): string | null {
    // A staged batch rollout is mid-flight — make the operator Stop it before
    // starting a fresh run, so the buttons can't be spammed into overlap.
    if (batchQueue && batchQueue.idx < batchQueue.batches.length - 1) {
      return 'Finish or stop the current batch rollout first.'
    }
    if (action !== 'threecx') return null
    const op = threecx.operation
    if (op === 'audit' || op === 'apply') {
      if (targetCount(threecx) === 0) return threecx.panels.length === 0 ? 'No fields added.' : 'Set a value for at least one field.'
    }
    if (op === 'export' && threecx.panels.length === 0) return 'No entities added.'
    if (op === 'import' && !threecx.importFile) return 'Choose a Config JSON file.'
    return null
  }

  return (
    <div className="app">
      <Splash ready={health === 'ok'} />
      {theme === 'night' ? (
        <>
          {anim.aurora && <Aurora intensity={fx.aurora} />}
          {anim.stars && <Stars density={fx.stars} />}
        </>
      ) : (
        anim.clouds && <Clouds density={fx.clouds} />
      )}
      {anim.waves && <Waves frequency={shipFreq} />}
      {rainMode && <Rain />}

      <header className="app__bar">
        <div className="app__brand">
          <img className="app__logo" src="/fleet.ico" alt="" aria-hidden="true" />
          Fleet Commander
        </div>
        <div className="app__baractions">
          {health === 'down' && <div className="app__offline">⚠ Backend offline</div>}
          <button
            type="button"
            className="app__theme"
            onClick={() => void resetApp()}
            title="Reset — clear fleet, action & results"
            aria-label="Reset app"
          >
            ↺
          </button>
          <button
            type="button"
            className="app__theme"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Open settings"
          >
            ⚙
          </button>
          {rainMode ? (
            <button
              type="button"
              className="app__theme app__raindrop"
              // A 1s grace period so a spam-click can't instantly dismiss it.
              onClick={() => Date.now() - rainStart.current >= 1000 && setRainMode(false)}
              title="Clear the rain"
              aria-label="Clear the rain"
            >
              💧
            </button>
          ) : (
            <button
              type="button"
              className="app__theme"
              onClick={toggleTheme}
              title={theme === 'night' ? 'Switch to Day Mode' : 'Switch to Night Mode'}
              aria-label="Toggle Day / Night"
            >
              {theme === 'night' ? '☀' : '☾'}
            </button>
          )}
          <WindowControls />
        </div>
      </header>

      <main className="app__main">
        <nav className="roadmap" aria-label="Progress">
          {STAGES.map((s, i) => {
            const reachable = step === s.id || stageReachable(s.id)
            return (
              <Fragment key={s.id}>
                {i > 0 && <span className="roadmap__arrow" aria-hidden="true">→</span>}
                <button
                  type="button"
                  className={`roadmap__stage${step === s.id ? ' is-active' : ''}${reachable ? '' : ' is-locked'}`}
                  aria-current={step === s.id ? 'step' : undefined}
                  disabled={!reachable}
                  onClick={() => goToStage(s.id)}
                >
                  <span className="roadmap__num">{i + 1}</span>
                  <span className="roadmap__label">{s.label}</span>
                </button>
              </Fragment>
            )
          })}
        </nav>

        {step === 'source' && (
          <section className="step" key="source">
            <SourcePanel source={source} onChange={setSource} onModeChange={onModeChange} testHost={testHost} />
            <div className="step__nav">
              <div className="step__navleft">
                <CsvGuide />
                {!canProceed && <span className="step__hint">Select at least one system to continue.</span>}
              </div>
              <div className="step__navright">
                <button
                  type="button"
                  className="run__btn"
                  disabled={authChecking || !canProceed}
                  onClick={() => onValidateClick()}
                >
                  {authChecking ? 'Validating…' : '🔌 Validate Connections'}
                </button>
                <button type="button" className="run__btn run__btn--primary" disabled={!canProceed} onClick={() => void continueToActions()}>
                  Continue to actions →
                </button>
              </div>
            </div>
          </section>
        )}

        {step === 'action' && (
          <section className="step" key="action">
            <div className="step__crumb">
              <span className="step__on" title={systemsTooltip}>
                Working on <strong>{systemsLabel}</strong>
              </span>
            </div>
            <ActionPanel
              action={action}
              setAction={setAction}
              running={run.status === 'running'}
              runHint={runDisabledReason()}
              runHidden={runHidden}
              onRun={onRun}
              onStop={() => run.cancel()}
              customScriptSlot={<CustomScriptPanel value={customScript} onChange={setCustomScript} variables={availableVars} csvAvailable={source.mode === 'compound'} />}
              threecxSlot={
                <ThreecxPanel
                  value={threecx}
                  onChange={setThreecx}
                  onProbe={() => void onProbe()}
                  onQuickAction={(a, src, targets) => void onQuickAction(a, src, targets)}
                />
              }
            />
            {runError && <div className="app__runerror">✕ {runError}</div>}
          </section>
        )}

        {step === 'results' && (
          <section className="step" key="results">
            <div className="step__crumb">
              <span className="step__on" title={systemsTooltip}>
                Working on <strong>{systemsLabel}</strong>
              </span>
            </div>
            {runError && <div className="app__runerror">✕ {runError}</div>}
            <ResultsPanel
              run={run}
              onFallback={onFallback}
              onReenterPassword={isTest ? () => void reenterTestPassword() : undefined}
              onStop={() => run.cancel()}
              titles={resultTitles}
              exitCategories={exitCategories}
              onOpenSettings={() => setSettingsOpen(true)}
            />

            {batchQueue && run.status === 'done' && batchQueue.idx < batchQueue.batches.length - 1 && (
              <div className="batchbar">
                <span className="batchbar__msg">
                  Batch {batchQueue.idx + 1} of {batchQueue.batches.length} complete — review the results above before continuing.
                </span>
                <div className="batchbar__actions">
                  <button type="button" className="run__btn" onClick={() => setBatchQueue(null)}>
                    Stop
                  </button>
                  <button type="button" className="run__btn run__btn--primary" onClick={continueBatch}>
                    Continue with next {batchQueue.batches[batchQueue.idx + 1].length} →
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        anim={anim}
        onAnimChange={setAnim}
        fx={fx}
        onFxChange={setFx}
        shipFreq={shipFreq}
        onShipFreqChange={setShipFreq}
        exitCategories={exitCategories}
        onExitCategoriesChange={setExitCategories}
      />
      <UpdateBanner />

      {authOpen && (authResults || authError) && (
        <div className="confirm__overlay" onMouseDown={closeAuth}>
          <div className="confirm" onMouseDown={(e) => e.stopPropagation()}>
            <div className="confirm__head">
              <h3>Validate Connections</h3>
            </div>
            {authError ? (
              <p className="app__runerror">✕ {authError}</p>
            ) : authResults ? (
              <>
                {(() => {
                  const OS_NAMES: Record<string, string> = {
                    linux: 'Debian/Linux',
                    openbsd: 'OpenBSD',
                    routeros: 'RouterOS',
                  }
                  const fams = [...new Set(authResults.results.filter((r) => r.ok && r.os).map((r) => r.os as string))]
                  return fams.length > 1 ? (
                    <div className="authres__oswarn">
                      ⚠ Mixed fleet: you're validating{' '}
                      <strong>{fams.map((f) => OS_NAMES[f] ?? f).join(' + ')}</strong> systems. Make sure your action
                      (and interpreter) is safe for all of them.
                    </div>
                  ) : null
                })()}
                <p className={`confirm__summary ${!authChecking && authResults.passed === authResults.total ? '' : 'authres--warn'}`}>
                  {authChecking ? (
                    <>
                      <span className="results__spin">checking…</span> {authResults.results.length} of{' '}
                      {authResults.total || '?'} done — {authResults.passed} ok
                    </>
                  ) : (
                    `${authResults.passed} of ${authResults.total} system${authResults.total === 1 ? '' : 's'} authenticated.`
                  )}
                </p>
                {authResults.results.length > 0 && (
                  <div className="authres__filters" role="group" aria-label="Filter results">
                    {(['all', 'passed', 'failed'] as const).map((f) => {
                      const count =
                        f === 'all'
                          ? authResults.results.length
                          : f === 'passed'
                            ? authResults.passed
                            : authResults.results.length - authResults.passed
                      return (
                        <button
                          key={f}
                          type="button"
                          className={`authres__fbtn${authFilter === f ? ' is-active' : ''}`}
                          onClick={() => setAuthFilter(f)}
                        >
                          {f === 'all' ? 'All' : f === 'passed' ? 'Passed' : 'Failed'} ({count})
                        </button>
                      )
                    })}
                  </div>
                )}
                <ul className="authres__list">
                  {authResults.results
                    .filter((r) => authFilter === 'all' || (authFilter === 'passed' ? r.ok : !r.ok))
                    .map((r) => {
                      const title = resultTitles[r.label]
                      return (
                        <li key={r.label} className={r.ok ? 'is-ok' : 'is-fail'}>
                          <span className="authres__dot">{r.ok ? '✓' : '✕'}</span>
                          {title && <span className="authres__title">{title}</span>}
                          <span className="authres__label">{r.label.replace(/^ssh:\/\//, '')}</span>
                          {!r.ok && <span className="authres__err">{r.error}</span>}
                        </li>
                      )
                    })}
                  {authChecking && <li className="authres__pending">Checking remaining systems…</li>}
                </ul>
              </>
            ) : null}
            <div className="confirm__actions">
              {!isTest && !authChecking && authResults && authResults.results.some((r) => !r.ok) && (
                <button
                  type="button"
                  className="run__btn"
                  style={{ marginRight: 'auto' }}
                  title="Remove the failed systems from your selection"
                  onClick={() => {
                    const failed = authResults.results.filter((r) => !r.ok).map((r) => r.label)
                    const next = deselectHosts(source, failed)
                    setSource(next)
                    // The remaining hosts all passed validation, so keep the
                    // "validated" state by re-pointing the signature at them.
                    setAuthSig(sigForSource(next))
                    closeAuth()
                  }}
                >
                  Deselect {authResults.results.filter((r) => !r.ok).length} failed
                </button>
              )}
              <button type="button" className="run__btn" onClick={closeAuth}>
                Close
              </button>
              <button
                type="button"
                className="run__btn run__btn--primary"
                disabled={authChecking}
                onClick={() => {
                  closeAuth()
                  void onTestConnection()
                }}
              >
                {authChecking ? 'Validating…' : 'Validate again'}
              </button>
            </div>
          </div>
        </div>
      )}

      {approval && (
        <div className="confirm__overlay" onMouseDown={() => setApproval(null)}>
          <div className="confirm" onMouseDown={(e) => e.stopPropagation()}>
            <div className="confirm__head">
              <span className={`confirm__badge confirm__badge--${approval.assessment.level}`}>
                {LEVEL_LABEL[approval.assessment.level]}
              </span>
              <h3>{approval.assessment.title}</h3>
            </div>
            <p className="confirm__summary">{approval.assessment.summary}</p>
            {approval.assessment.details.length > 0 && (
              <ul className="confirm__details">
                {approval.assessment.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
            <p className="confirm__systems">
              This will run on <strong>{approval.systems}</strong> system{approval.systems === 1 ? '' : 's'}.
            </p>
            {approval.canBatch && (
              <div className="confirm__batch">
                {/* Only the checkbox + its own text is a <label> — so clicking
                    or typing in the size field never toggles batching. */}
                <label className="confirm__batch-toggle">
                  <input type="checkbox" checked={batchOn} onChange={(e) => setBatchOn(e.target.checked)} />
                  <span>Roll out in batches of</span>
                </label>
                <input
                  type="number"
                  min={1}
                  className="confirm__batchsize"
                  value={batchSize}
                  onChange={(e) => setBatchSize(Math.max(1, Number(e.target.value) || 1))}
                />
                <span>systems, pausing to review between each.</span>
              </div>
            )}
            <div className="confirm__actions">
              <button type="button" className="run__btn" onClick={() => setApproval(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={`run__btn ${approval.assessment.level === 'destructive' ? 'run__btn--danger' : 'run__btn--primary'}`}
                onClick={() => void execute(batchOn ? batchSize : 0, approval.act)}
              >
                {approval.assessment.level === 'destructive' ? 'I understand — run anyway' : 'Confirm & run'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const LEVEL_LABEL: Record<RiskAssessment['level'], string> = {
  'read-only': 'Read-only',
  modifies: 'Modifies systems',
  destructive: 'Destructive',
}

export default App
