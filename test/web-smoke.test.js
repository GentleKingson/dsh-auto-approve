import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { PLUGIN_DIR } from '../scripts/ci-dsh-integration.mjs'
import { COMPLETED, HASHED_FILES, parseArgs, parseLaunchLine, redactTokens, verdicts } from '../scripts/ci-dsh-web-smoke.mjs'

test('launch line yields the origin and login URL; redaction strips every token', () => {
  const line = 'dsh web: http://127.0.0.1:43123/?token=Ab_c-12XYZ\n'
  const launch = parseLaunchLine(line)
  assert.equal(launch.origin, 'http://127.0.0.1:43123/')
  assert.equal(launch.port, 43123)
  assert.equal(launch.loginUrl, 'http://127.0.0.1:43123/?token=Ab_c-12XYZ')
  assert.equal(parseLaunchLine('dsh web: http://0.0.0.0:1/?token=x'), undefined)
  const redacted = redactTokens(`${line} again http://x/?a=1&token=Zz9`)
  assert.doesNotMatch(redacted, /Ab_c-12XYZ|Zz9/)
  assert.match(redacted, /\?token=<redacted>/)
  assert.match(redacted, /&token=<redacted>/)
})

test('a phase passes only when it completed and every row passed', () => {
  const row = (phase, passed = true, check = 'x') => ({ case: phase, check, passed })
  const phases = ['package', 'web-client', 'web-auto', 'web-manual', 'web-recovery']
  const complete = phases.flatMap(phase => [row(phase), row(phase, true, COMPLETED)])
  assert.equal(verdicts(complete).DEPLOYMENT_SMOKE_PASS, true)
  const cut = complete.filter(entry => !(entry.case === 'web-recovery' && entry.check === COMPLETED))
  assert.equal(verdicts(cut).WEB_RECOVERY_PASS, false)
  assert.equal(verdicts(cut).DEPLOYMENT_SMOKE_PASS, false)
  const harness = [...complete, row('harness', false)]
  assert.equal(verdicts(harness).WEB_CLIENT_PASS, true)
  assert.equal(verdicts(harness).DEPLOYMENT_SMOKE_PASS, false)
})

test('hashed runtime files are all shipped in the package', () => {
  const files = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).files
  for (const file of HASHED_FILES) assert.ok(file === 'package.json' || files.includes(file), file)
})

test('arguments are all required', () => {
  assert.throws(() => parseArgs(['--dsh', 'd', '--root', 'r', '--evidence', 'e']), /missing --playwright/)
  assert.throws(() => parseArgs(['--port', '1']), /usage/)
  assert.ok(parseArgs(['--dsh', 'd', '--playwright', 'p', '--root', 'r', '--evidence', 'e']).playwright.endsWith('/p'))
})
