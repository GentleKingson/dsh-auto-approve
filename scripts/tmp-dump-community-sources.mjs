// TEMPORARY (removed before review): print public source texts so the casebook can be pinned.
import { readFile } from 'node:fs/promises'
import { fetchSource, excerptLine } from './community-sources.mjs'
const corpus = JSON.parse(await readFile(new URL('../test/fixtures/dsh-community-approval-cases-2026-10-12.json', import.meta.url)))
const token = process.env.GITHUB_TOKEN
for (const source of corpus.sources) {
  try {
    const fetched = await fetchSource(source, token)
    console.log(`=====SOURCE ${source.id} ${JSON.stringify({ title: fetched.title, createdAt: fetched.createdAt, updatedAt: fetched.updatedAt, state: fetched.state, bodySha256: fetched.bodySha256, bodyBytes: Buffer.byteLength(fetched.body), comments: fetched.comments.length })}`)
    for (const sample of corpus.cases.filter(c => c.sourceId === source.id)) {
      const needle = sample.command ?? ''
      const hits = needle ? fetched.parts.filter(p => p.text.includes(needle)).map(p => `${p.location}@${excerptLine(p.text, needle)}`) : []
      console.log(`  CASE ${sample.id} ${JSON.stringify(needle)} -> ${hits.slice(0, 5).join(', ') || 'NOT-FOUND'}`)
    }
    for (const part of fetched.parts) {
      console.log(`-----PART ${source.id} ${part.location} ${part.sha256} ${part.url}`)
      console.log(part.text.length > 6000 ? part.text.slice(0, 6000) + '\n[...truncated]' : part.text)
    }
  } catch (error) {
    console.log(`=====SOURCE ${source.id} ERROR ${error.message}`)
  }
}
