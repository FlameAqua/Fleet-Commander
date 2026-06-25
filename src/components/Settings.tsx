import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ApiError,
  getSettings,
  listShips,
  openFolder,
  pickFolder,
  saveSettings,
  uploadShip,
  type AppSettings,
} from '../api'
import { APP_VERSION, GITHUB_URL, RELEASE_NOTES } from '../releaseNotes'
import { openExternal } from '../lib/external'
import './settings.css'

export interface AnimPrefs {
  stars: boolean
  aurora: boolean
  clouds: boolean
  waves: boolean
  panel: boolean
}

export const DEFAULT_ANIM: AnimPrefs = {
  stars: true,
  aurora: true,
  clouds: true,
  waves: true,
  panel: true,
}

const ANIM_ROWS: { key: keyof AnimPrefs; label: string; tag?: string }[] = [
  { key: 'stars', label: 'Stars', tag: 'night' },
  { key: 'aurora', label: 'Aurora', tag: 'night' },
  { key: 'clouds', label: 'Clouds', tag: 'day' },
  { key: 'waves', label: 'Waves & ships' },
  { key: 'panel', label: 'Panel transitions' },
]

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}

function updateText(s: UpdateStatus | null): string {
  if (!s) return 'Click to check for a new version.'
  switch (s.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'none':
      return "You're on the latest version."
    case 'available':
      return `Update ${s.version ?? ''} found — downloading…`
    case 'downloading':
      return `Downloading update… ${s.percent ?? 0}%`
    case 'downloaded':
      return `Version ${s.version ?? ''} downloaded — ready to install.`
    case 'error':
      return `Update check failed: ${s.message ?? 'unknown error'}`
  }
}

interface Props {
  open: boolean
  onClose: () => void
  anim: AnimPrefs
  onAnimChange: (a: AnimPrefs) => void
  shipFreq: number
  onShipFreqChange: (n: number) => void
}

export function Settings({ open, onClose, anim, onAnimChange, shipFreq, onShipFreqChange }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [folderErr, setFolderErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ships, setShips] = useState<string[]>([])
  const [shipErr, setShipErr] = useState<string | null>(null)
  const shipInput = useRef<HTMLInputElement>(null)
  const [upd, setUpd] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    if (!open) return
    return window.electron?.onUpdateStatus?.(setUpd)
  }, [open])

  useEffect(() => {
    if (!open) return
    const load = () => {
      getSettings()
        .then(setSettings)
        .catch(() => setSettings(null))
      listShips()
        .then((r) => setShips(r.ships))
        .catch(() => setShips([]))
    }
    load()
    // Refresh when returning from Explorer (e.g. after Open folder + editing).
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [open])

  async function addShipArt(file: File) {
    setShipErr(null)
    setBusy(true)
    try {
      await uploadShip(file)
      const r = await listShips()
      setShips(r.ships)
      window.dispatchEvent(new Event('fc:ships-changed')) // tell Waves to refresh
    } catch (e) {
      setShipErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  async function changeFolder(which: 'csv' | 'scripts') {
    setFolderErr(null)
    setBusy(true)
    try {
      const path = await pickFolder(
        which === 'csv' ? 'Pick the CSV library folder' : 'Pick the scripts folder',
      )
      if (!path) return
      setSettings(await saveSettings(which === 'csv' ? { csv_dir: path } : { scripts_dir: path }))
    } catch (e) {
      setFolderErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function resetFolder(which: 'csv' | 'scripts') {
    setFolderErr(null)
    setBusy(true)
    try {
      setSettings(await saveSettings(which === 'csv' ? { csv_dir: null } : { scripts_dir: null }))
    } catch (e) {
      setFolderErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const setAnim = (key: keyof AnimPrefs, val: boolean) => onAnimChange({ ...anim, [key]: val })

  return createPortal(
    <div className="settings__overlay" onMouseDown={onClose}>
      <div className="settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <h3>Settings</h3>
          <button type="button" className="settings__close" onClick={onClose}>
            ✕
          </button>
        </div>

        <section className="settings__section">
          <h4>Animations</h4>
          <p className="settings__hint">
            Turn these off if the background renders poorly (e.g. over RDP).
          </p>
          {ANIM_ROWS.map((r) => (
            <label key={r.key} className="settings__toggle">
              <input
                type="checkbox"
                checked={anim[r.key]}
                onChange={(e) => setAnim(r.key, e.target.checked)}
              />
              <span>
                {r.label}
                {r.tag && <em className="settings__tag">{r.tag}</em>}
              </span>
            </label>
          ))}
        </section>

        <section className="settings__section">
          <h4>Folders</h4>
          <FolderRow
            label="CSV library"
            path={settings?.csv_dir}
            custom={settings?.csv_dir_custom}
            onChange={() => void changeFolder('csv')}
            onOpen={() => void openFolder('csv')}
            onReset={() => void resetFolder('csv')}
            busy={busy}
          />
          <FolderRow
            label="Scripts"
            path={settings?.scripts_dir}
            custom={settings?.scripts_dir_custom}
            onChange={() => void changeFolder('scripts')}
            onOpen={() => void openFolder('scripts')}
            onReset={() => void resetFolder('scripts')}
            busy={busy}
          />
          {folderErr && <div className="settings__err">{folderErr}</div>}
        </section>

        <section className="settings__section">
          <h4>Ship art</h4>
          <p className="settings__hint">
            Drop clip-art into the ships folder (PNG/JPG/GIF/SVG/WEBP, max 3&nbsp;MB each) and one
            is picked at random as the little ship — rendered up to 60×40&nbsp;px. {ships.length}{' '}
            image{ships.length === 1 ? '' : 's'} found.
          </p>
          <div className="settings__folderbtns">
            <button
              type="button"
              className="settings__btn"
              onClick={() => shipInput.current?.click()}
              disabled={busy}
            >
              Add art…
            </button>
            <button
              type="button"
              className="settings__btn"
              onClick={() => void openFolder('ships')}
              disabled={busy}
            >
              Open Folder
            </button>
            <input
              ref={shipInput}
              type="file"
              accept=".png,.jpg,.jpeg,.gif,.svg,.webp,image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void addShipArt(f)
              }}
            />
          </div>
          <label className="settings__slider">
            <span>Frequency</span>
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={shipFreq}
              onChange={(e) => onShipFreqChange(Number(e.target.value))}
            />
            <span className="settings__slidernum">{shipFreq <= 2 ? 'rare' : shipFreq >= 9 ? 'busy' : shipFreq}</span>
          </label>
          {shipErr && <div className="settings__err">{shipErr}</div>}
        </section>

        {window.electron?.onUpdateStatus && (
          <section className="settings__section">
            <h4>Updates</h4>
            <p className={`settings__hint${upd?.state === 'error' ? ' settings__upderr' : ''}`}>
              {updateText(upd)}
            </p>
            <div className="settings__folderbtns">
              <button
                type="button"
                className="settings__btn"
                disabled={upd?.state === 'checking' || upd?.state === 'downloading'}
                onClick={() => {
                  setUpd({ state: 'checking' })
                  window.electron?.checkForUpdate?.()
                }}
              >
                Check for updates
              </button>
              {upd?.state === 'downloaded' && (
                <button
                  type="button"
                  className="settings__btn"
                  onClick={() => window.electron?.installUpdate?.()}
                >
                  Restart &amp; install
                </button>
              )}
            </div>
          </section>
        )}

        <section className="settings__section">
          <h4>Release notes</h4>
          {RELEASE_NOTES.map((rn) => (
            <div key={rn.version} className="settings__rn">
              <div className="settings__rnhead">
                <b>{rn.version}</b>
                <span>{rn.date}</span>
              </div>
              <ul>
                {rn.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>

        <div className="settings__foot">
          <span className="settings__ver">Fleet Commander {window.electron?.appVersion || APP_VERSION}</span>
          <button type="button" className="settings__link" onClick={() => openExternal(GITHUB_URL)}>
            GitHub ↗
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function FolderRow({
  label,
  path,
  custom,
  onChange,
  onOpen,
  onReset,
  busy,
}: {
  label: string
  path?: string
  custom?: boolean
  onChange: () => void
  onOpen: () => void
  onReset: () => void
  busy: boolean
}) {
  return (
    <div className="settings__folder">
      <div className="settings__folderhead">
        <span className="settings__folderlabel">{label}</span>
        {custom && (
          <button type="button" className="settings__reset" onClick={onReset} disabled={busy}>
            Reset to default
          </button>
        )}
      </div>
      <code className="settings__path" title={path}>
        {path ?? '…'}
      </code>
      <div className="settings__folderbtns">
        <button type="button" className="settings__btn" onClick={onChange} disabled={busy}>
          Change…
        </button>
        <button type="button" className="settings__btn" onClick={onOpen} disabled={busy}>
          Open Folder
        </button>
      </div>
    </div>
  )
}
