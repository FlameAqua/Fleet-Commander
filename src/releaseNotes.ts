export const GITHUB_URL = 'https://github.com/FlameAqua/Fleet-Commander'

/** Fallback version shown in Settings when the Electron bridge isn't present
 *  (dev/browser). In the packaged app the real app.getVersion() is used. */
export const APP_VERSION = '1.0.0-beta.7'

export interface ReleaseNote {
  version: string
  date: string
  notes: string[]
}

/** Newest first. Shown in the Settings → Release notes section. */
export const RELEASE_NOTES: ReleaseNote[] = [
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
