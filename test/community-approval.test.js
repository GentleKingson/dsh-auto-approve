import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateCommunity, loadCommunity, replaySample } from '../scripts/evaluate-community-cases.mjs'

// Structure and accounting only. The safety verdict of the community replay is
// the separate `community-offline` CI gate (scripts/evaluate-community-cases.mjs),
// so known findings are never encoded here as expected results.
const { casebook, review, reviewById, liveSubset } = await loadCommunity()

test('community casebook is the supplied input, unmodified, with every case and source reviewed', () => {
  assert.equal(casebook.cases.length, 53)
  assert.equal(casebook.sources.length, 28)
  assert.equal(new Set(casebook.cases.map(entry => entry.id)).size, 53)
  assert.deepEqual(review.sources.map(source => source.id).sort(), casebook.sources.map(source => source.id).sort())
  assert.deepEqual(review.cases.map(row => row.id).sort(), casebook.cases.map(entry => entry.id).sort())
  assert.equal(review.rules.labelsChanged, 0)
  for (const entry of casebook.cases) {
    const row = reviewById.get(entry.id)
    assert.equal(row.sourceId, entry.sourceId, entry.id)
    assert.equal(row.preliminaryExpectation, entry.preliminaryExpectation, `${entry.id}: review must not relabel`)
    assert.ok(['verified', 'disputed', 'context-limited', 'host-only'].includes(row.labelReview), entry.id)
    assert.ok(['original_reproduction', 'public_command_example', 'source_driven_adaptation', 'host_boundary'].includes(row.category), entry.id)
    assert.ok(row.sourceLine > 0 && row.excerpt.length > 0 && row.note.length > 0, entry.id)
    if (row.sourceForm === 'verbatim') assert.equal(row.excerpt, entry.command, entry.id)
    if (row.location !== 'body') assert.match(row.locationSha256, /^[a-f0-9]{64}$/)
    assert.equal(entry.executionAllowed, false, entry.id)
    assert.equal(row.labelReview === 'host-only', entry.preliminaryExpectation === 'host_only', entry.id)
  }
  for (const source of review.sources) {
    assert.match(source.bodySha256, /^[a-f0-9]{64}$/)
    assert.match(source.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|discussions)\/\d+$/)
  }
})

test('live shadow subset: 30 known ids, 10/15/5 split, at most two per source, 22 sources', () => {
  const byId = new Map(casebook.cases.map(entry => [entry.id, entry]))
  assert.equal(liveSubset.caseIds.length, 30)
  assert.equal(new Set(liveSubset.caseIds).size, 30)
  const entries = liveSubset.caseIds.map(id => byId.get(id))
  assert.ok(entries.every(Boolean))
  const count = label => entries.filter(entry => entry.preliminaryExpectation === label).length
  assert.deepEqual([count('auto_candidate'), count('manual_required'), count('observe'), count('host_only')], [10, 15, 5, 0])
  const perSource = new Map()
  for (const entry of entries) perSource.set(entry.sourceId, (perSource.get(entry.sourceId) ?? 0) + 1)
  assert.equal(perSource.size, 22)
  assert.ok([...perSource.values()].every(n => n <= 2))
})

test('replay adapters: commands and file arguments are data; host-only and unknown tools are NOT_COVERED', () => {
  for (const entry of casebook.cases) {
    const sample = replaySample(entry)
    if (entry.preliminaryExpectation === 'host_only') assert.ok(sample.notCovered, entry.id)
    else if (entry.toolName === 'bash') assert.equal(sample.command, entry.command)
    else assert.deepEqual(Object.keys(sample.toolArgs).sort(), entry.toolName === 'write' ? ['content', 'file_path'] : ['file_path', 'new_string', 'old_string'])
  }
})

test('community replay accounts for every case exactly once', async () => {
  const result = await evaluateCommunity()
  assert.equal(result.scored.requests + result.observe.length + result.notCovered.length, 53)
  assert.equal(result.notCovered.length, 6)
  assert.equal(result.clusters.total, 28)
  assert.equal(result.clusters.rows.reduce((sum, row) => sum + row.cases, 0), 53)
  assert.ok(['PASS', 'PARTIAL', 'FAIL'].includes(result.status))
})
