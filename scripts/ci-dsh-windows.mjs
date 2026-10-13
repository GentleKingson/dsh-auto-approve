#!/usr/bin/env node
// Minimal Windows host check. The host owns scoped sandbox grants; this script
// never changes global ACLs. Models are scripted and no credential is used.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PLUGIN_DIR, approvalChain, check, checkBinding, createModelServer, deepMerge, dshPackageJsonOf,
  dumpConfig, hostEnv, hostVersions, installLinkedPlugin, loadYaml, mockOverrides, parseArgs,
  prepareRoot, reject, results, runCase, setEvidenceDir, startAcp, userPatch, writeEvidence,
} from './ci-dsh-integration.mjs'

async function main() {
  const options = parseArgs(process.argv.slice(2))
  mkdirSync(options.evidence, { recursive: true })
  setEvidenceDir(options.evidence)
  if (process.platform !== 'win32') throw new Error('Windows host required')
  const { workspace, outside, dshHome } = prepareRoot(options.root)
  const env = hostEnv(dshHome)
  const manifest = dshPackageJsonOf(options.dsh)
  const yaml = loadYaml(manifest)
  const versions = hostVersions(manifest, { note: 'scripted endpoint; Windows native host' })
  writeEvidence('versions.json', versions)
  check('windows', 'host is the supported DSH release', versions.dsh === '0.2.0-rc.2')
  installLinkedPlugin(options, options.root, env, PLUGIN_DIR, 'plugin-install.log')
  const model = createModelServer()
  const port = await model.listen()
  let acp
  try {
    const patchFile = join(dshHome, 'profiles', 'acp', 'cordis.patch.yml')
    writeFileSync(patchFile, '[]\n')
    const defaults = dumpConfig(options, env, workspace, yaml.parse, 'default-config.yml')
    writeFileSync(patchFile, yaml.stringify(userPatch(defaults, deepMerge(mockOverrides(port), { 'auto-approve': { shadowMode: false } }))))
    acp = startAcp({ dsh: options.dsh, cwd: workspace, env, stderrPath: join(options.evidence, 'host.stderr.log'), label: 'windows' })
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    model.script('windows-confined', [{ name: 'pwsh', arguments: { command: 'git --version', description: 'Check Git inside the real Windows sandbox' } }])
    const confined = await runCase(acp, { workspace, caseName: 'windows-confined', prompt: 'Check Git.', onPermission: reject })
    const confinedChain = approvalChain(dshHome, confined.sessionId)
    const confinedResult = confinedChain.events.filter(item => item.type === 'tool/result').at(-1)?.data?.message
    check('windows', 'native pwsh ran successfully inside workspace-write, with no escalation', confinedResult?.isError === false && confinedChain.asked.length === 0, confinedResult)

    const args = { command: 'git --version', description: 'Check Git once with a native escalation', sandbox_permissions: 'danger-full-access', justification: 'Disposable Windows approval check.' }
    model.script('windows-auto', [{ name: 'pwsh', arguments: args }], '{"risk":"low","verdict":"approve","reasonCode":"routine"}')
    const automatic = await runCase(acp, { workspace, caseName: 'windows-auto', prompt: 'Check Git once.', onPermission: reject })
    const autoChain = approvalChain(dshHome, automatic.sessionId)
    check('windows', 'native pwsh approval uniquely binds the call and grants allowed-once without a client response', autoChain.asked.length === 1 && autoChain.calls.filter(call => call.callId === autoChain.asked[0].callId && call.arguments === JSON.stringify(args)).length === 1 && autoChain.decided.length === 1 && autoChain.decided[0].id === autoChain.asked[0].id && autoChain.decided[0].outcome === 'allowed-once' && automatic.permissions.length === 0, autoChain.decided)

    const target = join(outside, 'manual-target.txt')
    const writeArgs = { file_path: target, content: 'disposable', sandbox_permissions: 'danger-full-access', justification: 'Exercise the native manual fallback.' }
    model.script('windows-manual', [{ name: 'write', arguments: writeArgs }], '{"risk":"medium","verdict":"ask","reasonCode":"uncertain"}')
    const manual = await runCase(acp, { workspace, caseName: 'windows-manual', prompt: 'Exercise manual fallback.', onPermission: reject })
    checkBinding('windows', approvalChain(dshHome, manual.sessionId), manual.permissions, 'write', writeArgs, 'rejected')
    check('windows', 'native rejection prevents the outside file write', !existsSync(target))
  } catch (error) {
    check('windows', 'host check completed', false, String(error?.stack ?? error))
  } finally {
    if (acp) {
      const exit = await acp.shutdown()
      check('windows', 'all entries activated and host exits cleanly', exit.exitedCleanly && !/did not activate/.test(acp.stderr()))
      writeEvidence('acp.transcript.json', acp.transcript)
    }
    await model.close()
    writeEvidence('assertions.json', { passed: results.every(item => item.passed), results })
  }
  process.exitCode = results.every(item => item.passed) ? 0 : 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
