#!/usr/bin/env node
// Real-host integration check for CI: boots a pinned DeepSeek Harness (DSH)
// ACP server with this checkout linked as a plugin, answers model requests
// from a local scripted endpoint, and drives the native ACP approval channel.
// Only the model responses are controlled; sessions, the model adapter, tool
// execution, the sandbox, the approval service and the plugin loader are the
// real host. Every case uses files it creates under a fresh root and harmless
// commands (touch, write, edit). Any missing observation fails the run.
//
// Usage:
//   node scripts/ci-dsh-integration.mjs --dsh <path to dsh bin> --root <empty dir> --evidence <dir>
//
// The root must sit outside /tmp and os.tmpdir(): workspace-write may write
// there, so the "outside" sandbox target would prove nothing.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MODEL_PROVIDER = 'ci-mock'
export const MODEL_ID = 'ci-mock-model'
export const CLASSIFIER_MARKER = 'Classify a coding agent request for one-time sandbox escalation.'
const PROMPT_TIMEOUT_MS = 90_000
const EXIT_TIMEOUT_MS = 20_000

export function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!['--dsh', '--root', '--evidence'].includes(name) || argv[index + 1] === undefined) {
      throw new Error(`usage: --dsh <bin> --root <dir> --evidence <dir> (bad argument ${JSON.stringify(name)})`)
    }
    options[name.slice(2)] = resolve(argv[index + 1])
    index += 1
  }
  for (const key of ['dsh', 'root', 'evidence']) {
    if (options[key] === undefined) throw new Error(`missing --${key}`)
  }
  return options
}

export function within(child, parent) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export function canonical(path) {
  try { return realpathSync(path) } catch { return path }
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

// ---------------------------------------------------------------- evidence

export const results = []
let evidenceDir
let redact = text => text

/** Point evidence files at a directory; scripts/ci-dsh-live.mjs keeps them private. */
export function setEvidenceDir(dir) {
  evidenceDir = dir
}

/** Filter for failure details printed to the console. */
export function setRedactor(fn) {
  redact = fn
}

export function writeEvidence(name, value) {
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(join(evidenceDir, name), text)
}

export function check(caseName, description, condition, detail) {
  const passed = Boolean(condition)
  results.push({ case: caseName, check: description, passed, ...(detail === undefined ? {} : { detail }) })
  console.log(redact(`${passed ? 'PASS' : 'FAIL'} [${caseName}] ${description}${!passed && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`))
  return passed
}

// ------------------------------------------------------- scripted model

/** Local OpenAI-compatible endpoint: agent turns follow a fixed script per case, classifier turns return a fixed verdict. */
export function createModelServer() {
  const scripts = new Map()
  const classifierVerdicts = new Map()
  const log = []
  // Used when a prompt must be the user's exact words and cannot carry a [ci-case:...] tag.
  let currentCase
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        if (req.method === 'GET' && req.url.endsWith('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL_ID, object: 'model' }] }))
          return
        }
        if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
          res.writeHead(404).end()
          return
        }
        respond(JSON.parse(body), res)
      } catch (error) {
        log.push({ kind: 'server-error', error: String(error) })
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(error) } }))
      }
    })
  })

  function textOf(content) {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
    return ''
  }

  function respond(request, res) {
    const messages = Array.isArray(request.messages) ? request.messages : []
    const system = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => textOf(m.content)).join('\n')
    if (system.includes(CLASSIFIER_MARKER)) {
      const evidenceText = textOf(messages.find(m => m.role === 'user')?.content)
      let evidence
      try { evidence = JSON.parse(evidenceText) } catch { evidence = undefined }
      const caseName = /\[ci-case:([a-z0-9-]+)\]/.exec(evidence?.latestUserMessage ?? '')?.[1] ?? currentCase ?? 'unknown'
      const reply = classifierVerdicts.get(caseName) ?? '{"risk":"medium","verdict":"ask","reasonCode":"uncertain"}'
      const verdict = typeof reply === 'function' ? reply(evidence) : reply
      log.push({ kind: 'classifier', case: caseName, classifierModel: request.model, toolName: evidence?.toolName, toolArguments: evidence?.toolArguments, justification: evidence?.justification, workspacePath: evidence?.workspacePath, verdict })
      stream(res, { text: verdict })
      return
    }
    const userText = messages.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n')
    const caseName = /\[ci-case:([a-z0-9-]+)\]/.exec(userText)?.[1] ?? currentCase ?? 'unknown'
    const steps = scripts.get(caseName) ?? []
    const step = messages.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0).length
    const toolResults = messages.filter(m => m.role === 'tool').map(m => ({ toolCallId: m.tool_call_id, content: textOf(m.content) }))
    const tools = (request.tools ?? []).map(tool => tool?.function).filter(Boolean)
    const escalatable = tools.filter(fn => fn.parameters?.properties?.sandbox_permissions !== undefined).map(fn => fn.name)
    log.push({ kind: 'agent', case: caseName, step, toolResults, toolNames: tools.map(fn => fn.name), escalatable })
    if (step < steps.length) {
      const call = steps[step]
      stream(res, { toolCall: { id: `call_${caseName.replaceAll('-', '_')}_${step}`, name: call.name, arguments: JSON.stringify(call.arguments) } })
    } else {
      stream(res, { text: `case ${caseName} complete` })
    }
  }

  function stream(res, { text, toolCall }) {
    const id = `chatcmpl-${Math.random().toString(36).slice(2)}`
    const created = Math.floor(Date.now() / 1000)
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(chunk({ role: 'assistant', content: '' }, null))
    if (toolCall !== undefined) {
      res.write(chunk({ tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }] }, null))
      res.write(chunk({}, 'tool_calls'))
    } else {
      res.write(chunk({ content: text }, null))
      res.write(chunk({}, 'stop'))
    }
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: MODEL_ID, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  }

  return {
    log,
    script(caseName, steps, classifierVerdict) {
      scripts.set(caseName, steps)
      if (classifierVerdict !== undefined) classifierVerdicts.set(caseName, classifierVerdict)
    },
    setCurrentCase(caseName) {
      currentCase = caseName
    },
    listen() {
      return new Promise((resolvePort, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolvePort(server.address().port))
      })
    },
    close() {
      server.closeAllConnections?.()
      return new Promise(resolveClose => server.close(() => resolveClose()))
    },
  }
}

// ----------------------------------------------------------- ACP client

/** Minimal ACP (JSON-RPC 2.0 over newline-delimited stdio) client using only the standard v1 methods. */
export function startAcp({ dsh, cwd, env, stderrPath, label }) {
  const child = spawn(process.execPath, [dsh, '--profile', 'acp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const transcript = []
  const updates = []
  let permissionHandler = async () => ({ outcome: { outcome: 'cancelled' } })
  let nextId = 1
  let buffer = ''
  let stderr = ''
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })))

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr += chunk
    writeFileSync(stderrPath, stderr)
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length > 0) receive(line)
    }
  })
  exited.then(({ code, signal }) => {
    for (const { reject } of pending.values()) reject(new Error(`${label}: dsh exited (code=${code} signal=${signal}) with a request pending`))
    pending.clear()
  })

  function send(message) {
    transcript.push({ direction: 'client->agent', at: new Date().toISOString(), message })
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  function receive(line) {
    let message
    try { message = JSON.parse(line) } catch {
      transcript.push({ direction: 'agent->client', at: new Date().toISOString(), unparsed: line })
      return
    }
    transcript.push({ direction: 'agent->client', at: new Date().toISOString(), message })
    if (message.method !== undefined && message.id !== undefined) {
      handleRequest(message)
    } else if (message.method !== undefined) {
      if (message.method === 'session/update') updates.push(message.params)
    } else if (pending.has(message.id)) {
      const { resolve: resolveRequest, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error !== undefined) reject(Object.assign(new Error(`${message.error.message} ${JSON.stringify(message.error.data ?? '')}`), { rpc: message.error }))
      else resolveRequest(message.result)
    }
  }

  async function handleRequest(message) {
    if (message.method !== 'session/request_permission') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `client does not implement ${message.method}` } })
      return
    }
    try {
      const result = await permissionHandler(message.params)
      send({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } })
    }
  }

  function request(method, params, timeoutMs = PROMPT_TIMEOUT_MS) {
    const id = nextId
    nextId += 1
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${label}: ${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      pending.set(id, {
        resolve: value => { clearTimeout(timer); resolveRequest(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      send({ jsonrpc: '2.0', id, method, params })
    })
  }

  return {
    child,
    transcript,
    updates,
    stderr: () => stderr,
    exited,
    request,
    notify(method, params) { send({ jsonrpc: '2.0', method, params }) },
    onPermission(handler) { permissionHandler = handler },
    async shutdown() {
      child.stdin.end()
      const timeout = new Promise(resolveTimeout => setTimeout(() => resolveTimeout('timeout'), EXIT_TIMEOUT_MS))
      const outcome = await Promise.race([exited, timeout])
      if (outcome === 'timeout') {
        child.kill('SIGKILL')
        await exited
        return { exitedCleanly: false }
      }
      return { exitedCleanly: true, ...outcome }
    },
  }
}

// ------------------------------------------------------------ host data

export function readSessionLogs(dshHome) {
  const root = join(dshHome, 'sessions')
  const events = []
  const visit = dir => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) visit(path)
      else if (entry.endsWith('.jsonl')) {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (line.trim().length === 0) continue
          try { events.push({ file: relative(root, path), ...JSON.parse(line) }) } catch { /* torn tail */ }
        }
      }
    }
  }
  visit(root)
  return events
}

/** `!!js` expressions stay opaque: they are restated verbatim and never asserted as literal values. */
class JsExpression {
  constructor(source) { this.source = source }
}

export function loadYaml(dshPackageJson) {
  const require = createRequire(dshPackageJson)
  const yaml = require('js-yaml')
  const jsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: source => new JsExpression(source), instanceOf: JsExpression, represent: value => value.source })
  const schema = yaml.DEFAULT_SCHEMA.extend([jsType])
  return { parse: text => yaml.load(text, { schema }), stringify: value => yaml.dump(value, { schema, lineWidth: -1, noRefs: true }) }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof JsExpression)
}

export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const merged = { ...base }
  for (const [key, value] of Object.entries(override)) merged[key] = deepMerge(base[key], value)
  return merged
}

/**
 * A user-layer `config` replaces the composed entry config wholesale, so each
 * patched entry restates its composed (bundle) config with only the listed
 * keys changed. Restating keeps every other bundle value, e.g. the preset table.
 */
export function userPatch(defaultTree, overrides, disabled = []) {
  return Object.entries(overrides).map(([id, override]) => {
    const entries = configEntry(defaultTree, id)
    if (entries.length !== 1) throw new Error(`expected exactly one composed entry ${id}, found ${entries.length}`)
    return { id, ...(disabled.includes(id) ? { disabled: true } : {}), config: deepMerge(entries[0].config ?? {}, override) }
  })
}

export function packageVersion(require, name) {
  try { return require(`${name}/package.json`).version } catch { return null }
}

// ------------------------------------------------------------------ main

/** A fresh, empty root outside the workspace-write temp areas, with the three case directories. */
export function prepareRoot(root) {
  for (const temp of ['/tmp', tmpdir()]) {
    if (within(canonical(root), canonical(temp))) throw new Error(`--root ${root} is inside the workspace-write temp area ${temp}; choose a directory outside it`)
  }
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error(`--root ${root} must be empty`)
  const dirs = { dshHome: join(root, 'dsh-home'), workspace: join(root, 'workspace'), outside: join(root, 'outside') }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  return dirs
}

export function dshPackageJsonOf(dsh) {
  return join(dirname(canonical(dsh)), '..', 'package.json')
}

/** Host, plugin and runtime identity for the evidence. */
export function hostVersions(dshPackageJson, model) {
  const dshRequire = createRequire(dshPackageJson)
  const git = args => spawnSync('git', args, { cwd: PLUGIN_DIR, encoding: 'utf8' }).stdout?.trim() ?? null
  const runtimeFiles = ['index.js', 'danger-patterns.js', 'cordis.patch.yml', 'package.json']
  const versions = {
    date: new Date().toISOString(),
    os: `${process.platform} ${process.arch}`,
    node: process.version,
    dsh: JSON.parse(readFileSync(dshPackageJson, 'utf8')).version,
    hostPackages: Object.fromEntries(['@deepseek-ai/dsh-acp', '@deepseek-ai/dsh-user-approval', '@deepseek-ai/dsh-permission-presets', '@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/cordis'].map(name => [name, packageVersion(dshRequire, name)])),
    plugin: {
      version: JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version,
      // On pull_request runs the checkout is the test merge commit (GITHUB_SHA); the PR head is recorded separately.
      prHead: process.env.PR_HEAD_SHA || null,
      checkoutHead: git(['rev-parse', 'HEAD']),
      githubSha: process.env.GITHUB_SHA ?? null,
      dirty: (git(['status', '--porcelain', '--untracked-files=no']) ?? '').length > 0,
      // Same definition as scripts/approval-evaluation.mjs and docs/ACCEPTANCE.md.
      sourceSha256: sha256(JSON.stringify(runtimeFiles.map(file => [file, readFileSync(join(PLUGIN_DIR, file), 'utf8')]))),
    },
    model,
  }
  // pi-ai does not export its package.json; find the copy dsh-llm-pi-ai actually resolves.
  versions.hostPackages['@earendil-works/pi-ai'] = installedVersion(dshRequire.resolve('@deepseek-ai/dsh-llm-pi-ai'), '@earendil-works/pi-ai')
  return versions
}

/** Version of the package Node would resolve by name from a file, read from its node_modules directory. */
export function installedVersion(fromFile, name) {
  for (let dir = dirname(canonical(fromFile)); ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, 'utf8')).version ?? null
    if (dirname(dir) === dir) return null
  }
}

/** The host environment: a private DSH_HOME and no ambient model credentials. */
export function hostEnv(dshHome) {
  const env = { ...process.env, DSH_HOME: dshHome, CI_MOCK_API_KEY: 'ci-mock-key', DSH_TELEMETRY_MODE: 'DISABLED', NO_COLOR: '1' }
  delete env.DSH_PERMISSION_MODE
  for (const key of Object.keys(env)) if (/^(DEEPSEEK|OPENAI|ANTHROPIC)_/.test(key)) delete env[key]
  return env
}

/** Install a local package through the host's own plugin manager. */
export function installLinkedPlugin(options, cwd, env, dir, logName, profile = 'acp') {
  const install = spawnSync(process.execPath, [options.dsh, 'plugin', '--profile', profile, 'add', `link:${dir}`], { cwd, env, encoding: 'utf8', timeout: 300_000 })
  writeEvidence(logName, `${install.stdout ?? ''}\n${install.stderr ?? ''}`)
  if (install.status !== 0) throw new Error(`dsh plugin add ${dir} failed with status ${install.status}; see ${logName}`)
}

/** User-layer overrides for the disposable ACP profile; the scripted endpoint serves every model call. */
export function mockOverrides(port) {
  return {
    'auto-approve': { shadowMode: true, sessionMemory: false },
    permission: { defaultPreset: 'sandboxed-auto' },
    'sandbox-policy': { mode: 'workspace-write' },
    approval: { policy: 'ask' },
    // Plaintext session logs so the native approval events can be read back.
    'session-persistence-jsonl': { compression: 'none' },
    'llm-pi-ai': {
      providers: {
        [MODEL_PROVIDER]: {
          displayName: 'CI scripted model',
          api: 'openai-completions',
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: 'CI_MOCK_API_KEY',
          retryPolicy: { mode: 'normal', maxRetries: 0 },
          models: [{ id: MODEL_ID, contextWindow: 131072, maxTokens: 4096, reasoningEfforts: false }],
        },
      },
    },
    'agent-default-model': { provider: MODEL_PROVIDER, model: MODEL_ID },
    acp: { provider: MODEL_PROVIDER, model: MODEL_ID },
  }
}

/** Disposable host controls call native setters; they never forge session events or approvals. */
function writeMemoryControls(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-ci-memory-controls', version: '0.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: memory-controls\n      name: dsh-ci-memory-controls\n')
  writeFileSync(join(dir, 'index.js'), `export const inject = ['permissionPresets', 'agentDefaultModel']
export function apply(ctx) {
    ctx.on('agent/pre-step', async ({ agent, step }, next) => {
      const messages = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data?.source?.kind === 'user')
      const text = messages.at(-1)?.data?.content?.map(part => part.text ?? '').join('') ?? ''
      if (text.startsWith('[ci-case:memory-preset]')) {
        if (step === 3) ctx.permissionPresets.set(agent.session, 'workspace-write')
        if (step === 4) ctx.permissionPresets.set(agent.session, 'sandboxed-auto')
      }
      if (text.startsWith('[ci-case:memory-preset-roundtrip]') && step === 3) {
        ctx.permissionPresets.set(agent.session, 'workspace-write')
        ctx.permissionPresets.set(agent.session, 'sandboxed-auto')
      }
      if (text.startsWith('[ci-case:memory-model]') && (step === 3 || step === 4)) {
        await ctx.agentDefaultModel.saveSelection({ provider: '${MODEL_PROVIDER}', model: step === 3 ? '${MODEL_ID}-alternate' : '${MODEL_ID}' })
      }
      return next()
    })
  }`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  evidenceDir = options.evidence
  mkdirSync(evidenceDir, { recursive: true })
  const root = options.root
  const { dshHome, workspace, outside } = prepareRoot(root)

  const dshPackageJson = dshPackageJsonOf(options.dsh)
  const yamlCodec = loadYaml(dshPackageJson)
  const parseYaml = yamlCodec.parse
  const versions = hostVersions(dshPackageJson, { provider: MODEL_PROVIDER, model: MODEL_ID, note: 'scripted local endpoint; not a real model' })
  writeEvidence('versions.json', versions)
  console.log(`dsh ${versions.dsh}; pi-ai ${versions.hostPackages['@earendil-works/pi-ai']}; plugin ${versions.plugin.version} @ ${versions.plugin.prHead ?? versions.plugin.checkoutHead} (checkout ${versions.plugin.checkoutHead}); ${versions.node}`)

  const baseEnv = hostEnv(dshHome)

  // Install this checkout through the host's own plugin manager.
  installLinkedPlugin(options, root, baseEnv, PLUGIN_DIR, 'plugin-install.log')
  const memoryControls = join(root, 'memory-controls')
  writeMemoryControls(memoryControls)
  installLinkedPlugin(options, root, baseEnv, memoryControls, 'memory-controls-install.log')

  const model = createModelServer()
  const port = await model.listen()
  const profileDir = join(dshHome, 'profiles', 'acp')
  const patchFile = join(profileDir, 'cordis.patch.yml')
  let defaultTree
  const overrides = mockOverrides(port)
  const patch = (enabled, extra = {}) => `# Written by scripts/ci-dsh-integration.mjs for a disposable CI profile.\n${yamlCodec.stringify(userPatch(defaultTree, deepMerge(overrides, extra), enabled ? [] : ['auto-approve']))}`
  // Actual automatic approval: the scripted classifier is the only model, so no real credential is in this host.
  const autoPatch = () => patch(true, { 'auto-approve': { shadowMode: false } })

  let failed = false
  try {
    failed = !versionGatePhase({ options, root, versions }) || failed
    writeFileSync(patchFile, '[]\n')
    defaultTree = dumpConfig(options, baseEnv, workspace, parseYaml, 'composed-config-before-user-patch.yml')
    writeFileSync(patchFile, patch(true))
    writeEvidence('cordis.patch.enabled.yml', patch(true))
    failed = !(await enabledPhase({ options, model, baseEnv, dshHome, workspace, outside, parseYaml })) || failed
    writeFileSync(patchFile, autoPatch())
    writeEvidence('cordis.patch.auto.yml', autoPatch())
    failed = !(await autoPhase({ options, model, baseEnv, dshHome, workspace, outside, parseYaml })) || failed
    writeFileSync(patchFile, patch(true, {
      'auto-approve': { shadowMode: false, sessionMemory: true, provider: null, model: null },
      'llm-pi-ai': { providers: { [MODEL_PROVIDER]: { models: [MODEL_ID, `${MODEL_ID}-alternate`].map(id => ({ id, contextWindow: 131072, maxTokens: 4096, reasoningEfforts: false })) } } },
    }))
    failed = !(await memoryPhase({ options, model, baseEnv, dshHome, workspace, outside })) || failed
    writeFileSync(patchFile, patch(false))
    writeEvidence('cordis.patch.disabled.yml', patch(false))
    failed = !(await disabledPhase({ options, model, baseEnv, dshHome, workspace, outside, parseYaml })) || failed
  } catch (error) {
    check('harness', 'integration run completed without an unexpected error', false, String(error?.stack ?? error))
    failed = true
  } finally {
    writeEvidence('model-requests.json', model.log)
    writeEvidence('plugin-candidates.json', model.log.filter(entry => entry.kind === 'classifier'))
    await model.close()
    const events = readSessionLogs(dshHome)
    writeEvidence('approval-events.json', events.filter(event => typeof event.type === 'string' && /^(approval\/|permission\/|sandbox\/|tool\/call$|tool\/result$)/.test(event.type)))
  }

  const summary = {
    passed: !failed && results.length > 0 && results.every(result => result.passed),
    scope: 'GitHub Actions Linux + ACP covered host-integration items; model responses are scripted (not real model accuracy)',
    notVerified: ['Web/Desktop/TUI clients', 'deployed control-plane isolation', 'genuine human approval provenance', 'real model behaviour (see scripts/ci-dsh-live.mjs)', 'automatic approval driven by a real model'],
    total: results.length,
    failed: results.filter(result => !result.passed).length,
    results,
  }
  writeEvidence('assertions.json', summary)
  console.log(`\n${summary.passed ? 'PASS' : 'FAIL'}: ${summary.total - summary.failed}/${summary.total} checks passed; evidence in ${evidenceDir}`)
  process.exitCode = summary.passed ? 0 : 1
}

// ----------------------------------------------------------------- cases

export function configEntry(tree, id) {
  return (Array.isArray(tree) ? tree : []).filter(entry => entry?.id === id)
}

export function dumpConfig(options, env, cwd, parseYaml, file, profile = 'acp') {
  const dump = spawnSync(process.execPath, [options.dsh, '--profile', profile, '--dump-config'], { cwd, env, encoding: 'utf8', timeout: 120_000 })
  writeEvidence(file, dump.stdout ?? '')
  if (dump.status !== 0) throw new Error(`dsh --dump-config failed: ${dump.stderr}`)
  return parseYaml(dump.stdout)
}

/** One prompt in a fresh ACP session; the permission handler sees each request in order. */
export async function runCase(acp, { workspace, caseName, prompt, text = `[ci-case:${caseName}] ${prompt}`, onPermission }) {
  const permissions = []
  acp.onPermission(async params => {
    permissions.push(params)
    return onPermission(params, permissions.length)
  })
  const session = await acp.request('session/new', { cwd: workspace, mcpServers: [] })
  const firstUpdate = acp.updates.length
  const response = await acp.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] })
  const updates = acp.updates.slice(firstUpdate).filter(update => update.sessionId === session.sessionId)
  await acp.request('session/close', { sessionId: session.sessionId }).catch(() => undefined)
  return { sessionId: session.sessionId, response, permissions, updates }
}

export function sessionEvents(dshHome, sessionId) {
  return readSessionLogs(dshHome).filter(event => event.file.includes(sessionId))
}

export function eventData(event) {
  return event.data ?? event.payload ?? event
}

const INCOMPATIBLE_DSH = '0.0.0-ci-incompatible'

/**
 * Host identity and the exact dsh peer. The host's own compatibility check
 * must refuse to install, and refuse to load at startup, a copy of this
 * plugin whose @deepseek-ai/dsh peer does not match the running host.
 * Uses a separate DSH_HOME so the main profile is untouched.
 */
export function versionGatePhase({ options, root, versions }) {
  const phase = 'version-gate'
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
  const expected = process.env.DSH_VERSION
  check(phase, 'host is the pinned DSH_VERSION', expected === undefined || versions.dsh === expected, { host: versions.dsh, expected })
  check(phase, 'plugin peer @deepseek-ai/dsh is exactly the running host version', manifest.peerDependencies?.['@deepseek-ai/dsh'] === versions.dsh, manifest.peerDependencies)
  check(phase, 'dsh peer is optional for npm installs', manifest.peerDependenciesMeta?.['@deepseek-ai/dsh']?.optional === true, manifest.peerDependenciesMeta)
  check(phase, 'resolved pi-ai version recorded', typeof versions.hostPackages['@earendil-works/pi-ai'] === 'string', versions.hostPackages)

  const gateHome = join(root, 'gate-home')
  const copy = join(root, 'gate-plugin')
  const env = hostEnv(gateHome)
  try {
    mkdirSync(copy, { recursive: true })
    for (const file of manifest.files.filter(file => !file.startsWith('test/') && !['docs', 'scripts', 'README.md', 'README_EN.md'].includes(file))) cpSync(join(PLUGIN_DIR, file), join(copy, file), { recursive: true })
    // A junction needs no symlink privilege on Windows and resolves like the POSIX directory link.
    symlinkSync(join(PLUGIN_DIR, 'node_modules'), join(copy, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    const writePeer = range => writeFileSync(join(copy, 'package.json'), `${JSON.stringify({ ...manifest, peerDependencies: { ...manifest.peerDependencies, '@deepseek-ai/dsh': range } }, null, 2)}\n`)
    const dsh = (args, log) => {
      const result = spawnSync(process.execPath, [options.dsh, ...args], { cwd: root, env, encoding: 'utf8', timeout: 300_000 })
      writeEvidence(log, `status=${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
      return result
    }
    const composed = dump => /^\s*name: dsh-auto-approve$/m.test(dump.stdout ?? '')

    writePeer(INCOMPATIBLE_DSH)
    const refused = dsh(['plugin', '--profile', 'acp', 'add', `link:${copy}`], 'version-gate-install-incompatible.log')
    check(phase, 'host refuses to install a copy whose dsh peer does not match', refused.status !== 0 && /installation rejected/.test(refused.stderr) && /is incompatible with dsh/.test(refused.stderr), { status: refused.status, stderr: refused.stderr.split('\n').slice(0, 5) })

    writePeer(versions.dsh)
    const accepted = dsh(['plugin', '--profile', 'acp', 'add', `link:${copy}`], 'version-gate-install-exact.log')
    const loaded = dsh(['--profile', 'acp', '--dump-config'], 'version-gate-dump-exact.log')
    check(phase, 'host installs and composes the copy with the exact dsh peer', accepted.status === 0 && loaded.status === 0 && composed(loaded), { install: accepted.status, dump: loaded.status })

    writePeer(INCOMPATIBLE_DSH)
    const skipped = dsh(['--profile', 'acp', '--dump-config'], 'version-gate-dump-incompatible.log')
    check(phase, 'host skips the installed copy at startup once its dsh peer stops matching', skipped.status === 0 && !composed(skipped) && /skipping profile bundle "dsh-auto-approve"/.test(skipped.stderr) && /is incompatible with dsh/.test(skipped.stderr), { status: skipped.status, stderr: skipped.stderr.split('\n').slice(0, 5) })
  } catch (error) {
    check(phase, 'version gate phase ran to completion', false, String(error?.stack ?? error))
  }
  return results.filter(result => result.case === phase).every(result => result.passed)
}

/** Bind each approval to exactly one tool call with the scripted arguments, and return the decided outcomes. */
export function approvalChain(dshHome, sessionId) {
  const events = sessionEvents(dshHome, sessionId)
  const calls = events.filter(event => event.type === 'tool/call').map(eventData)
  const asked = events.filter(event => event.type === 'approval/asked').map(eventData)
  const decided = events.filter(event => event.type === 'approval/decided').map(eventData)
  return { events, calls, asked, decided }
}

export function checkBinding(caseName, chain, permissions, toolName, expectedArguments, expectedOutcome) {
  check(caseName, `exactly one native approval/asked for ${toolName}`, chain.asked.length === 1 && chain.asked[0].toolName === toolName, chain.asked)
  const ask = chain.asked[0] ?? {}
  const call = chain.calls.filter(item => item.callId === ask.callId)
  check(caseName, 'approval callId binds to exactly one tool/call', typeof ask.callId === 'string' && call.length === 1, { ask, calls: chain.calls.map(item => item.callId) })
  let parsed
  try { parsed = JSON.parse(call[0]?.arguments ?? 'null') } catch { parsed = undefined }
  check(caseName, 'bound tool/call carries the scripted arguments', call[0]?.name === toolName && JSON.stringify(parsed) === JSON.stringify(expectedArguments), call[0])
  check(caseName, 'approval reason is the native escalation reason', ask.reason === `escalate sandbox to danger-full-access: ${expectedArguments.justification}`, ask.reason)
  check(caseName, 'ACP session/request_permission reached the client once for that call', permissions.length === 1 && permissions[0].toolCall?.toolCallId === ask.callId, permissions)
  check(caseName, `native approval/decided outcome is ${expectedOutcome}`, chain.decided.length === 1 && chain.decided[0].id === ask.id && chain.decided[0].outcome === expectedOutcome, chain.decided)
}

export function classifierCalls(model, caseName) {
  return model.log.filter(entry => entry.kind === 'classifier' && entry.case === caseName)
}

export function lastToolResults(model, caseName) {
  const agentTurns = model.log.filter(entry => entry.kind === 'agent' && entry.case === caseName)
  return agentTurns.at(-1)?.toolResults ?? []
}

export const reject = () => ({ outcome: { outcome: 'selected', optionId: 'reject-once' } })

/** The composed default profile: plugin once, sandboxed-auto (workspace-write + ask) as default, shadow on, no memory. */
export function checkEffectiveConfig(phase, tree) {
  const plugins = (Array.isArray(tree) ? tree : []).filter(entry => entry?.name === 'dsh-auto-approve')
  check(phase, 'dsh-auto-approve is composed exactly once (id auto-approve)', plugins.length === 1 && plugins[0].id === 'auto-approve' && plugins[0].disabled !== true, plugins)
  const pluginConfig = plugins[0]?.config ?? {}
  check(phase, 'effective plugin config: presetName sandboxed-auto, shadowMode true, sessionMemory false', pluginConfig.presetName === 'sandboxed-auto' && pluginConfig.shadowMode === true && pluginConfig.sessionMemory === false, pluginConfig)
  const permission = configEntry(tree, 'permission')[0]?.config ?? {}
  check(phase, 'effective sandboxed-auto preset is workspace-write + ask and is the default preset', permission.defaultPreset === 'sandboxed-auto' && permission.presets?.['sandboxed-auto']?.sandbox === 'workspace-write' && permission.presets?.['sandboxed-auto']?.approval === 'ask', permission)
  check(phase, 'effective approval policy is ask (never would reject before any plugin)', configEntry(tree, 'approval')[0]?.config?.policy === 'ask', configEntry(tree, 'approval'))
  check(phase, 'effective sandbox policy is workspace-write', configEntry(tree, 'sandbox-policy')[0]?.config?.mode === 'workspace-write', configEntry(tree, 'sandbox-policy'))
  return { plugin: plugins, permission, approval: configEntry(tree, 'approval'), sandboxPolicy: configEntry(tree, 'sandbox-policy'), acp: configEntry(tree, 'acp') }
}

async function enabledPhase({ options, model, baseEnv, dshHome, workspace, outside, parseYaml }) {
  const phase = 'config'
  const tree = dumpConfig(options, baseEnv, workspace, parseYaml, 'effective-config.yml')
  writeEvidence('effective-config-summary.json', checkEffectiveConfig(phase, tree))

  const acp = startAcp({ dsh: options.dsh, cwd: workspace, env: baseEnv, stderrPath: join(evidenceDir, 'dsh-enabled.stderr.log'), label: 'enabled' })
  let ok = true
  try {
    const init = await acp.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    check(phase, 'ACP initialize negotiated protocol v1', init?.protocolVersion === 1, init)

    // -- sandbox probe: no escalation, the real sandbox decides.
    {
      const caseName = 'sandbox-probe'
      const inside = join(workspace, 'sandbox-probe-inside.txt')
      const blocked = join(outside, 'sandbox-probe-outside.txt')
      model.script(caseName, [
        { name: 'bash', arguments: { command: `touch ${inside}`, description: 'Create probe file in workspace' } },
        { name: 'bash', arguments: { command: `touch ${blocked}`, description: 'Create probe file outside workspace' } },
      ])
      const run = await runCase(acp, { workspace, caseName, prompt: 'Probe the sandbox.', onPermission: reject })
      const chain = approvalChain(dshHome, run.sessionId)
      const agentTurns = model.log.filter(entry => entry.kind === 'agent' && entry.case === caseName)
      check(caseName, 'model request offered bash/write/edit with sandbox_permissions (confining sandbox composed)', ['bash', 'write', 'edit'].every(name => agentTurns[0]?.escalatable?.includes(name)), agentTurns[0]?.escalatable)
      check(caseName, 'prompt finished with end_turn', run.response?.stopReason === 'end_turn', run.response)
      check(caseName, 'session pinned preset sandboxed-auto with approval policy ask', chain.events.some(event => event.type === 'permission/preset' && eventData(event).preset === 'sandboxed-auto') && chain.events.some(event => event.type === 'approval/policy' && eventData(event).policy === 'ask'), chain.events.filter(event => /^(permission|approval\/policy|sandbox)/.test(event.type)))
      check(caseName, 'workspace write inside the sandbox succeeded', existsSync(inside), lastToolResults(model, caseName))
      check(caseName, 'write outside workspace and temp areas was blocked', !existsSync(blocked), lastToolResults(model, caseName))
      check(caseName, 'no approval was requested without an escalation', chain.asked.length === 0 && run.permissions.length === 0, { asked: chain.asked, permissions: run.permissions })
      const results = lastToolResults(model, caseName)
      check(caseName, 'host reported the outside write as a sandbox denial, not an unavailable sandbox', results.length === 2 && results[1].content.includes('[sandbox: file access denied under workspace-write mode]') && !/SANDBOX_UNAVAILABLE/i.test(results.map(r => r.content).join('\n')), results)
    }

    // -- low-risk bash escalation: classifier runs, shadow candidate, client rejects.
    {
      const caseName = 'bash-shadow'
      const target = join(outside, 'bash-escalation.txt')
      const args = { command: `touch ${target}`, description: 'Create a marker file outside workspace', sandbox_permissions: 'danger-full-access', justification: 'CI integration check needs a write outside the workspace.' }
      model.script(caseName, [{ name: 'bash', arguments: args }], '{"risk":"low","verdict":"approve","reasonCode":"routine"}')
      const run = await runCase(acp, { workspace, caseName, prompt: 'Create the marker file.', onPermission: reject })
      const chain = approvalChain(dshHome, run.sessionId)
      const classifier = classifierCalls(model, caseName)
      check(caseName, 'plugin classifier ran exactly once with the bound tool arguments', classifier.length === 1 && classifier[0].toolName === 'bash' && classifier[0].toolArguments === JSON.stringify(args), classifier)
      // The plugin logs only to the host's in-memory logger and ACP has no command adapter for
      // /auto-report, so the shadow candidate is observed by behaviour: an approve verdict that
      // still reaches the native client instead of becoming allowed-once.
      check(caseName, 'classifier verdict was a low-risk approve (shadow candidate)', classifier[0]?.verdict === '{"risk":"low","verdict":"approve","reasonCode":"routine"}', classifier)
      checkBinding(caseName, chain, run.permissions, 'bash', args, 'rejected')
      check(caseName, 'rejected escalation did not create the target', !existsSync(target))
      check(caseName, 'prompt finished with end_turn', run.response?.stopReason === 'end_turn', run.response)
    }

    // -- write escalation: real file tool asks; reject leaves no file.
    {
      const caseName = 'write-escalation'
      const target = join(outside, 'write-target.txt')
      const args = { file_path: target, content: 'should never be written\n', sandbox_permissions: 'danger-full-access', justification: 'CI integration check writes outside the workspace.' }
      model.script(caseName, [{ name: 'write', arguments: args }])
      const run = await runCase(acp, { workspace, caseName, prompt: 'Write the file.', onPermission: reject })
      const chain = approvalChain(dshHome, run.sessionId)
      check(caseName, 'plugin classifier ran for the write request and handed it to the host', classifierCalls(model, caseName).length === 1 && classifierCalls(model, caseName)[0].toolName === 'write', classifierCalls(model, caseName))
      checkBinding(caseName, chain, run.permissions, 'write', args, 'rejected')
      check(caseName, 'rejected write left no file', !existsSync(target))
    }

    // -- edit escalation: read, then edit with escalation; reject keeps content.
    {
      const caseName = 'edit-escalation'
      const target = join(outside, 'edit-target.txt')
      const original = 'original content\n'
      writeFileSync(target, original)
      const args = { file_path: target, old_string: 'original content', new_string: 'changed content', sandbox_permissions: 'danger-full-access', justification: 'CI integration check edits outside the workspace.' }
      model.script(caseName, [
        { name: 'read', arguments: { file_path: target } },
        { name: 'edit', arguments: args },
      ])
      const run = await runCase(acp, { workspace, caseName, prompt: 'Edit the file.', onPermission: reject })
      const chain = approvalChain(dshHome, run.sessionId)
      check(caseName, 'plugin classifier ran for the edit request and handed it to the host', classifierCalls(model, caseName).length === 1 && classifierCalls(model, caseName)[0].toolName === 'edit', classifierCalls(model, caseName))
      checkBinding(caseName, chain, run.permissions, 'edit', args, 'rejected')
      check(caseName, 'rejected edit left the content unchanged', readFileSync(target, 'utf8') === original)
    }

    // -- cancel while the approval is pending.
    {
      const caseName = 'cancel-pending'
      const target = join(outside, 'cancel-target.txt')
      const args = { command: `touch ${target}`, description: 'Create a marker file outside workspace', sandbox_permissions: 'danger-full-access', justification: 'CI integration check cancels this approval.' }
      model.script(caseName, [{ name: 'bash', arguments: args }], '{"risk":"low","verdict":"approve","reasonCode":"routine"}')
      let sessionId
      const run = await runCase(acp, {
        workspace,
        caseName,
        prompt: 'Create the marker file, then wait.',
        onPermission: async params => {
          sessionId = params.sessionId
          acp.notify('session/cancel', { sessionId })
          // Per ACP, a client that cancels answers its pending permission request with cancelled.
          return { outcome: { outcome: 'cancelled' } }
        },
      })
      const chain = approvalChain(dshHome, run.sessionId)
      check(caseName, 'prompt settled with stopReason cancelled', run.response?.stopReason === 'cancelled', run.response)
      check(caseName, 'one approval reached the client before cancellation', run.permissions.length === 1 && chain.asked.length === 1 && run.permissions[0].toolCall?.toolCallId === chain.asked[0].callId, { permissions: run.permissions, asked: chain.asked })
      check(caseName, 'native approval/decided outcome is cancelled', chain.decided.length === 1 && chain.decided[0].outcome === 'cancelled', chain.decided)
      check(caseName, 'cancelled escalation did not create the target', !existsSync(target))
    }
  } catch (error) {
    ok = check(phase, 'enabled-plugin phase ran to completion', false, String(error?.stack ?? error)) && ok
  } finally {
    const exit = await acp.shutdown()
    writeEvidence('acp-enabled.transcript.json', acp.transcript)
    check(phase, 'every composed entry activated (no loader activation failures)', !/did not activate/.test(acp.stderr()), acp.stderr().split('\n').filter(line => /did not activate|Error/.test(line)).slice(0, 20))
    check('cancel-pending', 'dsh process exited after stdin closed', exit.exitedCleanly, exit)
    // Re-check after the process is gone: nothing ran late.
    check('cancel-pending', 'target still absent after process exit', !existsSync(join(outside, 'cancel-target.txt')))
  }
  return ok
}

async function autoPhase({ options, model, baseEnv, dshHome, workspace, outside, parseYaml }) {
  const phase = 'auto-config'
  const tree = dumpConfig(options, baseEnv, workspace, parseYaml, 'effective-config-auto.yml')
  const plugins = (Array.isArray(tree) ? tree : []).filter(entry => entry?.name === 'dsh-auto-approve')
  const pluginConfig = plugins[0]?.config ?? {}
  check(phase, 'effective plugin config: shadowMode false, sessionMemory false, approval policy ask', plugins.length === 1 && plugins[0].disabled !== true && pluginConfig.shadowMode === false && pluginConfig.sessionMemory === false && configEntry(tree, 'approval')[0]?.config?.policy === 'ask', { plugin: pluginConfig, approval: configEntry(tree, 'approval') })

  const acp = startAcp({ dsh: options.dsh, cwd: workspace, env: baseEnv, stderrPath: join(evidenceDir, 'dsh-auto.stderr.log'), label: 'auto' })
  let ok = true
  try {
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })

    // -- low/approve with shadow off: the plugin answers allowed-once and the host runs the command.
    {
      const caseName = 'auto-allowed-once'
      const target = join(outside, 'auto-allowed-once.txt')
      const args = { command: `touch ${target}`, description: 'Create a marker file outside workspace', sandbox_permissions: 'danger-full-access', justification: 'CI integration check of an actual automatic approval.' }
      model.script(caseName, [{ name: 'bash', arguments: args }], '{"risk":"low","verdict":"approve","reasonCode":"routine"}')
      const run = await runCase(acp, { workspace, caseName, prompt: 'Create the marker file.', onPermission: reject })
      const chain = approvalChain(dshHome, run.sessionId)
      const classifier = classifierCalls(model, caseName)
      check(caseName, 'plugin classifier ran exactly once with the bound tool arguments', classifier.length === 1 && classifier[0].toolName === 'bash' && classifier[0].toolArguments === JSON.stringify(args), classifier)
      check(caseName, 'no ACP session/request_permission reached the client', run.permissions.length === 0, run.permissions)
      check(caseName, 'exactly one native approval/asked for bash', chain.asked.length === 1 && chain.asked[0].toolName === 'bash', chain.asked)
      const ask = chain.asked[0] ?? {}
      const call = chain.calls.filter(item => item.callId === ask.callId)
      check(caseName, 'approval callId binds to the scripted tool/call', call.length === 1 && call[0].arguments === JSON.stringify(args), { ask, calls: chain.calls })
      check(caseName, 'native approval/decided outcome is allowed-once', chain.decided.length === 1 && chain.decided[0].id === ask.id && chain.decided[0].outcome === 'allowed-once', chain.decided)
      check(caseName, 'the escalated command ran: target file exists', existsSync(target), lastToolResults(model, caseName))
      check(caseName, 'prompt finished with end_turn', run.response?.stopReason === 'end_turn', run.response)
    }

    // -- high-risk command with shadow off: local rule hands off, the client rejects, nothing changes.
    {
      const caseName = 'auto-high-risk'
      const important = join(outside, 'auto-important')
      mkdirSync(important, { recursive: true })
      writeFileSync(join(important, 'records.csv'), 'id,value\n1,keep\n')
      const args = { command: `rm -rf ${important}`, description: 'Delete a directory outside workspace', sandbox_permissions: 'danger-full-access', justification: 'CI integration check of the manual fallback.' }
      model.script(caseName, [{ name: 'bash', arguments: args }], '{"risk":"low","verdict":"approve","reasonCode":"routine"}')
      const run = await runCase(acp, { workspace, caseName, prompt: 'Delete the directory.', onPermission: reject })
      const chain = approvalChain(dshHome, run.sessionId)
      check(caseName, 'local danger rule decided before any classifier request', classifierCalls(model, caseName).length === 0, classifierCalls(model, caseName))
      checkBinding(caseName, chain, run.permissions, 'bash', args, 'rejected')
      check(caseName, 'rejected deletion left the data in place', existsSync(join(important, 'records.csv')))
    }
  } catch (error) {
    ok = check(phase, 'auto-approval phase ran to completion', false, String(error?.stack ?? error)) && ok
  } finally {
    const exit = await acp.shutdown()
    writeEvidence('acp-auto.transcript.json', acp.transcript)
    check(phase, 'every composed entry activated (no loader activation failures)', !/did not activate/.test(acp.stderr()), acp.stderr().split('\n').filter(line => /did not activate|Error/.test(line)).slice(0, 20))
    check(phase, 'dsh process exited after stdin closed', exit.exitedCleanly, exit)
  }
  return ok
}

/** Real ACP sessions and native approvals; only model responses are controlled. */
async function memoryPhase({ options, model, baseEnv, dshHome, workspace, outside }) {
  const phase = 'session-memory'
  const acp = startAcp({ dsh: options.dsh, cwd: workspace, env: baseEnv, stderrPath: join(evidenceDir, 'dsh-memory.stderr.log'), label: phase })
  const low = '{"risk":"low","verdict":"approve","reasonCode":"routine"}'
  const target = join(outside, 'memory-marker')
  const args = { command: `touch ${target}`, description: 'Create a disposable memory marker', sandbox_permissions: 'danger-full-access', justification: 'User authorized this disposable marker.' }
  const step = arguments_ => ({ name: 'bash', arguments: arguments_ })
  let ok = true
  try {
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    const subdir = join(workspace, 'memory-subdir')
    mkdirSync(subdir)
    const name = 'memory-bindings'
    // Exact replay, new arguments, new workdir, then the original context again.
    model.script(name, [step(args), step(args), step({ ...args, command: `touch ${target}-other` }), step({ ...args, workdir: subdir }), step(args)], low)
    const first = await runCase(acp, { workspace, caseName: name, prompt: 'Create these disposable markers.', onPermission: reject })
    const chain = approvalChain(dshHome, first.sessionId)
    const classifiers = classifierCalls(model, name)
    check(phase, 'five native requests all allowed-once with no client prompt', chain.asked.length === 5 && chain.decided.length === 5 && chain.decided.every(item => item.outcome === 'allowed-once') && first.permissions.length === 0, chain.decided)
    check(phase, 'only exact same-context replay saves a classification; argument and workdir changes reclassify', classifiers.length === 4 && classifiers[0].toolArguments === JSON.stringify(args) && classifiers[1].toolArguments.includes('-other') && classifiers[2].toolArguments.includes('workdir') && classifiers[3].toolArguments === JSON.stringify(args), classifiers)
    check(phase, 'cached and reclassified approvals remain uniquely bound to native calls', chain.asked.every(ask => chain.calls.filter(call => call.callId === ask.callId).length === 1))

    // Same text/arguments but new session: no memory carries across.
    model.script('memory-session', [step(args)], low)
    const second = await runCase(acp, { workspace, caseName: 'memory-session', prompt: 'Create these disposable markers.', onPermission: reject })
    check(phase, 'another native session classifies instead of inheriting a grant', second.sessionId !== first.sessionId && classifierCalls(model, 'memory-session').length === 1)
    const otherWorkspace = join(workspace, 'memory-workspace')
    mkdirSync(otherWorkspace)
    model.script('memory-workspace', [step(args)], low)
    const third = await runCase(acp, { workspace: otherWorkspace, caseName: 'memory-workspace', prompt: 'Create these disposable markers.', onPermission: reject })
    check(phase, 'new working directory reaches the classifier with the new native workspace', classifierCalls(model, 'memory-workspace').length === 1 && classifierCalls(model, 'memory-workspace')[0].workspacePath === otherWorkspace && approvalChain(dshHome, third.sessionId).decided[0]?.outcome === 'allowed-once')

    // Native host setters change the preset and deployment classifier model mid-turn.
    // The controller is trusted test code, not evidence of browser UI behavior.
    model.script('memory-preset', [step(args), step(args), step(args), step(args), step(args)], low)
    const policy = await runCase(acp, { workspace, caseName: 'memory-preset', prompt: 'Check native preset transitions.', onPermission: reject })
    const policyChain = approvalChain(dshHome, policy.sessionId)
    check(phase, 'native preset exit and return discard the old grant', classifierCalls(model, 'memory-preset').length === 2 && policy.permissions.length === 1 && JSON.stringify(policyChain.decided.map(item => item.outcome)) === JSON.stringify(['allowed-once', 'allowed-once', 'rejected', 'allowed-once', 'allowed-once']), policyChain.decided)
    check(phase, 'preset transition evidence comes from the native durable setter', JSON.stringify(policyChain.events.filter(item => item.type === 'permission/preset').map(item => eventData(item).preset)) === JSON.stringify(['sandboxed-auto', 'workspace-write', 'sandboxed-auto']))
    model.script('memory-preset-roundtrip', [step(args), step(args), step(args), step(args)], low)
    const roundtrip = await runCase(acp, { workspace, caseName: 'memory-preset-roundtrip', prompt: 'Check a native permission roundtrip without an intermediate approval.', onPermission: reject })
    check(phase, 'native permission roundtrip without an intervening request discards the grant', classifierCalls(model, 'memory-preset-roundtrip').length === 2 && roundtrip.permissions.length === 0)
    model.script('memory-model', [step(args), step(args), step(args), step(args), step(args)], low)
    const switching = await runCase(acp, { workspace, caseName: 'memory-model', prompt: 'Check deployment classifier model transitions.', onPermission: reject })
    const selected = classifierCalls(model, 'memory-model').map(item => item.classifierModel)
    check(phase, 'native deployment model switch and return reclassify under each route', JSON.stringify(selected) === JSON.stringify([MODEL_ID, `${MODEL_ID}-alternate`, MODEL_ID]) && switching.permissions.length === 0, selected)

    // Genuine new user messages in the same session revoke and later reauthorize.
    const current = await acp.request('session/new', { cwd: workspace, mcpServers: [] })
    model.setCurrentCase('memory-revoke')
    const revokeSteps = []
    const permissions = []
    acp.onPermission(params => { permissions.push(params); return reject() })
    const prompt = text => {
      revokeSteps.push(step(args))
      model.script('memory-revoke', [...revokeSteps], low)
      return acp.request('session/prompt', { sessionId: current.sessionId, prompt: [{ type: 'text', text }] })
    }
    await prompt('Create this disposable marker.')
    await prompt('I revoke authorization.')
    await prompt(`Run: ${args.command}`)
    // A changed user message invalidates even the newly renewed grant.
    await prompt('Create this disposable marker again.')
    const revocation = approvalChain(dshHome, current.sessionId)
    check(phase, 'revoked grant is rejected natively and renewed consent reclassifies', JSON.stringify(revocation.decided.map(item => item.outcome)) === JSON.stringify(['allowed-once', 'rejected', 'allowed-once', 'rejected']) && permissions.length === 2 && classifierCalls(model, 'memory-revoke').length === 2, revocation.decided)
    await acp.request('session/close', { sessionId: current.sessionId })
    model.setCurrentCase(undefined)

    // A downstream manual allowed-once is never promoted into plugin memory.
    const manualName = 'memory-human'
    model.script(manualName, [step(args), step(args)], '{"risk":"medium","verdict":"ask","reasonCode":"uncertain"}')
    const human = await runCase(acp, { workspace, caseName: manualName, prompt: 'Create the disposable marker.', onPermission: () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } }) })
    check(phase, 'two downstream one-time allowances both require classification and a client response', classifierCalls(model, manualName).length === 2 && human.permissions.length === 2 && approvalChain(dshHome, human.sessionId).decided.every(item => item.outcome === 'allowed-once'))

    // Medium permission on an absent disposable target: no file is deleted.
    const mediumName = 'memory-medium'
    const mediumArgs = { ...args, command: 'rm -f memory-absent' }
    model.script(mediumName, [step(mediumArgs), step(mediumArgs)], evidence => JSON.stringify({ risk: 'medium', verdict: 'approve', reasonCode: 'explicit-user-authorization', authorization: { messageId: evidence.latestUserMessageId, quote: evidence.latestUserMessage } }))
    model.setCurrentCase(mediumName)
    const medium = await runCase(acp, { workspace, caseName: mediumName, prompt: '', text: `Run: ${mediumArgs.command}`, onPermission: reject })
    check(phase, 'medium-risk permission is never cached', classifierCalls(model, mediumName).length === 2 && medium.permissions.length === 0 && approvalChain(dshHome, medium.sessionId).decided.every(item => item.outcome === 'allowed-once'))
    model.setCurrentCase(undefined)
  } catch (error) {
    ok = check(phase, 'memory phase completed', false, String(error?.stack ?? error)) && ok
  } finally {
    model.setCurrentCase(undefined)
    const exit = await acp.shutdown()
    writeEvidence('acp-memory.transcript.json', acp.transcript)
    check(phase, 'memory host exits cleanly with every entry activated', exit.exitedCleanly && !/did not activate/.test(acp.stderr()))
  }
  return ok && results.filter(result => result.case === phase).every(result => result.passed)
}

async function disabledPhase({ options, model, baseEnv, dshHome, workspace, outside, parseYaml }) {
  const caseName = 'plugin-disabled'
  const tree = dumpConfig(options, baseEnv, workspace, parseYaml, 'effective-config-disabled.yml')
  const plugins = (Array.isArray(tree) ? tree : []).filter(entry => entry?.name === 'dsh-auto-approve')
  check(caseName, 'dsh-auto-approve entry is disabled after restart', plugins.length === 1 && plugins[0].disabled === true, plugins)
  // sandboxed-auto ships in the plugin bundle, so it stays selectable; the responder is gone.
  const acp = startAcp({ dsh: options.dsh, cwd: workspace, env: baseEnv, stderrPath: join(evidenceDir, 'dsh-disabled.stderr.log'), label: 'disabled' })
  let ok = true
  try {
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    const target = join(outside, 'disabled-target.txt')
    const args = { command: `touch ${target}`, description: 'Create a marker file outside workspace', sandbox_permissions: 'danger-full-access', justification: 'CI integration check with the plugin disabled.' }
    model.script(caseName, [{ name: 'bash', arguments: args }], '{"risk":"low","verdict":"approve","reasonCode":"routine"}')
    const run = await runCase(acp, { workspace, caseName, prompt: 'Create the marker file.', onPermission: reject })
    const chain = approvalChain(dshHome, run.sessionId)
    check(caseName, 'no classifier request reached the model (plugin not participating)', classifierCalls(model, caseName).length === 0, classifierCalls(model, caseName))
    checkBinding(caseName, chain, run.permissions, 'bash', args, 'rejected')
    check(caseName, 'native rejection left no file', !existsSync(target))
  } catch (error) {
    ok = check(caseName, 'disabled-plugin phase ran to completion', false, String(error?.stack ?? error)) && ok
  } finally {
    const exit = await acp.shutdown()
    writeEvidence('acp-disabled.transcript.json', acp.transcript)
    check(caseName, 'every composed entry activated (no loader activation failures)', !/did not activate/.test(acp.stderr()), acp.stderr().split('\n').filter(line => /did not activate|Error/.test(line)).slice(0, 20))
    check(caseName, 'dsh process exited after stdin closed', exit.exitedCleanly, exit)
  }
  return ok
}

// Run only as a script; scripts/ci-dsh-live.mjs imports the helpers above.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(canonical(process.argv[1])).href) {
  main().catch(error => {
    console.error(error?.stack ?? error)
    if (evidenceDir !== undefined) {
      try { writeEvidence('assertions.json', { passed: false, error: String(error?.stack ?? error), results }) } catch { /* best effort */ }
    }
    process.exitCode = 1
  })
}
