// Quick assertion tests for the ported CSV/credential helpers.
// Run: node --experimental-strip-types tools/test-csv.ts
import assert from 'node:assert'
import {
  parseCsv,
  csvCell,
  normaliseSshTarget,
  injectUserIntoUrl,
  canonicalLabel,
  buildCanonicalKeepass,
  canonicalCsvFromEntries,
  buildManualCsvs,
} from '../src/lib/csv.ts'

let passed = 0
function ok(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

ok('parseCsv handles quotes and commas', () => {
  const rows = parseCsv('a,"b,c","d""e"\n1,2,3\n')
  assert.deepEqual(rows, [['a', 'b,c', 'd"e'], ['1', '2', '3']])
})

ok('csvCell quotes when needed', () => {
  assert.equal(csvCell('plain'), 'plain')
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('he said "hi"'), '"he said ""hi"""')
})

ok('normaliseSshTarget accepts ssh/bare, rejects http', () => {
  assert.equal(normaliseSshTarget('ssh://root@h:22'), 'ssh://root@h:22')
  assert.equal(normaliseSshTarget('1.2.3.4'), 'ssh://1.2.3.4')
  assert.equal(normaliseSshTarget('user@host:2222'), 'ssh://user@host:2222')
  assert.equal(normaliseSshTarget('https://pbx.example'), null)
  assert.equal(normaliseSshTarget(''), null)
})

ok('injectUserIntoUrl rewrites/inserts user', () => {
  assert.equal(injectUserIntoUrl('ssh://root@h:22', 'bob'), 'ssh://bob@h:22')
  assert.equal(injectUserIntoUrl('ssh://h:22', 'bob'), 'ssh://bob@h:22')
  assert.equal(injectUserIntoUrl('1.2.3.4', 'bob'), 'ssh://bob@1.2.3.4')
})

ok('canonicalLabel mirrors parse_ssh_url defaults', () => {
  assert.equal(canonicalLabel('1.2.3.4'), 'ssh://root@1.2.3.4:22')
  assert.equal(canonicalLabel('ssh://bob@hello.com/'), 'ssh://bob@hello.com:22')
  assert.equal(canonicalLabel('ssh://root@h:2222'), 'ssh://root@h:2222')
})

ok('buildCanonicalKeepass parses the sample (3 hosts, host_vars)', () => {
  const sample = `"Account","Login Name","Password","Web Site","Comments"
"11111","root","SSH_PASSWORD","ssh://root@my.domain.test/","IP"
"22222","0000","SSH_PASSWORD","1.2.3.4","IP"
"33333","bob","SSH_PASSWORD","ssh://bob@hello.com/","x.x.x.x"
`
  const res = buildCanonicalKeepass(sample)
  assert.equal(res.entries.length, 3)
  // canonical CSV (rebuilt from entries) keeps the 5-col header
  const csv = canonicalCsvFromEntries(res.entries)
  assert.ok(csv.startsWith('Account,Login Name,Password,Web Site,Comments\n'))
  // bare host got ssh:// prefix
  const label = canonicalLabel('1.2.3.4') // ssh://root@1.2.3.4:22
  assert.ok(res.hostVars[label], 'host_vars keyed by canonical label')
  assert.equal(res.hostVars[label]['Account'], '22222')
  assert.equal(res.hostVars[label]['Comments'], 'IP')
  // every column incl. Password is exposed (matches original behavior)
  assert.equal(res.hostVars[label]['Password'], 'SSH_PASSWORD')
  assert.deepEqual(res.detectedColumns, ['Account', 'Login Name', 'Password', 'Web Site', 'Comments'])
})

ok('buildCanonicalKeepass useLogin swaps the SSH user', () => {
  const sample = `Web Site,Password,Login Name
ssh://root@host.test,pw,admin
`
  const res = buildCanonicalKeepass(sample, { useLogin: true })
  // canonical row's Web Site (4th col) should now use admin@
  const line = canonicalCsvFromEntries(res.entries).trim().split('\n')[1]
  assert.ok(line.includes('ssh://admin@host.test'), `got: ${line}`)
})

ok('buildManualCsvs builds ssh + pass CSVs, defaults user=root', () => {
  const { sshText, passText } = buildManualCsvs([
    { url: '1.2.3.4', user: '', password: 'secret' },
    { url: 'ssh://admin@h:2222', user: '', password: 'p2' },
  ])
  assert.ok(sshText.startsWith('url\n'))
  assert.ok(sshText.includes('ssh://root@1.2.3.4'))
  assert.ok(sshText.includes('ssh://admin@h:2222'))
  assert.ok(passText.startsWith('host,password\n'))
  assert.ok(passText.includes('secret'))
})

ok('buildManualCsvs throws when a password is missing', () => {
  assert.throws(() => buildManualCsvs([{ url: 'h', user: '', password: '' }]), /enter a password/)
})

console.log(`\n${passed} tests passed`)
