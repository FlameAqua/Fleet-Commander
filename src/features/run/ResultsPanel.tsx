import { useState } from 'react'
import { downloadBlob } from '../../lib/file'
import type { DeployRun, HostCard } from './useDeployRun'
import './run.css'

function displayHost(label: string): string {
  return label.replace(/^ssh:\/\/[^@]+@/, '').replace(/:\d+$/, '')
}

function safeName(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'host'
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

type Outcome = 'success' | 'failure' | 'error' | 'running' | 'queued'

// exit 0 → success, exit 2 → predictable failure (e.g. failed audit),
// anything else on a failed host → unpredictable error.
function outcomeOf(card: HostCard): Outcome {
  if (card.status === 'ok') return 'success'
  if (card.status === 'fail') return card.exitStatus === 2 ? 'failure' : 'error'
  return card.status
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  success: 'success',
  failure: 'failure',
  error: 'error',
  running: 'running',
  queued: 'queued',
}

function cardLog(card: HostCard): string {
  const out = card.output != null ? card.output : card.lines.join('\n')
  return [
    `Host:      ${card.label}`,
    `Outcome:   ${OUTCOME_LABEL[outcomeOf(card)]}`,
    `Exit code: ${card.exitStatus ?? '(none)'}`,
    `Stage:     ${card.stage ?? ''}`,
    `Message:   ${card.message ?? ''}`,
    `Duration:  ${card.durationS ? card.durationS.toFixed(1) + 's' : ''}`,
    '',
    out || '(no output)',
    '',
  ].join('\n')
}

interface Props {
  run: DeployRun
  onFallback: () => void
  /** Provided only for Test-host runs — re-prompt for the password. */
  onReenterPassword?: () => void
}

export function ResultsPanel({ run, onFallback, onReenterPassword }: Props) {
  const { status, meta, fatal, cards, failedLabels } = run
  if (status === 'idle' && !cards.length && !fatal) return null
  // Show "Re-enter password" when a failure is an authentication failure.
  const hasAuthFailure = cards.some((c) => c.status === 'fail' && c.stage === 'auth')

  const byOutcome = {
    success: cards.filter((c) => outcomeOf(c) === 'success'),
    failure: cards.filter((c) => outcomeOf(c) === 'failure'),
    error: cards.filter((c) => outcomeOf(c) === 'error'),
  }
  const n = { ok: byOutcome.success.length, failed: byOutcome.failure.length, errors: byOutcome.error.length }

  function exportOne(card: HostCard) {
    downloadBlob(new Blob([cardLog(card)], { type: 'text/plain' }), `${safeName(card.label)}_${outcomeOf(card)}.log`)
  }
  function exportGroup(group: HostCard[], tag: string) {
    if (!group.length) return
    const divider = '\n' + '='.repeat(64) + '\n\n'
    downloadBlob(new Blob([group.map(cardLog).join(divider)], { type: 'text/plain' }), `fleet-logs-${tag}_${timestamp()}.txt`)
  }

  return (
    <section className="results">
      <div className="results__head">
        <h2 className="step__title">
          <span className="step__num">3</span> Results
        </h2>
        <div className="results__counts">
          {meta && <span>{meta.count} host{meta.count === 1 ? '' : 's'}</span>}
          {(n.ok > 0 || status === 'done') && <span className="is-ok">{n.ok} ok</span>}
          {(n.failed > 0 || status === 'done') && <span className="is-fail">{n.failed} failed</span>}
          {(n.errors > 0 || status === 'done') && <span className="is-err">{n.errors} errors</span>}
          {status === 'running' && <span className="results__spin">running…</span>}
        </div>
      </div>

      {cards.length > 0 && (
        <div className="results__exports">
          <span className="results__exports-label">Export logs:</span>
          <button type="button" className="results__exportbtn" onClick={() => exportGroup(cards, 'all')}>
            All ({cards.length})
          </button>
          <button type="button" className="results__exportbtn" disabled={!n.ok} onClick={() => exportGroup(byOutcome.success, 'ok')}>
            OK ({n.ok})
          </button>
          <button type="button" className="results__exportbtn" disabled={!n.failed} onClick={() => exportGroup(byOutcome.failure, 'failed')}>
            Failed ({n.failed})
          </button>
          <button type="button" className="results__exportbtn" disabled={!n.errors} onClick={() => exportGroup(byOutcome.error, 'errors')}>
            Errors ({n.errors})
          </button>
        </div>
      )}

      {meta?.warnings?.map((w, i) => (
        <div key={i} className="results__warn">⚠ {w}</div>
      ))}
      {fatal && <div className="results__outcome results__outcome--error">✕ Error — {fatal}</div>}
      {status === 'done' && !fatal && (
        <div
          className={`results__outcome ${
            n.errors > 0 ? 'results__outcome--error' : n.failed > 0 ? 'results__outcome--failure' : 'results__outcome--success'
          }`}
        >
          {n.errors === 0 && n.failed === 0
            ? `✓ All ${n.ok} system${n.ok === 1 ? '' : 's'} completed successfully`
            : `Done — ${n.ok} ok` + (n.failed ? `, ${n.failed} failed` : '') + (n.errors ? `, ${n.errors} errored` : '')}
        </div>
      )}

      <div className="results__cards">
        {cards.map((c) => (
          <Card key={c.label} card={c} onExport={() => exportOne(c)} />
        ))}
      </div>

      {status === 'done' && failedLabels.length > 0 && (
        <div className="results__fallback">
          <button type="button" className="run__btn" onClick={onFallback}>
            Retry {failedLabels.length} failed host{failedLabels.length === 1 ? '' : 's'}
          </button>
          {onReenterPassword && hasAuthFailure && (
            <button type="button" className="run__btn" onClick={onReenterPassword}>
              🔑 Re-enter password
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function Card({ card, onExport }: { card: HostCard; onExport: () => void }) {
  const [open, setOpen] = useState(false)
  const body = card.output != null ? card.output : card.lines.join('\n')
  const outcome = outcomeOf(card)
  const meta = [
    card.stage,
    card.exitStatus != null ? `exit ${card.exitStatus}` : null,
    card.durationS ? `${card.durationS.toFixed(1)}s` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const done = card.status === 'ok' || card.status === 'fail'

  return (
    <div className={`card card--${outcome}`}>
      <div className="card__head">
        <button type="button" className="card__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className={`card__dot card__dot--${outcome}`} />
          <span className="card__host">{displayHost(card.label)}</span>
          <span className="card__msg">{card.message || statusText(card.status)}</span>
          {meta && <span className="card__meta">{meta}</span>}
          <span className="card__chev">{open ? '▾' : '▸'}</span>
        </button>
        {done && (
          <button type="button" className="card__dl" title="Export this system's log" onClick={onExport}>
            <ExportIcon />
          </button>
        )}
      </div>
      {card.exportData && (
        <div className="card__export">
          <div className="card__export-info">
            <strong>3CX Config export ready</strong>
            <span className="card__export-name">{card.exportData.filename}</span>
            {card.exportData.summary && <span className="card__export-sum">items → {card.exportData.summary}</span>}
          </div>
          <button
            type="button"
            className="run__btn run__btn--primary"
            onClick={() =>
              downloadBlob(new Blob([card.exportData!.jsonText], { type: 'application/json' }), card.exportData!.filename)
            }
          >
            ⬇ Download JSON
          </button>
        </div>
      )}
      {open && <pre className="card__log">{body || '(no output yet)'}</pre>}
    </div>
  )
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v11" />
      <path d="M7.5 9.5 12 14l4.5-4.5" />
      <path d="M5 20h14" />
    </svg>
  )
}

function statusText(s: HostCard['status']): string {
  switch (s) {
    case 'queued':
      return 'queued…'
    case 'running':
      return 'running…'
    case 'ok':
      return 'done'
    case 'fail':
      return 'failed'
  }
}
