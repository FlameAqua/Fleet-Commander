// Validate the auto-update feed exactly as electron-updater sees it: list
// releases from the (private) repo with a read-only token, find the newest
// (pre)release, and confirm it carries latest.yml + a Setup.exe installer.
//
// Usage (PowerShell):  $env:GH_TOKEN="<pat>"; node tools/check-update.mjs
// Usage (bash):        GH_TOKEN=<pat> node tools/check-update.mjs
const token = process.env.GH_TOKEN || process.env.UPDATE_TOKEN
const repo = 'FlameAqua/Fleet-Commander'

if (!token) {
  console.error('Set GH_TOKEN (or UPDATE_TOKEN) to your read-only PAT first.')
  process.exit(2)
}

const headers = {
  Authorization: `token ${token}`,
  'User-Agent': 'fleet-commander-update-check',
  Accept: 'application/vnd.github+json',
}

const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, { headers })
if (!res.ok) {
  console.error(`GitHub API error ${res.status}: ${(await res.text()).slice(0, 300)}`)
  console.error(res.status === 404 ? '→ token lacks access to this private repo, or repo path is wrong.' : '')
  process.exit(1)
}

const releases = await res.json()
if (!Array.isArray(releases) || releases.length === 0) {
  console.error('No releases found — publish one first.')
  process.exit(1)
}

const latest = releases.find((r) => !r.draft) ?? releases[0]
const names = (latest.assets || []).map((a) => a.name)
const hasYml = names.includes('latest.yml')
const hasExe = names.some((n) => /Setup\.exe$/i.test(n))

console.log(`Newest release : ${latest.tag_name}  (prerelease=${latest.prerelease}, draft=${latest.draft})`)
console.log(`Assets         : ${names.join(', ') || '(none)'}`)
console.log(`latest.yml     : ${hasYml ? 'yes ✓' : 'MISSING ✗'}`)
console.log(`installer .exe : ${hasExe ? 'yes ✓' : 'MISSING ✗'}`)
console.log(
  hasYml && hasExe
    ? '\n✓ Feed looks good — the installed app will be able to detect & download this version.'
    : '\n✗ Feed incomplete — electron-updater needs BOTH latest.yml and the Setup.exe on the release.',
)
process.exit(hasYml && hasExe ? 0 : 1)
