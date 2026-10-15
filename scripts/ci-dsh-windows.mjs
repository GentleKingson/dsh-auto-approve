#!/usr/bin/env node
// Native Windows host check on the one supported DSH release. The real host
// owns ACP, pwsh, the Windows ACL restricted-token sandbox and the approval
// service; only model responses come from a local scripted endpoint and no
// credential is used. This script never changes host ACLs, tokens or global
// settings: every path it touches lives under the disposable --root.
//
// Phases (each its own ACP process, so a failure is easy to place):
//   version-gate  exact peer install/refusal/startup skip (junction, not symlink)
//   config        composed profile, ACP initialize
//   shadow        sandbox probe, Shadow candidate, write/edit rejection, cancel
//   auto          real allowed-once side effects, local danger rules, unknown syntax
//   disabled      plugin disabled after restart: native approval only
//
// --evidence receives only redacted summaries (assertions, versions, runner
// environment, failure diagnostics). Raw ACP transcripts, session logs, host
// stderr and config dumps stay under --root, which CI discards.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PLUGIN_DIR, approvalChain, canonical, check, checkBinding, checkEffectiveConfig, classifierCalls, configEntry, createModelServer,
  deepMerge, dshPackageJsonOf, dumpConfig, eventData, hostEnv, hostVersions, installLinkedPlugin, loadYaml, mockOverrides,
  parseArgs, prepareRoot, reject, results, runCase, setEvidenceDir, setRedactor, startAcp, userPatch, versionGatePhase, within,
} from './ci-dsh-integration.mjs'

const LOW = '{"risk":"low","verdict":"approve","reasonCode":"routine"}'
const DENIAL = '[sandbox: file access denied under workspace-write mode]'
const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }

/** Known Windows sandbox failure classes; any of them fails the run and is reported, never bypassed. */
export function sandboxDiagnosis(text) {
  const found = []
  if (/3221225794|0xC0000142|STATUS_DLL_INIT_FAILED/i.test(text)) found.push('dll-init-failed-0xC0000142')
  if (/3762504530|0xE0434352/i.test(text)) found.push('clr-exception-0xE0434352')
  if (/SANDBOX_UNAVAILABLE|no sandbox backend is usable/i.test(text)) found.push('sandbox-unavailable')
  if (/sandbox runner itself failed|windows-acl-run:/i.test(text)) found.push('acl-runner-failed')
  return found
}

/** Replace host-identifying strings in public evidence and console details. */
export function makeScrubber(replacements) {
  const pairs = replacements.filter(([value]) => typeof value === 'string' && value.length >= 3)
    .flatMap(([value, label]) => [value, value.replaceAll('\\', '/'), value.replaceAll('\\', '\\\\')].map(variant => [variant, label]))
    .sort((a, b) => b[0].length - a[0].length)
  // Windows paths are case-insensitive, so the match is too.
  const text = input => pairs.reduce((out, [value, label]) => out.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), label), input)
  const deep = value => typeof value === 'string' ? text(value)
    : Array.isArray(value) ? value.map(deep)
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item)])) : value
  return { text, deep }
}

/** tool/result for one call id, from the native session log. */
function resultFor(chain, callId) {
  const item = chain.events.filter(event => event.type === 'tool/result').map(event => eventData(event).message).filter(message => message?.toolCallId === callId).at(-1)
  return item === undefined ? undefined : { isError: item.isError, text: (item.content ?? []).map(part => part.text ?? '').join('') }
}

function command(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30_000 })
  return result.status === 0 ? result.stdout.trim() : null
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (process.platform !== 'win32') throw new Error('Windows host required')
  mkdirSync(options.evidence, { recursive: true })
  const { workspace, outside, dshHome } = prepareRoot(options.root)
  // Raw host output stays in the disposable root; options.evidence is public.
  const privateEvidence = join(options.root, 'private-evidence')
  mkdirSync(privateEvidence)
  setEvidenceDir(privateEvidence)
  const scrub = makeScrubber([[options.root, '<root>'], [process.env.USERPROFILE, '<profile>'], [tmpdir(), '<tmp>'], [process.env.RUNNER_TEMP, '<runner-temp>'], [process.env.USERNAME, '<user>'], [process.env.COMPUTERNAME, '<host>']])
  setRedactor(scrub.text)
  const publish = (name, value) => writeFileSync(join(options.evidence, name), `${JSON.stringify(scrub.deep(value), null, 2)}\n`)

  const env = hostEnv(dshHome)
  const manifest = dshPackageJsonOf(options.dsh)
  const yaml = loadYaml(manifest)
  const versions = hostVersions(manifest, { note: 'scripted endpoint; Windows native host; not a real model' })
  publish('versions.json', versions)
  publish('environment.json', {
    os: `${process.platform} ${process.arch} ${release()}`,
    runnerImage: process.env.ImageOS ?? null, runnerImageVersion: process.env.ImageVersion ?? null,
    runnerOs: process.env.RUNNER_OS ?? null, runnerArch: process.env.RUNNER_ARCH ?? null,
    node: process.version, pwsh: command('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']),
    git: command('git', ['--version']), shell: 'pwsh (native, no WSL/Bash)',
  })
  console.log(`dsh ${versions.dsh}; plugin ${versions.plugin.version} @ ${versions.plugin.prHead ?? versions.plugin.checkoutHead}; ${versions.node}; image ${process.env.ImageOS ?? '?'} ${process.env.ImageVersion ?? '?'}`)

  const group = name => console.log(`::group::${name}`)
  const endGroup = () => console.log('::endgroup::')
  const model = createModelServer()
  const port = await model.listen()
  const patchFile = join(dshHome, 'profiles', 'acp', 'cordis.patch.yml')
  let defaults
  const patch = (extra = {}, disabled = []) => writeFileSync(patchFile, yaml.stringify(userPatch(defaults, deepMerge(mockOverrides(port), extra), disabled)))

  try {
    group('version-gate')
    check('version-gate', 'host is the supported DSH release', versions.dsh === '0.2.0-rc.2', versions.dsh)
    versionGatePhase({ options, root: options.root, versions })
    endGroup()

    group('config')
    installLinkedPlugin(options, options.root, env, PLUGIN_DIR, 'plugin-install.log')
    writeFileSync(patchFile, '[]\n')
    defaults = dumpConfig(options, env, workspace, yaml.parse, 'default-config.yml')
    patch()
    publish('effective-config-summary.json', checkEffectiveConfig('config', dumpConfig(options, env, workspace, yaml.parse, 'effective-config.yml')))
    // Negative sandbox targets must sit outside every writable root: the workspace and the host temp area.
    check('config', 'outside target is neither in the workspace nor in a Windows temp area', !within(outside, workspace) && [tmpdir(), process.env.TEMP, process.env.TMP].filter(Boolean).every(temp => !within(outside, temp)), { outside, temp: [tmpdir(), process.env.TEMP, process.env.TMP] })
    endGroup()

    group('shadow')
    await shadowPhase({ options, env, model, dshHome, workspace, outside })
    endGroup()

    group('auto')
    patch({ 'auto-approve': { shadowMode: false } })
    await autoPhase({ options, env, model, dshHome, workspace, outside, yaml })
    endGroup()

    group('disabled')
    patch({}, ['auto-approve'])
    await disabledPhase({ options, env, model, dshHome, workspace, outside, yaml })
    endGroup()
  } catch (error) {
    check('harness', 'Windows host check completed without an unexpected error', false, String(error?.stack ?? error))
  } finally {
    await model.close()
    const failed = results.filter(item => !item.passed)
    const phases = {}
    for (const item of results) {
      phases[item.case] ??= { passed: 0, failed: 0 }
      phases[item.case][item.passed ? 'passed' : 'failed'] += 1
    }
    const diagnostics = [...new Set(failed.flatMap(item => sandboxDiagnosis(JSON.stringify(item.detail ?? ''))))]
    const summary = {
      passed: results.length > 0 && failed.length === 0,
      scope: 'GitHub-hosted Windows runner, node.exe ACP host with a console; scripted model; not Desktop/Electron or console-less hosts',
      notVerified: ['DSH Desktop/Electron and console-less hosts (upstream discussions 9038, 9682)', 'real model behaviour', 'genuine human approval provenance', 'junction/symlink targets of escalated commands (classification is lexical)'],
      total: results.length, failed: failed.length, phases, diagnostics,
      failures: failed.map(item => ({ case: item.case, check: item.check, detail: item.detail })),
      results,
    }
    publish('assertions.json', summary)
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Windows DSH host ${summary.passed ? 'PASS' : 'FAIL'}: ${summary.total - summary.failed}/${summary.total}\n\n| phase | pass | fail |\n|---|---|---|\n${Object.entries(phases).map(([name, count]) => `| ${name} | ${count.passed} | ${count.failed} |`).join('\n')}\n${diagnostics.length ? `\nSandbox diagnostics: ${diagnostics.join(', ')}\n` : ''}`)
    }
    console.log(`\n${summary.passed ? 'PASS' : 'FAIL'}: ${summary.total - summary.failed}/${summary.total} checks passed`)
    process.exitCode = summary.passed ? 0 : 1
  }
}

/** Start one ACP host for a phase, run its cases, and always check a clean exit. */
async function withHost({ options, env, workspace, phase }, body) {
  const acp = startAcp({ dsh: options.dsh, cwd: workspace, env, stderrPath: join(options.root, 'private-evidence', `${phase}.stderr.log`), label: phase })
  try {
    const init = await acp.request('initialize', INIT)
    check(phase, 'ACP initialize negotiated protocol v1', init?.protocolVersion === 1, init)
    await body(acp)
  } catch (error) {
    check(phase, `${phase} phase ran to completion`, false, String(error?.stack ?? error))
  } finally {
    const exit = await acp.shutdown()
    writeFileSync(join(options.root, 'private-evidence', `${phase}.transcript.json`), JSON.stringify(acp.transcript))
    const failures = acp.stderr().split('\n').filter(line => /did not activate/.test(line)).slice(0, 10)
    check(phase, 'every composed entry activated and the host exited after stdin closed', exit.exitedCleanly && failures.length === 0, { exit, failures, diagnostics: sandboxDiagnosis(acp.stderr()) })
  }
}

async function shadowPhase({ options, env, model, dshHome, workspace, outside }) {
  await withHost({ options, env, workspace, phase: 'shadow' }, async acp => {
    // T02: no escalation, the real ACL sandbox decides. The same outside directory
    // later accepts an escalated write (auto phase), so a denial here is the sandbox.
    {
      const caseName = 'sandbox-probe'
      const inside = join(workspace, 'sandbox-probe-inside.txt')
      const blocked = join(outside, 'sandbox-probe-outside.txt')
      model.script(caseName, [
        { name: 'pwsh', arguments: { command: `Set-Content -LiteralPath '${inside}' -Value 'inside' -ErrorAction Stop`, description: 'Write a probe file in the workspace' } },
        { name: 'pwsh', arguments: { command: `Set-Content -LiteralPath '${blocked}' -Value 'outside' -ErrorAction Stop`, description: 'Write a probe file outside the workspace' } },
      ])
      const run = await runCase(acp, { workspace, caseName, prompt: 'Probe the sandbox.', onPermission: reject })
      const chain = approvalChain(dshHome, run.sessionId)
      const turns = model.log.filter(entry => entry.kind === 'agent' && entry.case === caseName)
      check(caseName, 'model was offered pwsh/write/edit with sandbox_permissions (confining sandbox composed, no bash)', ['pwsh', 'write', 'edit'].every(name => turns[0]?.escalatable?.includes(name)) && !turns[0]?.toolNames?.includes('bash'), turns[0])
      check(caseName, 'session pinned preset sandboxed-auto with approval policy ask', chain.events.some(event => event.type === 'permission/preset' && eventData(event).preset === 'sandboxed-auto') && chain.events.some(event => event.type === 'approval/policy' && eventData(event).policy === 'ask'))
      const [first, second] = chain.calls.map(call => resultFor(chain, call.callId))
      check(caseName, 'confined pwsh wrote inside the workspace', first?.isError === false && existsSync(inside) && readFileSync(inside, 'utf8').trim() === 'inside', first)
      check(caseName, 'confined pwsh could not write outside the workspace and temp areas', !existsSync(blocked), second)
      check(caseName, 'host reported the outside write as a workspace-write sandbox denial', second?.text.includes(DENIAL) === true, second)
      check(caseName, 'sandbox ran restricted: no SANDBOX_UNAVAILABLE, runner failure or 0xC0000142', sandboxDiagnosis(`${first?.text}\n${second?.text}`).length === 0, sandboxDiagnosis(`${first?.text}\n${second?.text}`))
      check(caseName, 'no approval was requested without an escalation', chain.asked.length === 0 && run.permissions.length === 0, { asked: chain.asked, permissions: run.permissions })
      check(caseName, 'prompt finished with end_turn', run.response?.stopReason === 'end_turn', run.response)
    }

    // T03: Shadow keeps a low/approve candidate on the native client; rejection has no effect.
    {
      const caseName = 'pwsh-shadow'
      const target = join(outside, 'shadow-repo')
      const args = { command: `git init '${target}'`, description: 'Create a repository outside the workspace', sandbox_permissions: 'danger-full-access', justification: 'Disposable Windows Shadow check.' }
      model.script(caseName, [{ name: 'pwsh', arguments: args }], LOW)
      const run = await runCase(acp, { workspace, caseName, prompt: 'Create the repository.', onPermission: reject })
      const classifier = classifierCalls(model, caseName)
      check(caseName, 'plugin classifier ran exactly once with the bound pwsh arguments and a low/approve verdict', classifier.length === 1 && classifier[0].toolName === 'pwsh' && classifier[0].toolArguments === JSON.stringify(args) && classifier[0].verdict === LOW, classifier)
      checkBinding(caseName, approvalChain(dshHome, run.sessionId), run.permissions, 'pwsh', args, 'rejected')
      check(caseName, 'rejected escalation did not create the repository', !existsSync(target))
    }

    // T05: native write and edit rejection leave no change.
    {
      const caseName = 'write-escalation'
      const target = join(outside, 'write-target.txt')
      const args = { file_path: target, content: 'should never be written\r\n', sandbox_permissions: 'danger-full-access', justification: 'Disposable Windows write rejection.' }
      model.script(caseName, [{ name: 'write', arguments: args }])
      const run = await runCase(acp, { workspace, caseName, prompt: 'Write the file.', onPermission: reject })
      check(caseName, 'plugin classifier ran for the write and handed it to the host', classifierCalls(model, caseName).length === 1 && classifierCalls(model, caseName)[0].toolName === 'write')
      checkBinding(caseName, approvalChain(dshHome, run.sessionId), run.permissions, 'write', args, 'rejected')
      check(caseName, 'rejected write left no file', !existsSync(target))
    }
    {
      const caseName = 'edit-escalation'
      const target = join(outside, 'edit-target.txt')
      const original = 'original content\r\nsecond line\r\n'
      writeFileSync(target, original)
      const args = { file_path: target, old_string: 'original content', new_string: 'changed content', sandbox_permissions: 'danger-full-access', justification: 'Disposable Windows edit rejection.' }
      model.script(caseName, [{ name: 'read', arguments: { file_path: target } }, { name: 'edit', arguments: args }])
      const run = await runCase(acp, { workspace, caseName, prompt: 'Edit the file.', onPermission: reject })
      check(caseName, 'plugin classifier ran for the edit and handed it to the host', classifierCalls(model, caseName).length === 1 && classifierCalls(model, caseName)[0].toolName === 'edit')
      checkBinding(caseName, approvalChain(dshHome, run.sessionId), run.permissions, 'edit', args, 'rejected')
      check(caseName, 'rejected edit left the CRLF content byte-identical', readFileSync(target, 'utf8') === original)
    }

    // T06: cancel while the approval is pending.
    {
      const caseName = 'cancel-pending'
      const target = join(outside, 'cancel-repo')
      const args = { command: `git init '${target}'`, description: 'Create a repository outside the workspace', sandbox_permissions: 'danger-full-access', justification: 'Disposable Windows cancellation check.' }
      model.script(caseName, [{ name: 'pwsh', arguments: args }], LOW)
      const run = await runCase(acp, {
        workspace, caseName, prompt: 'Create the repository, then wait.',
        onPermission: params => {
          acp.notify('session/cancel', { sessionId: params.sessionId })
          return { outcome: { outcome: 'cancelled' } }
        },
      })
      const chain = approvalChain(dshHome, run.sessionId)
      check(caseName, 'prompt settled with stopReason cancelled', run.response?.stopReason === 'cancelled', run.response)
      check(caseName, 'one approval reached the client for the bound call before cancellation', run.permissions.length === 1 && chain.asked.length === 1 && run.permissions[0].toolCall?.toolCallId === chain.asked[0].callId)
      check(caseName, 'native approval/decided outcome is cancelled', chain.decided.length === 1 && chain.decided[0].outcome === 'cancelled', chain.decided)
      check(caseName, 'cancelled escalation did not create the repository', !existsSync(target))
    }
  })
  check('cancel-pending', 'repository still absent after the host exited', !existsSync(join(outside, 'cancel-repo')))
}

async function autoPhase({ options, env, model, dshHome, workspace, outside, yaml }) {
  const tree = dumpConfig(options, env, workspace, yaml.parse, 'effective-config-auto.yml')
  const plugin = (Array.isArray(tree) ? tree : []).filter(entry => entry?.name === 'dsh-auto-approve')
  check('auto', 'effective plugin config: enabled, shadowMode false, sessionMemory false, approval policy ask', plugin.length === 1 && plugin[0].disabled !== true && plugin[0].config?.shadowMode === false && plugin[0].config?.sessionMemory === false && configEntry(tree, 'approval')[0]?.config?.policy === 'ask', plugin[0]?.config)
  await withHost({ options, env, workspace, phase: 'auto' }, async acp => {
    // T04: low-risk pwsh escalation is granted once without the client and really runs.
    {
      const caseName = 'auto-allowed-once'
      const target = join(outside, 'auto-repo')
      const args = { command: `git init '${target}'`, description: 'Create a repository outside the workspace', sandbox_permissions: 'danger-full-access', justification: 'Disposable Windows automatic approval check.' }
      model.script(caseName, [{ name: 'pwsh', arguments: args }], LOW)
      const run = await runCase(acp, { workspace, caseName, prompt: 'Create the repository.', onPermission: reject })
      const chain = approvalChain(dshHome, run.sessionId)
      const classifier = classifierCalls(model, caseName)
      check(caseName, 'plugin classifier ran exactly once with the bound pwsh arguments', classifier.length === 1 && classifier[0].toolName === 'pwsh' && classifier[0].toolArguments === JSON.stringify(args), classifier)
      check(caseName, 'no ACP session/request_permission reached the client', run.permissions.length === 0, run.permissions)
      const ask = chain.asked[0] ?? {}
      check(caseName, 'exactly one native approval/asked, bound to the scripted pwsh call', chain.asked.length === 1 && ask.toolName === 'pwsh' && chain.calls.filter(call => call.callId === ask.callId && call.arguments === JSON.stringify(args)).length === 1, chain.asked)
      check(caseName, 'native approval/decided outcome is allowed-once', chain.decided.length === 1 && chain.decided[0].id === ask.id && chain.decided[0].outcome === 'allowed-once', chain.decided)
      const result = resultFor(chain, ask.callId)
      check(caseName, 'tool/result for that call succeeded', result?.isError === false && sandboxDiagnosis(result.text).length === 0, result)
      check(caseName, 'the escalated command took effect outside the workspace', existsSync(join(target, '.git', 'HEAD')))
      check(caseName, 'prompt finished with end_turn', run.response?.stopReason === 'end_turn', run.response)
    }

    // T04: a real file write under exact medium user authorization (low risk is not enough for write).
    {
      const caseName = 'auto-authorized-write'
      const target = join(outside, '自动 写入.txt')
      const content = 'line 1\r\n第二行\r\n'
      const args = { file_path: target, content, sandbox_permissions: 'danger-full-access', justification: 'Disposable Windows authorized write.' }
      model.script(caseName, [{ name: 'write', arguments: args }], evidence => JSON.stringify({ risk: 'medium', verdict: 'approve', reasonCode: 'explicit-user-authorization', authorization: { messageId: evidence.latestUserMessageId, quote: evidence.latestUserMessage } }))
      model.setCurrentCase(caseName)
      let run
      try {
        run = await runCase(acp, { workspace, caseName, prompt: '', text: `Run: write ${JSON.stringify(args)}`, onPermission: reject })
      } finally {
        model.setCurrentCase(undefined)
      }
      const chain = approvalChain(dshHome, run.sessionId)
      check(caseName, 'classifier ran once and no client prompt was needed', classifierCalls(model, caseName).length === 1 && run.permissions.length === 0, run.permissions)
      check(caseName, 'native approval/decided outcome is allowed-once for the bound write', chain.asked.length === 1 && chain.decided.length === 1 && chain.decided[0].outcome === 'allowed-once' && chain.calls.filter(call => call.callId === chain.asked[0].callId && call.arguments === JSON.stringify(args)).length === 1, chain.decided)
      check(caseName, 'Unicode/space file name written with exact CRLF bytes', existsSync(target) && readFileSync(target, 'utf8') === content)
    }

    // T05: local rules decide before the model; the client rejects; nothing runs.
    const keep = join(outside, 'keep')
    mkdirSync(keep)
    const records = join(keep, 'records.csv')
    writeFileSync(records, 'id,value\r\n1,keep\r\n')
    const handoffs = [
      ['auto-git-force-push', 'git push origin main --force', 'Force-push the default branch', () => true],
      ['auto-protected-path', `git init '${join(outside, '.DSH', 'repo')}'`, 'Create a repository in a protected path (mixed case)', () => !existsSync(join(outside, '.DSH'))],
      ['auto-unknown-cmdlet', `Remove-Item -LiteralPath '${records}' -Force`, 'Delete a record file with a cmdlet', () => readFileSync(records, 'utf8') === 'id,value\r\n1,keep\r\n'],
      ['auto-unknown-syntax', `git --version | Out-File -FilePath '${records}'`, 'Overwrite a record file through a pipeline', () => readFileSync(records, 'utf8') === 'id,value\r\n1,keep\r\n'],
    ]
    for (const [caseName, commandText, description, unchanged] of handoffs) {
      const args = { command: commandText, description, sandbox_permissions: 'danger-full-access', justification: 'Disposable Windows manual fallback check.' }
      model.script(caseName, [{ name: 'pwsh', arguments: args }], LOW)
      const run = await runCase(acp, { workspace, caseName, prompt: 'Run the requested command.', onPermission: reject })
      const chain = approvalChain(dshHome, run.sessionId)
      check(caseName, 'local rule handed off before any classifier request', classifierCalls(model, caseName).length === 0, classifierCalls(model, caseName))
      checkBinding(caseName, chain, run.permissions, 'pwsh', args, 'rejected')
      const result = resultFor(chain, chain.asked[0]?.callId)
      check(caseName, 'rejected command did not run and the target is unchanged', result?.isError === true && /rejected/i.test(result.text) && unchanged(), result)
    }
  })
}

async function disabledPhase({ options, env, model, dshHome, workspace, outside, yaml }) {
  const caseName = 'plugin-disabled'
  const tree = dumpConfig(options, env, workspace, yaml.parse, 'effective-config-disabled.yml')
  const plugin = (Array.isArray(tree) ? tree : []).filter(entry => entry?.name === 'dsh-auto-approve')
  check(caseName, 'dsh-auto-approve entry is disabled after restart', plugin.length === 1 && plugin[0].disabled === true, plugin)
  await withHost({ options, env, workspace, phase: 'disabled' }, async acp => {
    const target = join(outside, 'disabled-repo')
    const args = { command: `git init '${target}'`, description: 'Create a repository outside the workspace', sandbox_permissions: 'danger-full-access', justification: 'Disposable Windows check with the plugin disabled.' }
    model.script(caseName, [{ name: 'pwsh', arguments: args }], LOW)
    const run = await runCase(acp, { workspace, caseName, prompt: 'Create the repository.', onPermission: reject })
    check(caseName, 'no classifier request reached the model (plugin not participating)', classifierCalls(model, caseName).length === 0, classifierCalls(model, caseName))
    checkBinding(caseName, approvalChain(dshHome, run.sessionId), run.permissions, 'pwsh', args, 'rejected')
    check(caseName, 'native rejection left no repository', !existsSync(target))
  })
}

// Run only as a script; tests import the pure helpers above.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(canonical(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1 })
}
