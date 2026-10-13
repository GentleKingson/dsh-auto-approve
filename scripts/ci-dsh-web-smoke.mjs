#!/usr/bin/env node
// Deployment smoke for the Web client: packs this checkout with `npm pack`,
// installs the tarball through the pinned DSH's own plugin manager into a fresh
// DSH_HOME, serves the real `dsh web`, and drives it from Playwright Chromium.
// The browser picks the workspace, switches the session's access mode, sends
// the prompts and answers the native approval panel. Only model responses come
// from the local scripted endpoint of scripts/ci-dsh-integration.mjs; the Web
// app, sessions, tools, sandbox, approval service and plugin loader are the
// real host. Finally the plugin is uninstalled through the same plugin manager
// and the native manual approval path is checked again after a restart.
//
// Usage:
//   node scripts/ci-dsh-web-smoke.mjs --dsh <path to dsh bin> --playwright <dir with playwright installed>
//     --root <empty dir outside /tmp> --evidence <dir>
//
// The one-time login URL printed by `dsh web` is kept in memory only. Evidence
// holds assertions, hashes and filtered native events; no URL token, cookie,
// browser trace, screenshot or raw session log is written.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import {
  PLUGIN_DIR,
  approvalChain,
  check,
  classifierCalls,
  configEntry,
  createModelServer,
  dshPackageJsonOf,
  dumpConfig,
  eventData,
  hostEnv,
  hostVersions,
  loadYaml,
  mockOverrides,
  prepareRoot,
  readSessionLogs,
  results,
  sessionEvents,
  setEvidenceDir,
  setRedactor,
  userPatch,
  writeEvidence,
  MODEL_ID,
  MODEL_PROVIDER,
  canonical,
} from './ci-dsh-integration.mjs'

const PROFILE = 'web'
const PACKAGE_NAME = 'dsh-auto-approve'
const PRESET_ID = 'sandboxed-auto'
const PRESET_LABEL = 'Sandboxed Auto'
const BUILT_IN_LABELS = { 'read-only': 'Read Only', 'workspace-write': 'Workspace Write', 'danger-full-access': 'Full access' }
// Runtime files whose bytes must survive pack and install unchanged.
export const HASHED_FILES = ['package.json', 'index.js', 'danger-patterns.js', 'client.js', 'cordis.patch.yml', 'compile-evidence.js']
// The G07 fix: cached grants are keyed by the native permission state.
const CACHE_FIX_MARKER = "const permissionRevision = digest(events.filter(event => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event?.type)))"
const LOW_APPROVE = '{"risk":"low","verdict":"approve","reasonCode":"routine"}'
const UI_TIMEOUT_MS = 30_000
const TURN_TIMEOUT_MS = 90_000
export const WEB_CANCEL_NOT_VERIFIED = 'WEB_CANCEL_NOT_VERIFIED'
// Every phase records this last; a phase cut short by an exception never passes.
export const COMPLETED = 'phase ran to completion'

export function parseArgs(argv) {
  const options = {}
  const names = ['--dsh', '--playwright', '--root', '--evidence']
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!names.includes(name) || argv[index + 1] === undefined) {
      throw new Error(`usage: --dsh <bin> --playwright <dir> --root <dir> --evidence <dir> (bad argument ${JSON.stringify(name)})`)
    }
    options[name.slice(2)] = resolve(argv[index + 1])
    index += 1
  }
  for (const key of names.map(name => name.slice(2))) {
    if (options[key] === undefined) throw new Error(`missing --${key}`)
  }
  return options
}

/** The launch line `dsh web` prints; the token only ever lives in the returned value. */
export function parseLaunchLine(text) {
  const match = /dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/)\?token=([A-Za-z0-9_-]+)/.exec(text)
  if (match === null) return undefined
  return { origin: match[1], port: Number(match[2]), loginUrl: `${match[1]}?token=${match[3]}`, token: match[3] }
}

/** Remove one-time login tokens from anything that may reach logs or evidence. */
export function redactTokens(text) {
  return String(text).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<redacted>')
}

function fileSha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

async function waitFor(description, probe, timeoutMs = TURN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${description}`)
    await sleep(250)
  }
}

// ------------------------------------------------------------- host process

function startWeb({ dsh, cwd, env, label }) {
  const child = spawn(process.execPath, [dsh, '--profile', PROFILE, '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })))
  const launched = new Promise((resolveLaunch, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: dsh web printed no launch URL within 60 s`)), 60_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      const launch = parseLaunchLine(stdout)
      if (launch !== undefined) {
        clearTimeout(timer)
        resolveLaunch(launch)
      }
    })
    exited.then(({ code, signal }) => {
      clearTimeout(timer)
      reject(new Error(`${label}: dsh web exited before launch (code=${code} signal=${signal}): ${redactTokens(stderr).slice(0, 2000)}`))
    })
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  return {
    launched,
    stderr: () => redactTokens(stderr),
    stdout: () => redactTokens(stdout),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return { exitedCleanly: true, ...(await exited) }
      child.kill('SIGINT')
      const outcome = await Promise.race([exited, sleep(20_000).then(() => 'timeout')])
      if (outcome === 'timeout') {
        child.kill('SIGKILL')
        await exited
        return { exitedCleanly: false }
      }
      return { exitedCleanly: true, ...outcome }
    },
  }
}

function dshRun(options, args, env, cwd, log) {
  const result = spawnSync(process.execPath, [options.dsh, ...args], { cwd, env, encoding: 'utf8', timeout: 300_000 })
  writeEvidence(log, redactTokens(`status=${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`))
  return result
}

// ---------------------------------------------------------------- browser

// Records every native approval panel the page ever renders, so "no manual
// prompt" is an observation over the whole turn rather than a final snapshot.
const APPROVAL_RECORDER = () => {
  const seen = new Set()
  window.__dshApprovalPanels = []
  const scan = () => {
    for (const panel of document.querySelectorAll('[data-approval-key]')) {
      const session = panel.closest('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? null
      const id = `${session}|${panel.getAttribute('data-approval-key')}`
      if (seen.has(id)) continue
      seen.add(id)
      window.__dshApprovalPanels.push({ session, key: panel.getAttribute('data-approval-key'), text: (panel.innerText ?? '').slice(0, 1000) })
    }
  }
  new MutationObserver(scan).observe(document, { subtree: true, childList: true })
}

const TRIGGER = 'button[aria-label^="Access mode, current: "]'

async function openApp(context, launch) {
  const page = await context.newPage()
  await page.goto(launch.loginUrl)
  // The preview notice shows until it is acknowledged once per DSH home.
  const notice = page.getByRole('button', { name: 'Continue', exact: true })
  const app = page.getByRole('button', { name: 'Choose workspace' }).first()
  await notice.or(app).first().waitFor({ timeout: UI_TIMEOUT_MS })
  if (await notice.isVisible()) await notice.click()
  await app.waitFor({ timeout: UI_TIMEOUT_MS })
  return page
}

async function chooseWorkspace(page, workspace) {
  await page.getByRole('button', { name: 'Choose workspace' }).first().click()
  // A known workspace is offered in a menu; a fresh home opens the directory dialog.
  const dialog = page.getByRole('dialog')
  const known = page.getByRole('menu').getByRole('menuitem', { name: basename(workspace), exact: true })
  await dialog.or(known).first().waitFor({ timeout: UI_TIMEOUT_MS })
  if (await known.isVisible()) {
    await known.click()
    await page.locator(TRIGGER).waitFor({ timeout: UI_TIMEOUT_MS })
    return
  }
  await dialog.getByRole('button', { name: 'Edit path' }).click()
  const input = dialog.locator('input')
  await input.fill(workspace)
  await input.press('Enter')
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  await page.locator(TRIGGER).waitFor({ timeout: UI_TIMEOUT_MS })
}

async function currentSessionId(page) {
  return waitFor('the browser session id', () => page.locator('[data-conversation-session]').first().getAttribute('data-conversation-session'), UI_TIMEOUT_MS)
}

function sessionIdsOnDisk(dshHome) {
  return new Set(readSessionLogs(dshHome).filter(event => event.type === 'session').map(event => event.id))
}

/** The session the view shows, once it is one that did not exist before; the host may create it lazily. */
async function sessionIdNotIn(page, known) {
  return waitFor('a new browser session', async () => {
    const id = await page.locator('[data-conversation-session]').first().getAttribute('data-conversation-session', { timeout: 1000 }).catch(() => null)
    return id !== null && !known.has(id) ? id : undefined
  }, UI_TIMEOUT_MS)
}

/** Open a new session; returns the session ids that existed before it. */
async function newSession(page, dshHome) {
  const known = sessionIdsOnDisk(dshHome)
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  await page.locator(TRIGGER).waitFor({ timeout: UI_TIMEOUT_MS })
  return known
}

async function accessLabel(page) {
  const label = await page.locator(TRIGGER).getAttribute('aria-label')
  return label?.slice('Access mode, current: '.length)
}

async function menuLabels(page) {
  await page.locator(TRIGGER).click()
  const menu = page.getByRole('menu')
  await menu.waitFor({ timeout: UI_TIMEOUT_MS })
  const labels = (await menu.getByRole('menuitem').allInnerTexts()).map(text => text.trim())
  const pluginIcons = await page.locator('[data-dsh-auto-approve-icon]').count()
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden', timeout: UI_TIMEOUT_MS })
  return { labels, pluginIcons }
}

async function selectPreset(page, label) {
  await page.locator(TRIGGER).click()
  await page.getByRole('menu').getByRole('menuitem', { name: label, exact: true }).click()
  await waitFor(`access mode ${label}`, async () => (await accessLabel(page)) === label, UI_TIMEOUT_MS)
}

async function sendPrompt(page, text) {
  const input = page.locator('[data-composer-input]')
  await input.click()
  await page.keyboard.type(text)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
}

async function approvalPanels(page) {
  return page.evaluate(() => window.__dshApprovalPanels ?? [])
}

// ------------------------------------------------------------ native data

function turnEnds(dshHome, sessionId) {
  return sessionEvents(dshHome, sessionId).filter(event => event.type === 'turn/end').length
}

function presetEvents(dshHome, sessionId) {
  return sessionEvents(dshHome, sessionId).filter(event => event.type === 'permission/preset').map(event => eventData(event).preset)
}

/** The last native preset change and the user command that produced it. */
function lastPresetChange(dshHome, sessionId) {
  const events = sessionEvents(dshHome, sessionId)
  const index = events.findLastIndex(event => event.type === 'permission/preset')
  const command = events.slice(0, index).findLast(event => event.type === 'command/run')
  return { preset: index >= 0 ? eventData(events[index]).preset : undefined, command: command === undefined ? undefined : eventData(command) }
}

function toolResultFor(chain, callId) {
  return chain.events.filter(event => event.type === 'tool/result').map(eventData).find(data => data.message?.toolCallId === callId)
}

function filteredEvents(dshHome, sessionId) {
  return sessionEvents(dshHome, sessionId)
    .filter(event => /^(approval\/|permission\/|sandbox\/mode|command\/run|tool\/call$|tool\/result$|turn\/end)/.test(event.type))
    .map(event => {
      const data = eventData(event)
      if (event.type === 'tool/result') return { type: event.type, seq: event.seq, callId: data.message?.toolCallId, isError: data.message?.isError }
      return { type: event.type, seq: event.seq, data }
    })
}

// ---------------------------------------------------------------- phases

function packagePhase({ options, root, env, versions, yaml, workspace }) {
  const phase = 'package'
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
  check(phase, 'host is the pinned DSH_VERSION', process.env.DSH_VERSION === undefined || versions.dsh === process.env.DSH_VERSION, { host: versions.dsh, expected: process.env.DSH_VERSION })
  const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  check(phase, 'pnpm is the pinned PNPM_VERSION', pnpm.status === 0 && (process.env.PNPM_VERSION === undefined || pnpm.stdout.trim() === process.env.PNPM_VERSION), { pnpm: pnpm.stdout?.trim(), expected: process.env.PNPM_VERSION })
  check(phase, 'plugin peer @deepseek-ai/dsh is exactly the running host version', manifest.peerDependencies?.['@deepseek-ai/dsh'] === versions.dsh, manifest.peerDependencies)

  // A real tarball, not --dry-run.
  const packDir = join(root, 'pack')
  mkdirSync(packDir, { recursive: true })
  const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: PLUGIN_DIR, encoding: 'utf8', shell: process.platform === 'win32' })
  writeEvidence('npm-pack.log', `status=${pack.status}\n${pack.stderr ?? ''}`)
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`)
  const packed = JSON.parse(pack.stdout)[0]
  const tarball = join(packDir, packed.filename)
  check(phase, 'npm pack wrote a real tarball', existsSync(tarball) && lstatSync(tarball).size > 0 && packed.name === PACKAGE_NAME && packed.version === manifest.version, { filename: packed.filename, size: packed.size, entryCount: packed.entryCount })
  const extract = join(packDir, 'extract')
  mkdirSync(extract)
  const untar = spawnSync('tar', ['-xzf', tarball, '-C', extract], { encoding: 'utf8' })
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`)

  // Composition of a fresh Web profile before the plugin exists.
  const before = dumpConfig(options, env, workspace, yaml.parse, 'web-config-before-install.yml', PROFILE)
  const baselinePermission = configEntry(before, 'permission')[0]?.config ?? {}
  check(phase, 'fresh Web profile has no sandboxed-auto preset', baselinePermission.presets?.[PRESET_ID] === undefined && !before.some(entry => entry?.name === PACKAGE_NAME), Object.keys(baselinePermission.presets ?? {}))

  const install = dshRun(options, ['plugin', '--profile', PROFILE, 'add', tarball], env, root, 'plugin-install.log')
  check(phase, 'DSH plugin manager installed the tarball', install.status === 0, install.stderr?.split('\n').slice(0, 10))
  const profileDir = join(env.DSH_HOME, 'profiles', PROFILE)
  const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const spec = profileManifest.dependencies?.[PACKAGE_NAME]
  check(phase, 'profile dependency is the packed tarball, not a link:', typeof spec === 'string' && spec.startsWith('file:') && spec.endsWith('.tgz') && !spec.startsWith('link:'), spec)
  check(phase, 'profile bundles list the plugin', profileManifest.dsh?.profile?.bundles?.includes(PACKAGE_NAME) === true, profileManifest.dsh?.profile?.bundles)
  const installed = join(profileDir, 'node_modules', PACKAGE_NAME)
  check(phase, 'installed package is a real directory, not a symlink', existsSync(installed) && !lstatSync(installed).isSymbolicLink() && lstatSync(installed).isDirectory())

  const hashes = Object.fromEntries(HASHED_FILES.map(file => [file, {
    source: fileSha(join(PLUGIN_DIR, file)),
    tarball: existsSync(join(extract, 'package', file)) ? fileSha(join(extract, 'package', file)) : null,
    installed: existsSync(join(installed, file)) ? fileSha(join(installed, file)) : null,
  }]))
  writeEvidence('package-hashes.json', { tarball: packed.filename, tarballSha256: fileSha(tarball), files: hashes })
  for (const [file, hash] of Object.entries(hashes)) {
    check(phase, `${file} is byte-identical in source, tarball and installed copy`, hash.tarball === hash.source && hash.installed === hash.source, hash)
  }
  const installedIndex = readFileSync(join(installed, 'index.js'), 'utf8')
  const installedPatterns = readFileSync(join(installed, 'danger-patterns.js'), 'utf8')
  check(phase, 'installed code carries approval-v6', /export const POLICY_VERSION = 'approval-v6'/.test(installedPatterns))
  check(phase, 'installed code carries the cached-permission (G07) fix', installedIndex.includes(CACHE_FIX_MARKER))
  const installedManifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  check(phase, 'installed manifest keeps the exact dsh peer and Web client entry', installedManifest.peerDependencies?.['@deepseek-ai/dsh'] === versions.dsh && installedManifest.dsh?.client?.platform === 'web', { peer: installedManifest.peerDependencies, client: installedManifest.dsh?.client })

  const after = dumpConfig(options, env, workspace, yaml.parse, 'web-config-after-install.yml', PROFILE)
  const plugins = after.filter(entry => entry?.name === PACKAGE_NAME)
  check(phase, 'plugin is composed once (id auto-approve) and enabled', plugins.length === 1 && plugins[0].id === 'auto-approve' && plugins[0].disabled !== true, plugins)
  const shipped = plugins[0]?.config ?? {}
  check(phase, 'shipped plugin config is used: presetName sandboxed-auto, shadowMode false', shipped.presetName === PRESET_ID && shipped.shadowMode === false, shipped)
  const permission = configEntry(after, 'permission')[0]?.config ?? {}
  check(phase, 'sandboxed-auto is workspace-write + ask', permission.presets?.[PRESET_ID]?.sandbox === 'workspace-write' && permission.presets?.[PRESET_ID]?.approval === 'ask' && permission.presets?.[PRESET_ID]?.name === PRESET_LABEL, permission.presets?.[PRESET_ID])
  const others = presets => Object.fromEntries(Object.entries(presets ?? {}).filter(([id]) => id !== PRESET_ID))
  check(phase, 'every other official preset and the default preset are unchanged', isDeepStrictEqual(others(permission.presets), baselinePermission.presets) && permission.defaultPreset === baselinePermission.defaultPreset, { before: baselinePermission, after: permission })
  check(phase, COMPLETED, true)
  return { tarball, baselinePermission }
}

/** Mock model routing only: no plugin, preset or approval-policy override. */
function writeUserPatch({ options, env, workspace, yaml, port }) {
  const tree = dumpConfig(options, env, workspace, yaml.parse, 'web-config-before-user-patch.yml', PROFILE)
  const overrides = mockOverrides(port)
  for (const id of ['auto-approve', 'permission', 'acp']) delete overrides[id]
  const text = `# Written by scripts/ci-dsh-web-smoke.mjs for a disposable CI profile.\n${yaml.stringify(userPatch(tree, overrides))}`
  const file = join(env.DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
  writeFileSync(file, text)
  writeEvidence('cordis.patch.web.yml', text)
  const effective = dumpConfig(options, env, workspace, yaml.parse, 'web-config-effective.yml', PROFILE)
  check('package', 'effective approval policy ask and sandbox workspace-write (no never, no full access)', configEntry(effective, 'approval')[0]?.config?.policy === 'ask' && configEntry(effective, 'sandbox-policy')[0]?.config?.mode === 'workspace-write')
  return file
}

/** W02 + W03: the real browser drives session presets, an automatic approval and a manual rejection. */
async function enabledWebPhase({ options, env, dshHome, workspace, outside, model, chromium, yaml, userPatchFile, baselinePermission }) {
  const web = startWeb({ dsh: options.dsh, cwd: workspace, env, label: 'web-enabled' })
  const browser = await chromium.launch()
  let launch
  try {
    launch = await web.launched
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await context.addInitScript(APPROVAL_RECORDER)
    const page = await openApp(context, launch)

    // -- W02: page load and one-time authentication.
    {
      const phase = 'web-client'
      check(phase, 'dsh web bound 127.0.0.1 on an OS-assigned port', launch.port > 0)
      check(phase, 'one-time token is removed from the address bar after login', !page.url().includes('token='), redactTokens(page.url()))
      const cookies = await context.cookies()
      check(phase, 'session cookie is HttpOnly and SameSite=Strict', cookies.length > 0 && cookies.every(cookie => cookie.httpOnly && cookie.sameSite === 'Strict'), cookies.map(cookie => ({ name: cookie.name.replace(/-.*/, '-*'), httpOnly: cookie.httpOnly, sameSite: cookie.sameSite })))
      const unauthenticated = await fetch(`${launch.origin}api/`).then(response => response.status, error => String(error))
      check(phase, 'the API refuses a request without the session cookie', typeof unauthenticated === 'number' && unauthenticated >= 400, unauthenticated)

      await chooseWorkspace(page, workspace)
      const sessionId = await currentSessionId(page)
      check(phase, 'browser created a session in the isolated workspace', sessionEvents(dshHome, sessionId).some(event => event.type === 'session' && event.cwd === workspace), sessionId)
      const menu = await menuLabels(page)
      check(phase, 'access menu lists Sandboxed Auto beside the official presets', menu.labels.includes(PRESET_LABEL) && Object.values(BUILT_IN_LABELS).every(label => menu.labels.includes(label)), menu.labels)
      check(phase, 'plugin Web client module decorated the access menu', menu.pluginIcons > 0, menu)
      check(phase, 'a new session starts on the unchanged default preset', (await accessLabel(page)) === BUILT_IN_LABELS['workspace-write'] && presetEvents(dshHome, sessionId).at(-1) === 'workspace-write', presetEvents(dshHome, sessionId))

      for (const [preset, label] of [[PRESET_ID, PRESET_LABEL], ['workspace-write', BUILT_IN_LABELS['workspace-write']], [PRESET_ID, PRESET_LABEL]]) {
        await selectPreset(page, label)
        const change = await waitFor(`native permission/preset ${preset}`, () => {
          const last = lastPresetChange(dshHome, sessionId)
          return last.preset === preset ? last : undefined
        }, UI_TIMEOUT_MS)
        check(phase, `UI ${label} matches native permission/preset ${preset} from a user /permission command`, (await accessLabel(page)) === label && change.command?.name === 'permission' && change.command?.args?.trim() === preset && change.command?.source?.kind === 'user', change)
      }
      check(phase, 'native preset sequence is workspace-write → sandboxed-auto → workspace-write → sandboxed-auto', isDeepStrictEqual(presetEvents(dshHome, sessionId), ['workspace-write', PRESET_ID, 'workspace-write', PRESET_ID]), presetEvents(dshHome, sessionId))
      // The composer menu changes only this session; the user layer (General Settings) gains no permission entry.
      const userLayer = yaml.parse(readFileSync(userPatchFile, 'utf8'))
      const composed = configEntry(dumpConfig(options, env, workspace, yaml.parse, 'web-config-after-switching.yml', PROFILE), 'permission')[0]?.config ?? {}
      check(phase, 'session switching left the profile default preset untouched', !userLayer.some(entry => entry?.id === 'permission') && composed.defaultPreset === baselinePermission.defaultPreset, { userLayerIds: userLayer.map(entry => entry?.id), defaultPreset: composed.defaultPreset })

      check(phase, COMPLETED, true)

      // -- W03 test one, then the switch is shown to take effect both ways.
      await autoApprovalCases({ page, dshHome, outside, model, sessionId })
      writeEvidence('web-enabled-session-events.json', filteredEvents(dshHome, sessionId))
    }

    // -- W03 test two: a dangerous request falls back to the human, who rejects it in the browser.
    const manualSession = await sessionIdNotIn(page, await newSession(page, dshHome))
    await manualRejectCase({ page, dshHome, outside, model, sessionId: manualSession })
    writeEvidence('web-manual-session-events.json', filteredEvents(dshHome, manualSession))
    await context.close()
  } finally {
    await browser.close()
    const exit = await web.stop()
    writeEvidence('dsh-web-enabled.stderr.log', web.stderr())
    check('web-client', 'every composed entry activated (no loader activation failures)', !/did not activate/.test(web.stderr()), web.stderr().split('\n').filter(line => /did not activate|Error/.test(line)).slice(0, 20))
    check('web-client', 'dsh web exited cleanly on SIGINT', exit.exitedCleanly, exit)
  }
}

/** Escalation arguments for a harmless, observable write outside the workspace. */
function touchOutside(target, justification) {
  return { command: `touch ${target}`, description: 'Create a marker file outside the workspace', sandbox_permissions: 'danger-full-access', justification }
}

/** Steps accumulate per session: the scripted model indexes them by the tool calls already in the conversation. */
async function runTurn({ page, model, dshHome, sessionId, caseName, steps, prompt, verdict }) {
  model.script(caseName, steps, verdict)
  model.setCurrentCase(caseName)
  const ends = turnEnds(dshHome, sessionId)
  await sendPrompt(page, `[ci-case:${caseName}] ${prompt}`)
  return { ends }
}


async function autoApprovalCases({ page, dshHome, outside, model, sessionId }) {
  const phase = 'web-auto'
  const caseName = 'web-auto'
  const autoTarget = join(outside, 'web-auto-approved.txt')
  const manualTarget = join(outside, 'web-workspace-write.txt')
  const returnTarget = join(outside, 'web-auto-return.txt')
  const autoArgs = touchOutside(autoTarget, 'Web smoke: observable automatic approval.')
  const manualArgs = touchOutside(manualTarget, 'Web smoke: same request under workspace-write.')
  const returnArgs = touchOutside(returnTarget, 'Web smoke: automatic approval after switching back.')
  const step = args => ({ name: 'bash', arguments: args })
  const chainNow = () => approvalChain(dshHome, sessionId)

  check(phase, 'session is on Sandboxed Auto before the automatic case', (await accessLabel(page)) === PRESET_LABEL)
  let turn = await runTurn({ page, model, dshHome, sessionId, caseName, steps: [step(autoArgs)], prompt: 'Create the automatic-approval marker.', verdict: LOW_APPROVE })
  await waitFor('automatic turn end', () => turnEnds(dshHome, sessionId) > turn.ends)
  {
    const chain = chainNow()
    const classifier = classifierCalls(model, caseName)
    const agentTurns = model.log.filter(entry => entry.kind === 'agent' && entry.case === caseName && entry.toolNames.length > 0)
    check(phase, 'Web standard preset sent the scripted model bash/write/edit with sandbox_permissions', ['bash', 'write', 'edit'].every(name => agentTurns[0]?.escalatable?.includes(name)), agentTurns[0]?.escalatable)
    check(phase, 'one real bash tool/call with the scripted arguments', chain.calls.length === 1 && chain.calls[0].name === 'bash' && chain.calls[0].arguments === JSON.stringify(autoArgs), chain.calls)
    check(phase, 'plugin classifier ran exactly once on the scripted mock model', classifier.length === 1 && classifier[0].classifierModel === MODEL_ID && classifier[0].toolArguments === JSON.stringify(autoArgs), classifier)
    check(phase, 'exactly one native approval/asked bound to that call', chain.asked.length === 1 && chain.asked[0].callId === chain.calls[0]?.callId && chain.asked[0].toolName === 'bash', chain.asked)
    check(phase, 'native approval/decided is allowed-once', chain.decided.length === 1 && chain.decided[0].id === chain.asked[0]?.id && chain.decided[0].outcome === 'allowed-once', chain.decided)
    const result = toolResultFor(chain, chain.calls[0]?.callId)
    check(phase, 'tool/result for that call succeeded', result !== undefined && result.message?.isError === false, result?.message?.content)
    check(phase, 'the escalated command created the target file', existsSync(autoTarget))
    check(phase, 'the browser never rendered a manual approval panel', (await approvalPanels(page)).filter(panel => panel.session === sessionId).length === 0, await approvalPanels(page))
  }

  // Under workspace-write the same kind of request is the host's manual approval; the classifier stays out.
  await selectPreset(page, BUILT_IN_LABELS['workspace-write'])
  await waitFor('native workspace-write', () => lastPresetChange(dshHome, sessionId).preset === 'workspace-write', UI_TIMEOUT_MS)
  turn = await runTurn({ page, model, dshHome, sessionId, caseName, steps: [step(autoArgs), step(manualArgs)], prompt: 'Create the workspace-write marker.', verdict: LOW_APPROVE })
  const panel = page.locator('[data-approval-key]')
  await panel.waitFor({ timeout: TURN_TIMEOUT_MS })
  {
    const text = await panel.innerText()
    check(phase, 'after switching to Workspace Write the request reached the human panel', text.includes(manualArgs.command), text)
    check(phase, 'Workspace Write did not consult the classifier', classifierCalls(model, caseName).length === 1, classifierCalls(model, caseName))
    await panel.getByRole('button', { name: 'Reject', exact: true }).click()
    await waitFor('workspace-write turn end', () => turnEnds(dshHome, sessionId) > turn.ends)
    const chain = chainNow()
    check(phase, 'Workspace Write request was rejected natively and created nothing', chain.decided.at(-1)?.outcome === 'rejected' && chain.asked.at(-1)?.callId === chain.calls.at(-1)?.callId && !existsSync(manualTarget), chain.decided)
  }

  await selectPreset(page, PRESET_LABEL)
  await waitFor('native sandboxed-auto', () => lastPresetChange(dshHome, sessionId).preset === PRESET_ID, UI_TIMEOUT_MS)
  const panelsBefore = (await approvalPanels(page)).filter(entry => entry.session === sessionId).length
  turn = await runTurn({ page, model, dshHome, sessionId, caseName, steps: [step(autoArgs), step(manualArgs), step(returnArgs)], prompt: 'Create the return marker.', verdict: LOW_APPROVE })
  await waitFor('return turn end', () => turnEnds(dshHome, sessionId) > turn.ends)
  {
    const chain = chainNow()
    check(phase, 'back on Sandboxed Auto the classifier decides again', classifierCalls(model, caseName).length === 2 && classifierCalls(model, caseName)[1].toolArguments === JSON.stringify(returnArgs), classifierCalls(model, caseName))
    check(phase, 'back on Sandboxed Auto the request is allowed-once without a panel', chain.decided.at(-1)?.outcome === 'allowed-once' && existsSync(returnTarget) && (await approvalPanels(page)).filter(entry => entry.session === sessionId).length === panelsBefore, chain.decided)
    check(phase, 'three native approvals, each bound to its own tool call', chain.asked.length === 3 && chain.decided.length === 3 && chain.asked.every(ask => chain.calls.filter(call => call.callId === ask.callId).length === 1), chain.asked)
  }
  model.setCurrentCase(undefined)
  check(phase, COMPLETED, true)
}

async function manualRejectCase({ page, dshHome, outside, model, sessionId }) {
  const phase = 'web-manual'
  const caseName = 'web-manual'
  const protectedDir = join(outside, 'web-protected')
  const protectedFile = join(protectedDir, 'records.csv')
  const original = 'id,value\n1,keep\n'
  mkdirSync(protectedDir, { recursive: true })
  writeFileSync(protectedFile, original)
  const args = { command: `rm -rf ${protectedDir}`, description: 'Delete a directory outside the workspace', sandbox_permissions: 'danger-full-access', justification: 'Web smoke: dangerous request for the manual fallback.' }

  check(phase, 'new session starts on Workspace Write', (await accessLabel(page)) === BUILT_IN_LABELS['workspace-write'])
  await selectPreset(page, PRESET_LABEL)
  await waitFor('native sandboxed-auto', () => lastPresetChange(dshHome, sessionId).preset === PRESET_ID, UI_TIMEOUT_MS)
  // A permissive classifier verdict proves the local danger rule decides first.
  const turn = await runTurn({ page, model, dshHome, sessionId, caseName, steps: [{ name: 'bash', arguments: args }], prompt: 'Delete the protected directory.', verdict: LOW_APPROVE })
  const panel = page.locator('[data-approval-key]')
  await panel.waitFor({ timeout: TURN_TIMEOUT_MS })
  const text = await panel.innerText()
  const asked = await waitFor('native approval/asked', () => approvalChain(dshHome, sessionId).asked[0], UI_TIMEOUT_MS)
  check(phase, 'browser shows the native approval panel for the dangerous command in this session', text.includes(args.command) && text.includes(args.justification) && (await approvalPanels(page)).some(entry => entry.session === sessionId && entry.text.includes(args.command)), text)
  check(phase, 'stop control is hidden while the approval is pending (cancel not offered by the Web panel)', !(await page.locator('button[aria-label="Stop generating"]').isVisible()))
  check(phase, 'local danger rule decided before any classifier request', classifierCalls(model, caseName).length === 0, classifierCalls(model, caseName))
  await panel.getByRole('button', { name: 'Reject', exact: true }).click()
  await waitFor('manual turn end', () => turnEnds(dshHome, sessionId) > turn.ends)
  const chain = approvalChain(dshHome, sessionId)
  check(phase, 'exactly one tool/call with the scripted arguments', chain.calls.length === 1 && chain.calls[0].arguments === JSON.stringify(args), chain.calls)
  check(phase, 'approval/asked callId equals the tool/call callId', chain.asked.length === 1 && chain.asked[0].id === asked.id && chain.asked[0].callId === chain.calls[0]?.callId, chain.asked)
  check(phase, 'native approval/decided is rejected for that approval', chain.decided.length === 1 && chain.decided[0].id === asked.id && chain.decided[0].outcome === 'rejected', chain.decided)
  const result = toolResultFor(chain, asked.callId)
  check(phase, 'tool/result reports the rejection as an error', result?.message?.isError === true, result?.message?.content)
  check(phase, 'protected file is intact', existsSync(protectedFile) && readFileSync(protectedFile, 'utf8') === original)
  check(phase, 'the panel closed after the decision', (await page.locator('[data-approval-key]').count()) === 0)
  model.setCurrentCase(undefined)
  check(phase, COMPLETED, true)
}

/** W04: uninstall through the plugin manager, restart the same home, and check native manual approval. */
async function recoveryPhase({ options, env, root, dshHome, workspace, outside, model, chromium, yaml, baselinePermission, usedSessions }) {
  const phase = 'web-recovery'
  const remove = dshRun(options, ['plugin', '--profile', PROFILE, 'remove', PACKAGE_NAME], env, root, 'plugin-remove.log')
  check(phase, 'DSH plugin manager removed the plugin', remove.status === 0, remove.stderr?.split('\n').slice(0, 10))
  const profileDir = join(dshHome, 'profiles', PROFILE)
  const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  check(phase, 'profile no longer depends on or bundles the plugin', profileManifest.dependencies?.[PACKAGE_NAME] === undefined && !profileManifest.dsh?.profile?.bundles?.includes(PACKAGE_NAME), profileManifest)
  check(phase, 'installed package directory is gone', !existsSync(join(profileDir, 'node_modules', PACKAGE_NAME)))
  const tree = dumpConfig(options, env, workspace, yaml.parse, 'web-config-after-remove.yml', PROFILE)
  const permission = configEntry(tree, 'permission')[0]?.config ?? {}
  check(phase, 'plugin is no longer composed and sandboxed-auto is gone', !tree.some(entry => entry?.name === PACKAGE_NAME) && permission.presets?.[PRESET_ID] === undefined, Object.keys(permission.presets ?? {}))
  check(phase, 'official presets are restored exactly', isDeepStrictEqual(permission.presets, baselinePermission.presets) && permission.defaultPreset === baselinePermission.defaultPreset, permission)

  const web = startWeb({ dsh: options.dsh, cwd: workspace, env, label: 'web-recovery' })
  const browser = await chromium.launch()
  try {
    const launch = await web.launched
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await context.addInitScript(APPROVAL_RECORDER)
    const page = await openApp(context, launch)
    await chooseWorkspace(page, workspace)
    const known = await newSession(page, dshHome)
    check(phase, 'new session starts on Workspace Write', (await accessLabel(page)) === BUILT_IN_LABELS['workspace-write'])
    const menu = await menuLabels(page)
    check(phase, 'access menu no longer offers Sandboxed Auto', !menu.labels.includes(PRESET_LABEL) && Object.values(BUILT_IN_LABELS).every(label => menu.labels.includes(label)), menu.labels)
    check(phase, 'no plugin client decoration is loaded', menu.pluginIcons === 0, menu)

    const caseName = 'web-recovery'
    const target = join(outside, 'web-recovery.txt')
    const args = touchOutside(target, 'Web smoke: native approval after uninstall.')
    model.script(caseName, [{ name: 'bash', arguments: args }], LOW_APPROVE)
    model.setCurrentCase(caseName)
    await sendPrompt(page, `[ci-case:${caseName}] Create the recovery marker.`)
    // An empty session may be reused by "New session", so freshness is checked on the native log.
    const sessionId = await currentSessionId(page)
    const userMessages = await waitFor('the recovery prompt in the native log', () => {
      const messages = sessionEvents(dshHome, sessionId).filter(event => event.type === 'user/message' && eventData(event).source?.kind === 'user')
      return messages.length > 0 ? messages : undefined
    }, UI_TIMEOUT_MS)
    check(phase, 'recovery runs in a fresh session of the isolated workspace', !usedSessions.includes(sessionId) && userMessages.length === 1 && sessionEvents(dshHome, sessionId).some(event => event.type === 'session' && event.cwd === workspace), { sessionId, known: [...known].length, userMessages: userMessages.length })
    const panel = page.locator('[data-approval-key]')
    await panel.waitFor({ timeout: TURN_TIMEOUT_MS })
    const text = await panel.innerText()
    check(phase, 'native manual approval panel opens in the new session', text.includes(args.command) && (await approvalPanels(page)).some(entry => entry.session === sessionId), text)
    check(phase, 'no classifier request reached the model (plugin not active)', classifierCalls(model, caseName).length === 0, classifierCalls(model, caseName))
    await panel.getByRole('button', { name: 'Reject', exact: true }).click()
    await waitFor('recovery turn end', () => turnEnds(dshHome, sessionId) > 0)
    const chain = approvalChain(dshHome, sessionId)
    check(phase, 'native approval/decided is rejected and bound to the call', chain.asked.length === 1 && chain.decided.length === 1 && chain.decided[0].id === chain.asked[0].id && chain.decided[0].outcome === 'rejected' && chain.asked[0].callId === chain.calls[0]?.callId, { asked: chain.asked, decided: chain.decided })
    check(phase, 'rejection produced no file change', !existsSync(target))
    writeEvidence('web-recovery-session-events.json', filteredEvents(dshHome, sessionId))
    model.setCurrentCase(undefined)
    check(phase, COMPLETED, true)
    await context.close()
  } finally {
    await browser.close()
    const exit = await web.stop()
    writeEvidence('dsh-web-recovery.stderr.log', web.stderr())
    check(phase, 'every composed entry activated and the plugin was not loaded', !/did not activate/.test(web.stderr()) && !web.stderr().includes(PACKAGE_NAME), web.stderr().split('\n').filter(line => /did not activate|Error|dsh-auto-approve/.test(line)).slice(0, 20))
    check(phase, 'dsh web exited cleanly on SIGINT', exit.exitedCleanly, exit)
  }
}

// ------------------------------------------------------------------ main

export function verdicts(all) {
  const passed = phase => {
    const rows = all.filter(row => row.case === phase)
    return rows.some(row => row.check === COMPLETED) && rows.every(row => row.passed)
  }
  const summary = {
    PACKAGE_INSTALL_PASS: passed('package'),
    WEB_CLIENT_PASS: passed('web-client'),
    WEB_AUTO_APPROVAL_PASS: passed('web-auto'),
    WEB_MANUAL_FALLBACK_PASS: passed('web-manual'),
    WEB_RECOVERY_PASS: passed('web-recovery'),
  }
  summary.DEPLOYMENT_SMOKE_PASS = Object.values(summary).every(Boolean) && all.every(row => row.passed)
  return summary
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  mkdirSync(options.evidence, { recursive: true })
  setEvidenceDir(options.evidence)
  setRedactor(redactTokens)
  const { dshHome, workspace, outside } = prepareRoot(options.root)
  const { chromium } = createRequire(join(options.playwright, 'package.json'))('playwright')
  const playwrightVersion = createRequire(join(options.playwright, 'package.json'))('playwright/package.json').version
  const dshPackageJson = dshPackageJsonOf(options.dsh)
  const yaml = loadYaml(dshPackageJson)
  const versions = { ...hostVersions(dshPackageJson, { provider: MODEL_PROVIDER, model: MODEL_ID, note: 'scripted local endpoint; not a real model' }), client: { kind: 'web', browser: 'chromium', playwright: playwrightVersion } }
  writeEvidence('versions.json', versions)
  console.log(`dsh ${versions.dsh}; plugin ${versions.plugin.version} @ ${versions.plugin.prHead ?? versions.plugin.checkoutHead}; playwright ${playwrightVersion}; ${versions.node}`)

  const env = hostEnv(dshHome)
  const model = createModelServer()
  let failed = false
  try {
    const { baselinePermission } = packagePhase({ options, root: options.root, env, versions, yaml, workspace })
    const port = await model.listen()
    const userPatchFile = writeUserPatch({ options, env, workspace, yaml, port })
    await enabledWebPhase({ options, env, dshHome, workspace, outside, model, chromium, yaml, userPatchFile, baselinePermission })
    await recoveryPhase({ options, env, root: options.root, dshHome, workspace, outside, model, chromium, yaml, baselinePermission, usedSessions: [...sessionIdsOnDisk(dshHome)] })
  } catch (error) {
    check('harness', 'web smoke ran to completion without an unexpected error', false, redactTokens(String(error?.stack ?? error)))
    failed = true
  } finally {
    writeEvidence('model-requests.json', model.log)
    await model.close()
  }

  const statuses = verdicts(results)
  const summary = {
    passed: !failed && results.length > 0 && results.every(row => row.passed),
    statuses,
    notVerified: {
      [WEB_CANCEL_NOT_VERIFIED]: 'The Web approval panel offers only Reject and Allow once and hides the stop control while an approval is pending, so cancellation from the UI is not exercised.',
      desktopTui: 'NOT_VERIFIED',
      npmRegistryPackage: 'NOT_TESTED (the tarball comes from npm pack of this commit)',
      realModel: 'SUITE_D_NOT_PROVEN (model responses are scripted)',
    },
    scope: 'GitHub Actions Linux; real dsh web + Playwright Chromium; plugin installed from npm pack through the DSH plugin manager; scripted model responses',
    total: results.length,
    failed: results.filter(row => !row.passed).length,
    results,
  }
  writeEvidence('assertions.json', summary)
  for (const [name, value] of Object.entries(statuses)) console.log(`${name}=${value}`)
  console.log(`${WEB_CANCEL_NOT_VERIFIED}=true`)
  console.log(`\n${summary.passed ? 'PASS' : 'FAIL'}: ${summary.total - summary.failed}/${summary.total} checks passed; evidence in ${options.evidence}`)
  process.exitCode = summary.passed ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(canonical(process.argv[1])).href) {
  main().catch(error => {
    console.error(redactTokens(error?.stack ?? error))
    process.exitCode = 1
  })
}
