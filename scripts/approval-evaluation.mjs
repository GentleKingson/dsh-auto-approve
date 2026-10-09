import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const BASELINE_REF = 'c6d4222746fef089de4e40063d05d26a4191bc66'
export const CORPUS_PATH = join(ROOT, 'test/fixtures/approval-corpus.json')

export function evaluationRequest(sample) {
  const justification = 'Inspect the stated synthetic fixture action'
  const args = {
    command: sample.command,
    description: 'Evaluate fixture without executing the command',
    sandbox_permissions: 'danger-full-access',
    justification,
  }
  const user = { type: 'user/message', seq: 0, data: {
    id: 'user-1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: sample.userText ?? 'Inspect this disposable test environment.' }],
  } }
  const call = { type: 'tool/call', seq: 1, data: {
    turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '',
  } }
  const events = [user, call]
  const req = { agent: { session: { id: sample.id, header: { cwd: '/workspace/project' }, events } },
    toolName: 'bash', callId: 'call-1', reason: `escalate sandbox to danger-full-access: ${justification}` }
  switch (sample.variant) {
    case 'missing-call': events.pop(); break
    case 'tool-mismatch': call.data.name = 'write'; break
    case 'duplicate-call': events.push(structuredClone(call)); break
    case 'missing-command': delete args.command; break
    case 'mode-conflict': args.sandbox_permissions = 'workspace-write'; break
    case 'missing-escalation': delete args.sandbox_permissions; delete args.justification; break
    case 'unknown-tool': req.toolName = call.data.name = 'unknown-tool'; break
    case 'cancelled': req.signal = AbortSignal.abort(); break
    case 'invalid-signal': req.signal = { aborted: false }; break
    case 'oversized-user': user.data.content[0].text = 'a'.repeat(2000) + ' Do not execute.'; break
    case 'malformed-user': user.data.content.unshift({ type: 'text', text: null }); break
    case 'oversized-arguments': args.command = 'echo ' + 'a'.repeat(40000); break
    case 'untrusted-authorization': user.data.source = { kind: 'plugin', plugin: 'fixture' }; break
  }
  call.data.arguments = sample.variant === 'malformed-arguments' ? '{broken' : JSON.stringify(args)
  return req
}

function response(text) {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

/** Fake the host and model only; no fixture command reaches a shell or tool executor. */
export async function evaluateCorpus(plugin, corpus, { legacyProtocol = false, config = {} } = {}) {
  const rows = []
  for (const sample of corpus.cases) {
    let handler
    let llmCalls = 0
    let nextCalls = 0
    const logs = []
    const cleanups = []
    const ctx = {
      get(service) {
        if (service === 'permissionPresets') return { current: () => 'sandboxed-auto' }
        if (service === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) }
        if (service === 'llm') return { stream() {
          llmCalls += 1
          return response(JSON.stringify(legacyProtocol ? { verdict: sample.classifierReply.verdict } : sample.classifierReply))
        } }
      },
      on(_event, listener) { handler = listener; return () => {} },
      effect(setup) { cleanups.push(setup()) },
      inject() {},
      logger: { info(message) { logs.push(message) } },
    }
    plugin.apply(ctx, { sessionMemory: false, ...config })
    try {
      const outcome = await handler(evaluationRequest(sample), () => { nextCalls += 1; return 'manual' })
      rows.push({ id: sample.id, expected: sample.expected, risk: sample.risk,
        actual: outcome === 'allowed-once' && nextCalls === 0 ? 'auto' : 'manual', llmCalls,
        shadowWouldAuto: logs.some(message => /decision=shadow-approve/.test(message)) })
    } finally {
      for (const cleanup of cleanups) await cleanup?.()
    }
  }
  const unsafe = rows.filter(row => row.expected === 'manual' && row.actual === 'auto')
  const falseManual = rows.filter(row => row.expected === 'auto' && row.actual === 'manual')
  const safeCount = rows.filter(row => row.expected === 'auto').length
  const manualCount = rows.filter(row => row.expected === 'manual').length
  return {
    evidence: 'synthetic fixtures + fixed mock model responses; not model accuracy or production burden',
    requests: rows.length, safeCount, manualCount,
    unsafeAuto: unsafe.length, safeToHuman: falseManual.length,
    unknown: rows.filter(row => row.risk === 'unknown').length,
    modelCalls: rows.reduce((sum, row) => sum + row.llmCalls, 0),
    shadowWouldAuto: rows.filter(row => row.shadowWouldAuto).length,
    shadowCandidateUnsafeAuto: config.shadowMode ? rows.filter(row => row.expected === 'manual' && row.shadowWouldAuto).length : null,
    shadowCandidateSafeToHuman: config.shadowMode ? rows.filter(row => row.expected === 'auto' && !row.shadowWouldAuto).length : null,
    humanPer100: 100 * rows.filter(row => row.actual === 'manual').length / rows.length,
    unsafeIds: unsafe.map(row => row.id), safeToHumanIds: falseManual.map(row => row.id), rows,
  }
}

/** Load the exact immutable baseline without changing the user's checkout. */
export async function withBaseline(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-approval-baseline-'))
  try {
    for (const file of ['index.js', 'danger-patterns.js', 'package.json']) {
      await writeFile(join(directory, file), execFileSync('git', ['show', `${BASELINE_REF}:${file}`], { cwd: ROOT }))
    }
    await symlink(join(ROOT, 'node_modules'), join(directory, 'node_modules'), 'dir')
    const plugin = await import(pathToFileURL(join(directory, 'index.js')).href)
    return await operation(plugin)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function runEvaluation({ baseline = false, shadow = false } = {}) {
  const bytes = await readFile(CORPUS_PATH, 'utf8')
  const corpus = JSON.parse(bytes)
  const measured = baseline
    ? await withBaseline(plugin => evaluateCorpus(plugin, corpus, { legacyProtocol: true }))
    : await evaluateCorpus(await import('../index.js'), corpus, { config: { shadowMode: shadow } })
  const { rows, ...metrics } = measured
  const sourceFiles = ['index.js', 'danger-patterns.js', 'cordis.patch.yml', 'package.json']
  const sourceParts = []
  for (const file of sourceFiles) sourceParts.push([file, baseline
    ? execFileSync('git', ['show', `${BASELINE_REF}:${file}`], { cwd: ROOT, encoding: 'utf8' })
    : await readFile(join(ROOT, file), 'utf8')])
  let codeRef = BASELINE_REF
  if (!baseline) {
    try { codeRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { codeRef = null }
  }
  return { corpusVersion: corpus.version, corpusSha256: createHash('sha256').update(bytes).digest('hex'),
    codeRef, sourceSha256: createHash('sha256').update(JSON.stringify(sourceParts)).digest('hex'),
    policyVersion: baseline ? 'legacy-v1' : 'approval-v2',
    workingTree: !baseline, shadowMode: shadow,
    latency: 'NOT_MEASURED: fixed mock responses', realLogs: 0, ...metrics }
}
