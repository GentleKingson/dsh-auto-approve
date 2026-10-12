import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Config, createApprovalHandler } from '../index.js'
import { acquireCompileEvidence } from '../compile-evidence.js'

const command = 'python -I -S -B -m py_compile InvoiceTool.py'
const digest = 'a'.repeat(64)

function request(commandText = command) {
  const justification = 'Check syntax after editing'
  return { toolName: 'pwsh', callId: 'compile-call', reason: `escalate sandbox to danger-full-access: ${justification}`,
    agent: { session: { id: 'compile-session', header: { cwd: join(tmpdir(), 'compile-workspace') }, events: [
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'compile-call', name: 'pwsh', arguments: JSON.stringify({ command: commandText, description: 'Check Python syntax', sandbox_permissions: 'danger-full-access', justification }) } },
    ] } } }
}

// Synthetic host receipts, never presented as actual filesystem/executor proof.
function factsFor(req) {
  const runtimeRoot = resolve(tmpdir(), '..', 'protected-python')
  const outputPath = join(dirname(req.sourcePath), '__pycache__', `${basename(req.sourcePath).slice(0, -3)}.cpython-312.pyc`)
  return { version: 1, requestHash: req.requestHash, platform: req.platform, shell: req.toolName,
    structure: req.candidate.structure, expiresAt: Date.now() + 60_000,
    executionBound: true, parserVerified: true, runtimeProtected: true, shellStartupVerified: true, environmentBound: true, isolated: true, siteDisabled: true,
    importBytecodeDisabled: true, sourceRegular: true, outputNoFollow: true, cachePrefix: null,
    cacheTag: 'cpython-312', executableSha256: digest, runtimeSha256: digest, sourceSha256: digest,
    executablePath: join(runtimeRoot, 'python.exe'), runtimeRoot, sourcePath: req.sourcePath,
    sourceRealPath: req.sourcePath, outputPath, outputParentRealPath: dirname(outputPath), outputKind: 'absent',
    workspaceRealPath: req.workspacePath, cwdRealPath: req.workdir }
}

function harness({ enabled = true, missing = false, mutateFacts, acquire, onModel, verdict = 'approve', shadow = false } = {}) {
  let modelCalls = 0; let acquires = 0; let disposed = 0; let remembers = 0; let current = true
  const rows = []; const evidence = []
  const provider = { async acquire(req, options) {
    acquires++
    if (acquire) return acquire(req, options)
    const facts = factsFor(req); mutateFacts?.(facts)
    return { facts, isCurrent: () => current, dispose() { disposed++ } }
  } }
  let activeProvider = missing ? undefined : provider
  const ctx = { get(key) {
    if (key === 'permissionPresets') return { current: () => 'sandboxed-auto' }
    if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) }
    if (key === 'autoApproveExecutionEvidence') return activeProvider
    if (key === 'llm') return { async *stream(options) {
      modelCalls++; evidence.push(JSON.parse(options.messages[0].content[0].text)); onModel?.()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ risk: 'low', verdict, reasonCode: 'routine' }) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  }, logger: { info() {} } }
  const handler = createApprovalHandler(ctx, Config({ pythonCompileReview: enabled, timeoutMs: 100, shadowMode: shadow }), [], {
    recordDecision: row => rows.push(row), memory: { clear() {}, observe() {}, lookup() { throw new Error('compile must not use approval cache') }, remember() { remembers++ } },
  })
  return { rows, evidence, get modelCalls() { return modelCalls }, get acquires() { return acquires }, get disposed() { return disposed }, get remembers() { return remembers },
    revoke() { current = false }, replaceProvider() { activeProvider = { ...provider } },
    run: (req = request()) => handler(req, () => 'manual') }
}

test('compile review is off by default and enabling it alone cannot grant authority', async () => {
  assert.equal(Config({}).pythonCompileReview, false)
  const disabled = harness({ enabled: false })
  assert.equal(await disabled.run(), 'manual'); assert.equal(disabled.acquires, 0)
  const missing = harness({ missing: true })
  assert.equal(await missing.run(), 'manual'); assert.equal(missing.modelCalls, 0)
  assert.equal(missing.rows[0].reasonCode, 'compile-evidence-unavailable')
})

test('isolated compile reaches the classifier only with a bound host receipt, never the cache', async () => {
  const app = harness()
  for (const source of [command, `${command}; if ($LASTEXITCODE -eq 0) { "SYNTAX OK" }`]) {
    assert.equal(await app.run(request(source)), 'allowed-once')
    assert.equal(await app.run(request(source)), 'allowed-once')
  }
  assert.equal(app.modelCalls, 4); assert.equal(app.acquires, 4); assert.equal(app.disposed, 4); assert.equal(app.remembers, 0)
  assert.equal(app.evidence[0].compileEvidence.executionBound, true)
  assert.equal(app.evidence[0].compileEvidence.runtimeSha256, digest)
})

test('invalid isolation, extra sources, unknown options and workspace escapes never acquire evidence', async () => {
  for (const cmd of [
    'python -m py_compile InvoiceTool.py', 'python -I -m py_compile InvoiceTool.py',
    'python -I -S -m py_compile InvoiceTool.py', `${command} Other.py`,
    'python -I -S -B -m py_compile ../outside.py', 'python -I -S -B -m py_compile .env.py',
    'python -I -S -B -m other InvoiceTool.py', `${command}; whoami`,
  ]) {
    const app = harness(); assert.equal(await app.run(request(cmd)), 'manual', cmd); assert.equal(app.acquires, 0, cmd)
  }
})

test('receipts fail closed for mismatches, unprotected runtimes, links and wrong output scope', async () => {
  const mutations = [
    f => { f.requestHash = 'b'.repeat(64) }, f => { f.platform = 'other' }, f => { f.shell = 'bash' },
    f => { f.expiresAt = Date.now() - 1 }, f => { f.expiresAt = Date.now() + 999_999 },
    f => { f.executionBound = false }, f => { f.parserVerified = false }, f => { f.runtimeProtected = false },
    f => { f.shellStartupVerified = false }, f => { f.environmentBound = false },
    f => { f.sourceRegular = false }, f => { f.outputNoFollow = false }, f => { f.cachePrefix = tmpdir() },
    f => { f.isolated = false }, f => { f.siteDisabled = false }, f => { f.importBytecodeDisabled = false },
    f => { f.executableSha256 = 'missing' }, f => { f.runtimeRoot = f.workspaceRealPath },
    f => { f.sourceRealPath = join(tmpdir(), 'outside.py') }, f => { f.outputKind = 'symlink' },
    f => { f.outputPath = join(tmpdir(), 'outside.pyc') }, f => { f.outputParentRealPath = tmpdir() },
    f => { f.cacheTag = '../../escape' }, f => { f.structure = 'another-ast' },
  ]
  for (const mutateFacts of mutations) {
    const app = harness({ mutateFacts }); assert.equal(await app.run(), 'manual'); assert.equal(app.modelCalls, 0)
    assert.equal(app.rows[0].reasonCode, 'compile-evidence-invalid'); assert.equal(app.disposed, 1)
  }
})

test('receipt changes and provider replacement during model review block the approval', async () => {
  for (const method of ['revoke', 'replaceProvider']) {
    const app = harness({ onModel() { app[method]() } })
    assert.equal(await app.run(), 'manual'); assert.equal(app.modelCalls, 1); assert.equal(app.disposed, 1)
    assert.equal(app.rows[0].reasonCode, 'compile-evidence-stale')
  }
})

test('model ask, shadow, user restrictions and cancellation retain their authority', async () => {
  for (const options of [{ verdict: 'ask' }, { shadow: true }]) {
    const app = harness(options); assert.equal(await app.run(), 'manual'); assert.equal(app.disposed, 1)
  }
  const req = request()
  req.agent.session.events.unshift({ type: 'user/message', data: { id: 'u', source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: 'Do not execute this command.' }] } })
  const app = harness(); assert.equal(await app.run(req), 'manual'); assert.equal(app.acquires, 0)
  const aborted = request(); aborted.signal = AbortSignal.abort()
  assert.equal(await app.run(aborted), 'manual'); assert.equal(app.acquires, 0)
})

test('provider timeout does not approve and late evidence is disposed', async () => {
  let finish; let disposed = 0
  const provider = { acquire: () => new Promise(resolve => { finish = resolve }) }
  const result = await acquireCompileEvidence(provider, {}, { timeoutMs: 5 })
  assert.equal(result.error, 'compile-evidence-cancelled')
  finish({ dispose() { disposed++ } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, 1)
})

test('tool-supplied proof is rejected by the argument contract', async () => {
  const req = request(); const call = req.agent.session.events[0].data
  call.arguments = JSON.stringify({ ...JSON.parse(call.arguments), compileEvidence: { executionBound: true } })
  const app = harness(); assert.equal(await app.run(req), 'manual'); assert.equal(app.acquires, 0)
  assert.equal(app.rows[0].reasonCode, 'call-unverified')
})

test('mutating a receipt during model review invalidates the snapshot', async () => {
  let facts; let disposed = 0
  const app = harness({ acquire(req) {
    facts = factsFor(req)
    return { facts, isCurrent: () => true, dispose() { disposed++ } }
  }, onModel() { facts.sourceSha256 = 'b'.repeat(64) } })
  assert.equal(await app.run(), 'manual')
  assert.equal(app.rows[0].reasonCode, 'compile-evidence-stale')
  assert.equal(disposed, 1)
})

test('cancellation while acquiring evidence disposes late leases and never invokes the model', async () => {
  const controller = new AbortController()
  let finish; let disposed = 0
  const app = harness({ acquire() {
    return new Promise(resolve => { finish = resolve; controller.abort() })
  } })
  const req = request(); req.signal = controller.signal
  assert.equal(await app.run(req), 'manual')
  assert.equal(app.modelCalls, 0)
  finish({ dispose() { disposed++ } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, 1)
})

test('receipt validity must be synchronous and exceptions fail closed', async () => {
  for (const isCurrent of [() => Promise.resolve(true), () => Promise.reject(new Error('async stale')), () => { throw new Error('stale') }]) {
    let disposed = 0
    const app = harness({ acquire(req) { return { facts: factsFor(req), isCurrent, dispose() { disposed++ } } } })
    assert.equal(await app.run(), 'manual'); assert.equal(app.modelCalls, 0); assert.equal(disposed, 1)
  }
})
