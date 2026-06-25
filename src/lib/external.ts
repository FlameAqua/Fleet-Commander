/** Open a URL in the user's default browser (never in-app). */
export function openExternal(url: string) {
  if (window.electron?.openExternal) window.electron.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}
