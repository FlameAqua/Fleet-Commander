export const GITHUB_URL = 'https://github.com/FlameAqua/Fleet-Commander'

/** Fallback version shown in Settings when the Electron bridge isn't present
 *  (dev/browser). In the packaged app the real app.getVersion() is used. */
export const APP_VERSION = '1.0.2'

export interface ReleaseNote {
  version: string
  date: string
  notes: string[]
}

/** Newest first. Shown in the Settings → Release notes section. */
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '1.0.2',
    date: '2026-08-26',
    notes: [
      'Fleet Commander now runs as a single instance — launching it again focuses the window that is already open instead of starting a second copy.',
      'Buttons, tabs and input fields react as you use them: hover lift, press feedback, and a clear accent ring when focused.',
      'The "Import CSV" tab is now "Import File", with separate "Import CSV" and "Import KeePass" buttons.',
      'Ships can be clicked to sink them again — the step column was covering the water, so only the very edges of the window worked.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-08-21',
    notes: [
      'Import a fleet straight from a KeePass .kdbx vault — pick the file, enter the master password, and the SSH-able entries load as hosts.',
      'New "Paste List" source: paste hosts one per line (or straight from a spreadsheet) with optional default user and password.',
      '"Input Manually" can now export what you typed as a CSV, or save it encrypted into your CSV folder for re-use.',
      'Upgrade System(s) covers Debian, OpenBSD and RouterOS, with an optional reboot to apply pending updates and RouterBOARD firmware.',
      'Custom Script editor rebuilt: shell syntax highlighting, line numbers, undo/redo, Ctrl+F find & replace, Tab to indent, and $column autocomplete.',
      'Pre-flight script checks warn about destructive commands, missing shebangs and Windows line endings before a run.',
      'Root password can be picked from a list of your CSV columns instead of typed by hand.',
      'Voyage Results: search across hosts, messages and log output, and click the outcome counts to filter by them.',
      'The Test Host tab is gone — set your own sandbox target in Settings and drop it into Input Manually with one click.',
      'Background effects no longer freeze in a pile over RDP, and Settings can force them on when Windows asks apps to reduce motion.',
      'The window now shows a loading screen instead of a white panel while the app starts.',
    ],
  },
  {
    version: '1.0.0-beta.7',
    date: '2026-07-08',
    notes: [
      'New three-stage voyage: Choose your Fleet → Choose Action → Voyage Results, navigable from the top.',
      'Overlay toast notifications replace the old in-place messages.',
      'Test Connection now opens instantly and fills in live, with pass/fail filters and a "deselect failed" button.',
      'Script Library categories: create, move, sort, and delete (scripts fall back to General).',
      'Column mapping moved into the CSV tools menu; RouterOS example hints in the script editor.',
      'Long-running scripts no longer time out; results have Stop, Expand-all, Back-to-top, and copy title/URL.',
      'Batch rollout is offered for any multi-system run; faster app launch.',
      'Reliability & security: corruption-proof host-key handling, window navigation lockdown, and updated crypto/SSH libraries.',
    ],
  },
  {
    version: '1.0.0-beta.1',
    date: '2026-06-25',
    notes: [
      'Settings panel: toggle each background animation individually and re-point the CSV & Scripts folders.',
      'RouterOS (MikroTik) interpreter option for the Custom Script action.',
      'CSV library: auto-encrypt on import, plus encrypt / decrypt / open-folder tools.',
      'Day & Night themes with starfield, aurora, drifting clouds, and waves.',
      'In-app auto-update: get notified when a new build is available.',
    ],
  },
]
