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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODEL_PROVIDER = 'ci-mock'
const MODEL_ID = 'ci-mock-model'
const CLASSIFIER_MARKER = 'Classify a coding agent request for one-time sandbox escalation.'
const PROMPT_TIMEOUT_MS = 90_000
const EXIT_TIMEOUT_MS = 20_000

function parseArgs(argv) {
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

function within(child, parent) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !path.startsWith(sep) && path !== '..')
}

function canonical(path) {
  try { return realpathSync(path) } catch { return path }
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

// ---------------------------------------------------------------- evidence

const results = []
let evidenceDir

function writeEvidence(name, value) {
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(join(evidenceDir, name), text)
}

function check(caseName, description, condition, detail) {
  const passed = Boolean(condition)
  results.push({ case: caseName, check: description, passed, ...(detail === undefined ? {} : { detail }) })
  console.log(`${passed ? 'PASS' : 'FAIL'} [${caseName}] ${description}${!passed && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`)
  return passed
}

// ------------------------------------------------------- scripted model

/** Local OpenAI-compatible endpoint: agent turns follow a fixed script per case, classifier turns return a fixed verdict. */
function createModelServer() {
  const scripts = new Map()
  const classifierVerdicts = new Map()
  const log = []
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
      const caseName = /\[ci-case:([a-z0-9-]+)\]/.exec(evidence?.latestUserMessage ?? '')?.[1] ?? 'unknown'
      const verdict = classifierVerdicts.get(caseName) ?? '{"risk":"medium","verdict":"ask","reasonCode":"uncertain"}'
      log.push({ kind: 'classifier', case: caseName, toolName: evidence?.toolName, toolArguments: evidence?.toolArguments, justification: evidence?.justification, workspacePath: evidence?.workspacePath, verdict })
      stream(res, { text: verdict })
      return
    }
    const userText = messages.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n')
    const caseName = /\[ci-case:([a-z0-9-]+)\]/.exec(userText)?.[1] ?? 'unknown'
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
function startAcp({ dsh, cwd, env, stderrPath, label }) {
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

function readSessionLogs(dshHome) {
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

function loadYaml(dshPackageJson) {
  const require = createRequire(dshPackageJson)
  const yaml = require('js-yaml')
  const jsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: source => new JsExpression(source), instanceOf: JsExpression, represent: value => value.source })
  const schema = yaml.DEFAULT_SCHEMA.extend([jsType])
  return { parse: text => yaml.load(text, { schema }), stringify: value => yaml.dump(value, { schema, lineWidth: -1, noRefs: true }) }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof JsExpression)
}

function deepMerge(base, override) {
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
function userPatch(defaultTree, overrides, disabled = []) {
  return Object.entries(overrides).map(([id, override]) => {
    const entries = configEntry(defaultTree, id)
    if (entries.length !== 1) throw new Error(`expected exactly one composed entry ${id}, found ${entries.length}`)
    return { id, ...(disabled.includes(id) ? { disabled: true } : {}), config: deepMerge(entries[0].config ?? {}, override) }
  })
}

function packageVersion(require, name) {
  try { return require(`${name}/package.json`).version } catch { return null }
}

// ------------------------------------------------------------------ main

async function main() {
  const options = parseArgs(process.argv.slice(2))
  evidenceDir = options.evidence
  mkdirSync(evidenceDir, { recursive: true })
  const root = options.root
  for (const temp of ['/tmp', tmpdir()]) {
    if (within(canonical(root), canonical(temp))) throw new Error(`--root ${root} is inside the workspace-write temp area ${temp}; choose a directory outside it`)
  }
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error(`--root ${root} must be empty`)
  const dshHome = join(root, 'dsh-home')
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  for (const dir of [dshHome, workspace, outside]) mkdirSync(dir, { recursive: true })

  const dshPackageJson = join(dirname(canonical(options.dsh)), '..', 'package.json')
  const dshRequire = createRequire(dshPackageJson)
  const yamlCodec = loadYaml(dshPackageJson)
  const parseYaml = yamlCodec.parse
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
    model: { provider: MODEL_PROVIDER, model: MODEL_ID, note: 'scripted local endpoint; not a real model' },
  }
  writeEvidence('versions.json', versions)
  console.log(`dsh ${versions.dsh}; plugin ${versions.plugin.version} @ ${versions.plugin.prHead ?? versions.plugin.checkoutHead} (checkout ${versions.plugin.checkoutHead}); ${versions.node}`)

  const baseEnv = { ...process.env, DSH_HOME: dshHome, CI_MOCK_API_KEY: 'ci-mock-key', DSH_TELEMETRY_MODE: 'DISABLED', NO_COLOR: '1' }
  delete baseEnv.DSH_PERMISSION_MODE
  for (const key of Object.keys(baseEnv)) if (/^(DEEPSEEK|OPENAI|ANTHROPIC)_/.test(key)) delete baseEnv[key]

  // Install this checkout through the host's own plugin manager.
  const install = spawnSync(process.execPath, [options.dsh, 'plugin', '--profile', 'acp', 'add', `link:${PLUGIN_DIR}`], { cwd: root, env: baseEnv, encoding: 'utf8', timeout: 300_000 })
  writeEvidence('plugin-install.log', `${install.stdout ?? ''}\n${install.stderr ?? ''}`)
  if (install.status !== 0) throw new Error(`dsh plugin add failed with status ${install.status}; see plugin-install.log`)

  const model = createModelServer()
  const port = await model.listen()
  const profileDir = join(dshHome, 'profiles', 'acp')
  const patchFile = join(profileDir, 'cordis.patch.yml')
  let defaultTree
  const overrides = {
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
  const patch = enabled => `# Written by scripts/ci-dsh-integration.mjs for a disposable CI profile.\n${yamlCodec.stringify(userPatch(defaultTree, overrides, enabled ? [] : ['auto-approve']))}`

  let failed = false
  try {
    writeFileSync(patchFile, '[]\n')
    defaultTree = dumpConfig(options, baseEnv, workspace, parseYaml, 'composed-config-before-user-patch.yml')
    writeFileSync(patchFile, patch(true))
    writeEvidence('cordis.patch.enabled.yml', patch(true))
    failed = !(await enabledPhase({ options, model, baseEnv, dshHome, workspace, outside, parseYaml })) || failed
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
    notVerified: ['Web/Desktop/TUI clients', 'deployed control-plane isolation', 'genuine human approval provenance', 'real model behaviour', 'actual automatic approval (shadowMode stays on)'],
    total: results.length,
    failed: results.filter(result => !result.passed).length,
    results,
  }
  writeEvidence('assertions.json', summary)
  console.log(`\n${summary.passed ? 'PASS' : 'FAIL'}: ${summary.total - summary.failed}/${summary.total} checks passed; evidence in ${evidenceDir}`)
  process.exitCode = summary.passed ? 0 : 1
}

// ----------------------------------------------------------------- cases

function configEntry(tree, id) {
  return (Array.isArray(tree) ? tree : []).filter(entry => entry?.id === id)
}

function dumpConfig(options, env, cwd, parseYaml, file) {
  const dump = spawnSync(process.execPath, [options.dsh, '--profile', 'acp', '--dump-config'], { cwd, env, encoding: 'utf8', timeout: 120_000 })
  writeEvidence(file, dump.stdout ?? '')
  if (dump.status !== 0) throw new Error(`dsh --dump-config failed: ${dump.stderr}`)
  return parseYaml(dump.stdout)
}

/** One prompt in a fresh ACP session; the permission handler sees each request in order. */
async function runCase(acp, { workspace, caseName, prompt, onPermission }) {
  const permissions = []
  acp.onPermission(async params => {
    permissions.push(params)
    return onPermission(params, permissions.length)
  })
  const session = await acp.request('session/new', { cwd: workspace, mcpServers: [] })
  const firstUpdate = acp.updates.length
  const response = await acp.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: `[ci-case:${caseName}] ${prompt}` }] })
  const updates = acp.updates.slice(firstUpdate).filter(update => update.sessionId === session.sessionId)
  await acp.request('session/close', { sessionId: session.sessionId }).catch(() => undefined)
  return { sessionId: session.sessionId, response, permissions, updates }
}

function sessionEvents(dshHome, sessionId) {
  return readSessionLogs(dshHome).filter(event => event.file.includes(sessionId))
}

function eventData(event) {
  return event.data ?? event.payload ?? event
}

/** Bind each approval to exactly one tool call with the scripted arguments, and return the decided outcomes. */
function approvalChain(dshHome, sessionId) {
  const events = sessionEvents(dshHome, sessionId)
  const calls = events.filter(event => event.type === 'tool/call').map(eventData)
  const asked = events.filter(event => event.type === 'approval/asked').map(eventData)
  const decided = events.filter(event => event.type === 'approval/decided').map(eventData)
  return { events, calls, asked, decided }
}

function checkBinding(caseName, chain, permissions, toolName, expectedArguments, expectedOutcome) {
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

function classifierCalls(model, caseName) {
  return model.log.filter(entry => entry.kind === 'classifier' && entry.case === caseName)
}

function lastToolResults(model, caseName) {
  const agentTurns = model.log.filter(entry => entry.kind === 'agent' && entry.case === caseName)
  return agentTurns.at(-1)?.toolResults ?? []
}

const reject = () => ({ outcome: { outcome: 'selected', optionId: 'reject-once' } })

async function enabledPhase({ options, model, baseEnv, dshHome, workspace, outside, parseYaml }) {
  const phase = 'config'
  const tree = dumpConfig(options, baseEnv, workspace, parseYaml, 'effective-config.yml')
  const plugins = (Array.isArray(tree) ? tree : []).filter(entry => entry?.name === 'dsh-auto-approve')
  check(phase, 'dsh-auto-approve is composed exactly once (id auto-approve)', plugins.length === 1 && plugins[0].id === 'auto-approve' && plugins[0].disabled !== true, plugins)
  const pluginConfig = plugins[0]?.config ?? {}
  check(phase, 'effective plugin config: presetName sandboxed-auto, shadowMode true, sessionMemory false', pluginConfig.presetName === 'sandboxed-auto' && pluginConfig.shadowMode === true && pluginConfig.sessionMemory === false, pluginConfig)
  const permission = configEntry(tree, 'permission')[0]?.config ?? {}
  check(phase, 'effective sandboxed-auto preset is workspace-write + ask and is the default preset', permission.defaultPreset === 'sandboxed-auto' && permission.presets?.['sandboxed-auto']?.sandbox === 'workspace-write' && permission.presets?.['sandboxed-auto']?.approval === 'ask', permission)
  check(phase, 'effective approval policy is ask (never would reject before any plugin)', configEntry(tree, 'approval')[0]?.config?.policy === 'ask', configEntry(tree, 'approval'))
  check(phase, 'effective sandbox policy is workspace-write', configEntry(tree, 'sandbox-policy')[0]?.config?.mode === 'workspace-write', configEntry(tree, 'sandbox-policy'))
  writeEvidence('effective-config-summary.json', { plugin: plugins, permission, approval: configEntry(tree, 'approval'), sandboxPolicy: configEntry(tree, 'sandbox-policy'), acp: configEntry(tree, 'acp') })

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

main().catch(error => {
  console.error(error?.stack ?? error)
  if (evidenceDir !== undefined) {
    try { writeEvidence('assertions.json', { passed: false, error: String(error?.stack ?? error), results }) } catch { /* best effort */ }
  }
  process.exitCode = 1
})
