import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { inspectCommand } from '../danger-patterns.js'
import { parseDecision } from '../scripts/ci-dsh-live.mjs'
import { controlEntries, stability, wilson } from '../scripts/ci-dsh-live-community.mjs'

test('parseDecision reads the log-only classifier diagnostics', () => {
  assert.deepEqual(
    parseDecision('[dsh-auto-approve] decision=manual verdict=ask reasonCode=ask decisionSource=model modelRisk=medium modelReason=uncertain classifierMs=812 firstChunkMs=640'),
    { decision: 'manual', verdict: 'ask', reasonCode: 'ask', decisionSource: 'model', modelRisk: 'medium', modelReason: 'uncertain', invalidShape: null, classifierMs: 812, firstChunkMs: 640, reasoningChars: null, outputChars: null },
  )
  const timeout = parseDecision('[dsh-auto-approve] decision=manual verdict=timeout reasonCode=timeout decisionSource=model classifierMs=45001 firstChunkMs=none')
  assert.equal(timeout.firstChunkMs, 'none')
  const sized = parseDecision('[dsh-auto-approve] decision=manual verdict=response-too-long reasonCode=response-too-long decisionSource=model classifierMs=9 firstChunkMs=1 reasoningChars=21000 outputChars=16001')
  assert.equal(sized.reasoningChars, 21000)
  assert.equal(sized.outputChars, 16001)
  assert.equal(timeout.modelRisk, null)
  assert.equal(parseDecision('[dsh-auto-approve] decision=manual verdict=invalid-response reasonCode=invalid-response decisionSource=model invalidShape=prose').invalidShape, 'prose')
})

test('control cases are paired, labelled and reach the classifier rather than a local rule', async () => {
  const controls = controlEntries()
  assert.equal(new Set(controls.map(item => item.id)).size, controls.length)
  for (const item of controls) {
    assert.match(item.id, /^ctl-[a-z0-9-]+$/)
    assert.ok(['auto_candidate', 'manual_required', 'observe'].includes(item.preliminaryExpectation), item.id)
    assert.ok(item.userText.length > 0 && item.userText.length <= 2000, item.id)
    const action = inspectCommand(item.command.replaceAll('{outside}', '/ci/outside'), { workdir: '/ci/workspace', shell: 'bash' })
    assert.equal(action.handoffReason, undefined, item.id)
  }
  const byId = Object.fromEntries(controls.map(item => [item.id, item]))
  const task = (await readFile(new URL('../test/fixtures/real-projects/g003-e01.task.md', import.meta.url), 'utf8')).trim()
  assert.equal(byId['ctl-e01-deliver-restricted'].userText, task)
  // The unrestricted variant differs from the task by exactly the sandbox restriction line.
  const removed = task.split('\n').filter(line => !byId['ctl-e01-deliver-unrestricted'].userText.split('\n').includes(line))
  assert.deepEqual(removed, ['* 不要更改安全策略、关闭沙箱或使用特权命令。'])
  assert.equal(byId['ctl-e01-deliver-restricted'].command, byId['ctl-e01-deliver-unrestricted'].command)
  assert.equal(byId['ctl-touch-unrelated-ci-reason'].command, byId['ctl-touch-unrelated-task-reason'].command)
  assert.equal(byId['ctl-e01-deliver-run'].userText, `Run: ${byId['ctl-e01-deliver-run'].command}`)
})

test('wilson bounds and the stability summary', () => {
  assert.equal(wilson(0, 0), null)
  assert.deepEqual(wilson(0, 150), { k: 0, n: 150, rate: 0, low: 0, high: 0.025 })
  const row = (caseId, round, extra) => ({ caseId, round, label: 'observe', wouldAuto: false, modelError: null, decisionSource: 'model', reasonCode: 'ask', modelRisk: 'medium', modelReason: 'uncertain', invalidShape: null, firstChunkMs: 10, ...extra })
  const summary = stability([
    row('a', 1, { wouldAuto: true, label: 'auto_candidate', modelRisk: 'low', modelReason: 'routine' }),
    row('a', 2, { label: 'auto_candidate' }),
    row('b', 1, { label: 'manual_required', decisionSource: 'rule', reasonCode: 'destructive', modelRisk: null, modelReason: null }),
    row('b', 2, { label: 'manual_required', decisionSource: 'rule', reasonCode: 'destructive', modelRisk: null, modelReason: null }),
    row('c', 1, { modelError: 'timeout', reasonCode: 'timeout', modelRisk: null, modelReason: null, firstChunkMs: 'none' }),
    row('c', 2, { modelError: 'invalid-response', reasonCode: 'invalid-response', invalidShape: 'prose', modelRisk: null, modelReason: null }),
  ])
  assert.equal(summary.rounds, 2)
  assert.deepEqual(summary.casesFlipped, ['a', 'c'])
  assert.equal(summary.manualRequiredWouldAutoRuns, 0)
  assert.equal(summary.manualRequiredRuns, 2)
  assert.equal(summary.autoCandidateApprovalRate.k, 1)
  assert.equal(summary.modelFailureRate.k, 2)
  assert.equal(summary.modelFailureRate.n, 4)
  assert.deepEqual(summary.modelFailures, { 'invalid-response:prose': 1, timeout: 1 })
  assert.equal(summary.timeoutsWithoutFirstChunk, 1)
  assert.deepEqual(summary.perCase.find(item => item.caseId === 'a').outcomes, { 'model-ask': 1, 'would-auto': 1 })
  assert.deepEqual(summary.perCase.find(item => item.caseId === 'b').outcomes, { 'handoff-destructive': 2 })
})
