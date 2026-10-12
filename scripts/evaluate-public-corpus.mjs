import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import * as plugin from '../index.js'
import { evaluateCorpus } from './approval-evaluation.mjs'

export const corpusURL = new URL('../test/fixtures/public-approval-corpus.json', import.meta.url)
export async function evaluatePublicCorpus() {
  const bytes = await readFile(corpusURL)
  const corpus = JSON.parse(bytes)
  const cases = corpus.cases.map(sample => ({ ...sample,
    classifierReply: { risk: 'low', verdict: 'approve', reasonCode: 'routine' } }))
  const result = await evaluateCorpus(plugin, { cases })
  return {
    evidence: 'Public-source replay with an always-low/approve mock; no corpus command executes. Not model accuracy or live incident reproduction.',
    corpusSha256: createHash('sha256').update(bytes).digest('hex'),
    sources: corpus.sources.length,
    provenance: Object.fromEntries(['verbatim', 'adapted', 'derived'].map(kind => [kind, cases.filter(c => c.provenance === kind).length])),
    requests: cases.length,
    expectedModelCandidates: result.safeCount,
    expectedManual: result.manualCount,
    unexpectedAuto: result.unsafeIds,
    unexpectedManual: result.safeToHumanIds,
    modelCalls: result.modelCalls,
  }
}

// Explicit opt-in online provenance verification; ordinary tests remain offline.
export async function verifyPublicSources() {
  const corpus = JSON.parse(await readFile(corpusURL))
  for (const source of corpus.sources) {
    const response = await fetch(source.downloadUrl, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`)
    const bytes = source.kind === 'public-issue-report'
      ? Buffer.from((await response.json()).body, 'utf8') : Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`${source.id}: source changed; inspect before updating pin`)
    const text = bytes.toString('utf8')
    for (const sample of corpus.cases.filter(c => c.sourceId === source.id)) {
      const offset = text.indexOf(sample.excerpt)
      if (offset < 0 || text.slice(0, offset).split('\n').length !== sample.sourceLine) throw new Error(`${sample.id}: excerpt/line mismatch`)
    }
  }
  return { verifiedSources: corpus.sources.length, verifiedExcerpts: corpus.cases.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = process.argv.includes('--verify-sources') ? await verifyPublicSources() : await evaluatePublicCorpus()
  console.log(JSON.stringify(result, null, 2))
  if (result.unexpectedAuto?.length || result.unexpectedManual?.length) process.exitCode = 1
}
