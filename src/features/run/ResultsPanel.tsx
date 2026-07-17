import { useState } from 'react'
import { createPortal } from 'react-dom'
import { downloadBlob } from '../../lib/file'
import type { DeployRun, HostCard } from './useDeployRun'
import type { ExitCategory } from './exitCategories'
import './run.css'

function displayHost(label: string): string {
  return label.replace(/^ssh:\/\/[^@]+@/, '').replace(/:\d+$/, '')
}

/** The bare host/URL of a result, for copying. */
function hostUrl(label: string): string {
  return label.replace(/^ssh:\/\//, '')
}

function safeName(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'host'
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

type Outcome = 'success' | 'failure' | 'error' | 'running' | 'queued' | 'skipped'

// Visual outcome (drives the dot colour). exit 0 → success; a failed host whose
// exit code matches a configured category → "failure" (amber); any other
// non-zero → "error" (red); a host stopped before returning → "skipped".
function outcomeOf(card: HostCard, cats: ExitCategory[]): Outcome {
  if (card.status === 'ok') return 'success'
  if (card.status === 'skipped') return 'skipped'
  if (card.status === 'fail') return cats.some((c) => c.code === card.exitStatus) ? 'failure' : 'error'
  return card.status
}

// Human label for a card's group — a category label for matched exit codes.
function groupLabelOf(card: HostCard, cats: ExitCategory[]): string {
  if (card.status === 'ok') return 'OK'
  if (card.status === 'skipped') return 'Skipped'
  if (card.status === 'running') return 'Running'
  if (card.status === 'queued') return 'Queued'
  const cat = cats.find((c) => c.code === card.exitStatus)
  return cat ? cat.label : 'Error'
}

function cardLog(card: HostCard, cats: ExitCategory[]): string {
  const out = card.output != null ? card.output : card.lines.join('\n')
  return [
    `Host:      ${card.label}`,
    `Outcome:   ${groupLabelOf(card, cats)}`,
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
  /** Abort the in-flight run. */
  onStop: () => void
  /** Optional per-host title/account (label → title). */
  titles?: Record<string, string>
  /** User-configured exit-code categories (from Settings → Folders). */
  exitCategories: ExitCategory[]
  /** Open the Settings modal (from the export help hint). */
  onOpenSettings: () => void
}

export function ResultsPanel({ run, onFallback, onReenterPassword, onStop, titles = {}, exitCategories, onOpenSettings }: Props) {
  const { status, meta, fatal, cards, failedLabels } = run
  const [exportSel, setExportSel] = useState('all')
  const [openSet, setOpenSet] = useState<Set<string>>(new Set())
  const [ctx, setCtx] = useState<{ x: number; y: number; title: string; url: string } | null>(null)
  if (status === 'idle' && !cards.length && !fatal) return null
  // Show "Re-enter password" when a failure is an authentication failure.
  const hasAuthFailure = cards.some((c) => c.status === 'fail' && c.stage === 'auth')
  const allOpen = cards.length > 0 && cards.every((c) => openSet.has(c.label))

  function toggleCard(label: string) {
    setOpenSet((s) => {
      const next = new Set(s)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }
  function toggleAll() {
    setOpenSet(allOpen ? new Set() : new Set(cards.map((c) => c.label)))
  }

  const byOutcome = {
    success: cards.filter((c) => outcomeOf(c, exitCategories) === 'success'),
    failure: cards.filter((c) => outcomeOf(c, exitCategories) === 'failure'),
    error: cards.filter((c) => outcomeOf(c, exitCategories) === 'error'),
    skipped: cards.filter((c) => outcomeOf(c, exitCategories) === 'skipped'),
  }
  const n = {
    ok: byOutcome.success.length,
    failed: byOutcome.failure.length,
    errors: byOutcome.error.length,
    skipped: byOutcome.skipped.length,
  }

  // Export groups shown in the dropdown: All, OK, one per exit-code category
  // that occurred, Error, Skipped.
  const exportGroups: { value: string; label: string; cards: HostCard[] }[] = [
    { value: 'all', label: `All (${cards.length})`, cards },
  ]
  if (byOutcome.success.length)
    exportGroups.push({ value: 'ok', label: `OK (${byOutcome.success.length})`, cards: byOutcome.success })
  for (const cat of exitCategories) {
    const cc = cards.filter((c) => c.status === 'fail' && c.exitStatus === cat.code)
    if (cc.length) exportGroups.push({ value: `code-${cat.code}`, label: `${cat.label} (${cc.length})`, cards: cc })
  }
  if (byOutcome.error.length)
    exportGroups.push({ value: 'error', label: `Error (${byOutcome.error.length})`, cards: byOutcome.error })
  if (byOutcome.skipped.length)
    exportGroups.push({ value: 'skipped', label: `Skipped (${byOutcome.skipped.length})`, cards: byOutcome.skipped })
  const activeSel = exportGroups.some((g) => g.value === exportSel) ? exportSel : 'all'
  const activeGroup = exportGroups.find((g) => g.value === activeSel) ?? exportGroups[0]

  function exportOne(card: HostCard) {
    downloadBlob(
      new Blob([cardLog(card, exitCategories)], { type: 'text/plain' }),
      `${safeName(card.label)}_${outcomeOf(card, exitCategories)}.log`,
    )
  }
  function exportGroup(group: HostCard[], tag: string) {
    if (!group.length) return
    const divider = '\n' + '='.repeat(64) + '\n\n'
    downloadBlob(
      new Blob([group.map((c) => cardLog(c, exitCategories)).join(divider)], { type: 'text/plain' }),
      `fleet-logs-${tag}_${timestamp()}.txt`,
    )
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
          {exitCategories.map((cat) => {
            const c = cards.filter((x) => x.status === 'fail' && x.exitStatus === cat.code).length
            return c > 0 ? (
              <span key={cat.code} className="is-fail">
                {c} {cat.label.toLowerCase()}
              </span>
            ) : null
          })}
          {(n.errors > 0 || status === 'done') && <span className="is-err">{n.errors} errors</span>}
          {n.skipped > 0 && <span className="is-skip">{n.skipped} skipped</span>}
          {status === 'running' && <span className="results__spin">running…</span>}
        </div>
      </div>

      {cards.length > 0 && (
        <div className="results__exports">
          <span className="results__exports-label">Export logs:</span>
          <select
            className="results__exportsel"
            value={activeSel}
            onChange={(e) => setExportSel(e.target.value)}
            aria-label="Choose which results to export"
          >
            {exportGroups.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
          <button type="button" className="results__exportbtn" onClick={() => exportGroup(activeGroup.cards, activeSel)}>
            ⬇ Export
          </button>
          <button
            type="button"
            className="results__exporthelp"
            title="These groups come from your exit-code categories (e.g. exit 2 = Failure). Add or edit them in Settings → Folders."
            aria-label="About exit-code categories"
            onClick={onOpenSettings}
          >
            ?
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
          {n.errors === 0 && n.failed === 0 && n.skipped === 0
            ? `✓ All ${n.ok} system${n.ok === 1 ? '' : 's'} completed successfully`
            : `Done — ${n.ok} ok` +
              (n.failed ? `, ${n.failed} failed` : '') +
              (n.errors ? `, ${n.errors} errored` : '') +
              (n.skipped ? `, ${n.skipped} skipped` : '')}
        </div>
      )}

      <div className="results__cards">
        {cards.map((c) => (
          <Card
            key={c.label}
            card={c}
            title={titles[c.label]}
            categories={exitCategories}
            open={openSet.has(c.label)}
            onToggle={() => toggleCard(c.label)}
            onExport={() => exportOne(c)}
            onContext={(x, y, title, url) => setCtx({ x, y, title, url })}
          />
        ))}
      </div>

      {cards.length > 0 && (
        <div className="results__controls">
          {status === 'running' && (
            <button type="button" className="run__btn" onClick={onStop}>
              ■ Stop
            </button>
          )}
          <button type="button" className="run__btn" onClick={toggleAll}>
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
          <button
            type="button"
            className="run__btn"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            ↑ Back to top
          </button>
          {status === 'done' && failedLabels.length > 0 && (
            <>
              <button type="button" className="run__btn" onClick={onFallback}>
                Retry {failedLabels.length} failed host{failedLabels.length === 1 ? '' : 's'}
              </button>
              {onReenterPassword && hasAuthFailure && (
                <button type="button" className="run__btn" onClick={onReenterPassword}>
                  🔑 Re-enter password
                </button>
              )}
            </>
          )}
        </div>
      )}

      {ctx && (
        <CardContextMenu
          x={ctx.x}
          y={ctx.y}
          title={ctx.title}
          url={ctx.url}
          onClose={() => setCtx(null)}
        />
      )}
    </section>
  )
}

function CardContextMenu({
  x,
  y,
  title,
  url,
  onClose,
}: {
  x: number
  y: number
  title: string
  url: string
  onClose: () => void
}) {
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {})
    onClose()
  }
  return createPortal(
    <>
      <div
        className="cardctx__backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <ul className="cardctx" style={{ left: x, top: y }} role="menu">
        {title && (
          <li>
            <button type="button" onClick={() => copy(title)}>
              Copy title
            </button>
          </li>
        )}
        <li>
          <button type="button" onClick={() => copy(url)}>
            Copy URL
          </button>
        </li>
      </ul>
    </>,
    document.body,
  )
}

function Card({
  card,
  title,
  categories,
  open,
  onToggle,
  onExport,
  onContext,
}: {
  card: HostCard
  title?: string
  categories: ExitCategory[]
  open: boolean
  onToggle: () => void
  onExport: () => void
  onContext: (x: number, y: number, title: string, url: string) => void
}) {
  const body = card.output != null ? card.output : card.lines.join('\n')
  const outcome = outcomeOf(card, categories)
  const host = displayHost(card.label)
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
        {/* Selectable + right-click "Copy title / Copy URL". Toggles on click
            (dragging to select text doesn't fire a click). If there's an active
            selection, defer to the native copy menu instead. */}
        <div
          className="card__headmain"
          onClick={onToggle}
          onContextMenu={(e) => {
            if (window.getSelection()?.toString().trim()) return
            e.preventDefault()
            onContext(e.clientX, e.clientY, title ?? host, hostUrl(card.label))
          }}
        >
          <span className={`card__dot card__dot--${outcome}`} />
          {title && <span className="card__title">{title}</span>}
          <span className="card__host">{host}</span>
          <span className="card__msg">{card.message || statusText(card.status)}</span>
          {meta && <span className="card__meta">{meta}</span>}
          <span className="card__chev">{open ? '▾' : '▸'}</span>
        </div>
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
    case 'skipped':
      return 'skipped'
  }
}
