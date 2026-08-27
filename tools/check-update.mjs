// Validate the auto-update feed exactly as electron-updater sees it.
//
// The repository is public and the app ships no token, so electron-updater's
// GitHubProvider resolves the stable channel through
// https://github.com/<owner>/<repo>/releases/latest and then downloads
// latest.yml from that release's assets. This script does the same, and checks
// the release carries both latest.yml and a Setup.exe — a release missing
// latest.yml looks fine on GitHub but silently breaks every client's update
// check.
//
// Usage:  node tools/check-update.mjs
//
// Optional: set GH_TOKEN to raise the unauthenticated API rate limit. It is
// NOT required, and the app never uses one.
const OWNER = 'FlameAqua'
const REPO = 'Fleet-Commander-App'

const headers = {
  'User-Agent': 'fleet-commander-update-check',
  Accept: 'application/vnd.github+json',
}
if (process.env.GH_TOKEN) headers.Authorization = `token ${process.env.GH_TOKEN}`

const api = `https://api.github.com/repos/${OWNER}/${REPO}`

async function main() {
  // 1. The stable channel: /releases/latest excludes pre-releases, which is
  //    what allowPrerelease=false relies on.
  const res = await fetch(`${api}/releases/latest`, { headers })
  if (res.status === 404) {
    console.error(
      `✕ No published (non-prerelease) release found at ${OWNER}/${REPO}.\n` +
        `  If the repo is private, the tokenless updater cannot read it at all.\n` +
        `  If every release is flagged "pre-release", clients on the stable channel see nothing.`,
    )
    process.exit(1)
  }
  if (!res.ok) {
    console.error(`✕ GitHub API ${res.status} ${res.statusText}`)
    process.exit(1)
  }
  const rel = await res.json()
  console.log(`latest release : ${rel.tag_name}  (prerelease=${rel.prerelease}, draft=${rel.draft})`)

  // 2. The assets electron-updater needs.
  const names = (rel.assets || []).map((a) => a.name)
  const yml = names.find((n) => n === 'latest.yml')
  const exe = names.find((n) => /Setup.*\.exe$/i.test(n))
  console.log(`assets         : ${names.join(', ') || '(none)'}`)

  let ok = true
  if (!yml) {
    console.error('✕ latest.yml is missing — clients will never see this release.')
    ok = false
  }
  if (!exe) {
    console.error('✕ No Setup .exe found — there is nothing for clients to install.')
    ok = false
  }

  // 3. latest.yml must be fetchable and name a version matching the tag.
  if (yml) {
    const dl = rel.assets.find((a) => a.name === 'latest.yml').browser_download_url
    const y = await fetch(dl, { headers: { 'User-Agent': headers['User-Agent'] } })
    if (!y.ok) {
      console.error(`✕ latest.yml is not downloadable (${y.status}).`)
      ok = false
    } else {
      const text = await y.text()
      const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim()
      console.log(`latest.yml     : version ${version}`)
      if (version && rel.tag_name.replace(/^v/, '') !== version) {
        console.error(`✕ Tag ${rel.tag_name} disagrees with latest.yml version ${version}.`)
        ok = false
      }
    }
  }

  console.log(ok ? '\n✓ Update feed looks healthy.' : '\n✕ Update feed is broken — see above.')
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('✕ Check failed:', e.message)
  process.exit(1)
})
