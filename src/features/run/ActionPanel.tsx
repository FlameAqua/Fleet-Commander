import type { ReactNode } from 'react'
import { Segmented } from '../../components/Segmented'
import type { ActionId } from './deployForm'
import './run.css'

interface ActionDef {
  id: ActionId
  label: string
  /** Intro line above the action's body. Omit when the action's own UI
   *  (e.g. 3CX Manager's sub-tabs) already says what it does. */
  blurb?: string
}

interface TabDef {
  id: string
  label: string
  actions: ActionDef[]
  /** Render the actions as one-click launcher buttons (no shared Run button). */
  launchers?: boolean
}

const TABS: TabDef[] = [
  {
    id: 'custom',
    label: 'Custom Script',
    // No blurb: the panel's own Write / Library / Import tabs sit at the top.
    actions: [{ id: 'custom_script', label: 'Custom Script' }],
  },
  {
    id: 'threecx',
    label: '3CX Manager',
    // No blurb: the panel's own Quick Actions / Audit / Modify / Export /
    // Import tabs sit at the top and already convey this.
    actions: [{ id: 'threecx', label: '3CX Manager' }],
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    // Blurbs kept here (unlike the 3CX / Custom Script tabs, whose sub-tabs say
    // what they do): these are per-action, and they're the only place the UI
    // states these are safe to run against a live PBX.
    actions: [
      { id: 'apt_upgrade', label: 'Apt Upgrade', blurb: 'Patch Debian/OpenBSD without rebooting or restarting services.' },
      { id: 'quick_diag', label: 'Quick Diagnostic', blurb: 'Read-only health snapshot (uptime, load, mem, disk). Changes nothing.' },
    ],
  },
  {
    id: 'other',
    label: 'Other',
    launchers: true,
    actions: [{ id: 'deploy', label: 'Deploy Heplify', blurb: 'Install/upgrade the heplify SIP capture agent.' }],
  },
]

interface Props {
  action: ActionId
  setAction: (a: ActionId) => void
  running: boolean
  /** When set, the Run button is disabled and this reason is shown beside it. */
  runHint: string | null
  /** Hide the shared Run button entirely (e.g. 3CX Quick Actions have their own). */
  runHidden?: boolean
  /** Run the current action, or an explicit one (used by the Other launchers). */
  onRun: (actionOverride?: ActionId) => void
  /** Abort the in-flight run (shown as a Stop button while running). */
  onStop: () => void
  customScriptSlot: ReactNode
  threecxSlot: ReactNode
}

export function ActionPanel({ action, setAction, running, runHint, runHidden, onRun, onStop, customScriptSlot, threecxSlot }: Props) {
  const activeTab = TABS.find((t) => t.actions.some((a) => a.id === action)) ?? TABS[0]
  const current = activeTab.actions.find((a) => a.id === action) ?? activeTab.actions[0]

  return (
    <section className="run">
      <div className="run__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab.id === t.id}
            className={activeTab.id === t.id ? 'is-active' : ''}
            onClick={() => setAction(t.actions[0].id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="run__body">
        {activeTab.launchers ? (
          <div className="run__launchers">
            {activeTab.actions.map((a) => (
              <button key={a.id} type="button" className="run__launcher" disabled={running} onClick={() => onRun(a.id)}>
                <span className="run__launcher-title">{a.label}</span>
                <span className="run__launcher-blurb">{a.blurb}</span>
              </button>
            ))}
          </div>
        ) : (
          <>
            {activeTab.actions.length > 1 && (
              <Segmented
                options={activeTab.actions.map((a) => ({ id: a.id, label: a.label }))}
                value={action}
                onChange={setAction}
                ariaLabel="Maintenance action"
              />
            )}

            {current.blurb && <p className="run__blurb">{current.blurb}</p>}

            {action === 'custom_script' && customScriptSlot}
            {action === 'threecx' && threecxSlot}

            {!runHidden && (
              <div className="run__buttons">
                {runHint && <span className="run__hint">{runHint}</span>}
                {running && (
                  <button type="button" className="run__btn" onClick={onStop}>
                    Stop
                  </button>
                )}
                <button
                  type="button"
                  className="run__btn run__btn--primary"
                  disabled={running || !!runHint}
                  onClick={() => onRun()}
                >
                  {running ? 'Running…' : 'Run on selected hosts'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
