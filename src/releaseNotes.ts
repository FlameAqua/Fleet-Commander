export const GITHUB_URL = 'https://github.com/FlameAqua/Fleet-Commander'

/** App version shown in Settings. Keep in step with package.json "version". */
export const APP_VERSION = '1.0.0-beta.1'

export interface ReleaseNote {
  version: string
  date: string
  notes: string[]
}

/** Newest first. Shown in the Settings → Release notes section. */
export const RELEASE_NOTES: ReleaseNote[] = [
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
