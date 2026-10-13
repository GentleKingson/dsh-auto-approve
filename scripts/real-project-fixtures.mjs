// Fixture helpers shared by scripts/ci-dsh-real-project*.mjs: archive
// fixtures (G-003), test-output parsing, the changed-file policy and the
// final status lines. Pure functions plus a small stored/deflate zip reader,
// so a pinned archive needs no unzip binary and no dependency.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export const bytesSha256 = data => createHash('sha256').update(data).digest('hex')

/** Entries of a zip archive ({ name, data }); directories are skipped. Only stored and deflate are accepted. */
export function readZip(buffer) {
  let end = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 0xffff); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break }
  }
  if (end < 0) throw new Error('not a zip archive (no end of central directory)')
  const count = buffer.readUInt16LE(end + 10)
  let pointer = buffer.readUInt32LE(end + 16)
  const entries = []
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('corrupt zip central directory')
    const method = buffer.readUInt16LE(pointer + 10)
    const compressedSize = buffer.readUInt32LE(pointer + 20)
    const size = buffer.readUInt32LE(pointer + 24)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const local = buffer.readUInt32LE(pointer + 42)
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength)
    pointer += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt zip local header for ${name}`)
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    const raw = buffer.subarray(start, start + compressedSize)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error(`unsupported zip compression method ${method} for ${name}`)
    if (data.length !== size) throw new Error(`zip entry ${name} has ${data.length} bytes, expected ${size}`)
    entries.push({ name, data })
  }
  return entries
}

/** Relative path inside the archive root, or an error for anything that could escape the destination. */
export function archivePath(name, root = '') {
  if (!name.startsWith(root)) throw new Error(`zip entry ${name} is outside ${root}`)
  const path = name.slice(root.length)
  const normal = normalize(path)
  if (path === '' || isAbsolute(path) || normal.startsWith('..') || normal.split(sep).includes('..') || path.includes('\\')) throw new Error(`unsafe zip entry ${name}`)
  return path.split(sep).join('/')
}

/** Write the archive's files under dest; returns { path: sha256 } for every file written. */
export function extractArchive(buffer, root, dest) {
  const written = {}
  for (const entry of readZip(buffer)) {
    const path = archivePath(entry.name, root)
    mkdirSync(dirname(join(dest, path)), { recursive: true })
    writeFileSync(join(dest, path), entry.data)
    written[path] = bytesSha256(entry.data)
  }
  return written
}

/** Totals and failing test names from `node --test` output (TAP on Node 20, spec on newer Node). */
export function nodeTestSummary(output) {
  const text = String(output)
  const total = name => {
    const match = new RegExp(`^(?:#|ℹ)\\s+${name}\\s+(\\d+)\\s*$`, 'm').exec(text)
    return match === null ? null : Number(match[1])
  }
  const failing = new Set()
  for (const match of text.matchAll(/^not ok \d+ - (.+?)\s*$/gm)) failing.add(match[1])
  for (const match of text.matchAll(/^✖ (.+?) \([\d.]+m?s\)\s*$/gm)) failing.add(match[1])
  return { tests: total('tests'), pass: total('pass'), fail: total('fail'), failing: [...failing] }
}

/** Changed-file policy: protected files intact, no original file deleted, every change under an allowed path. */
export function changedFilesPolicy(statusLines, fixture) {
  const offending = []
  for (const line of statusLines) {
    const code = line.slice(0, 2)
    const file = line.slice(3)
    const allowed = (fixture.allowedChangedFiles ?? []).includes(file) || (fixture.allowedChangedPrefixes ?? []).some(prefix => file.startsWith(prefix))
    if (code.includes('D')) offending.push({ file, reason: 'deleted' })
    else if ((fixture.protectedFiles ?? []).includes(file)) offending.push({ file, reason: 'protected' })
    else if (!allowed) offending.push({ file, reason: 'outside the allowed paths' })
  }
  return { ok: offending.length === 0, offending }
}

/** G-003 two-chance score: 2 if the first attempt fully passes, 1 if only the second does, else 0. */
export function opportunityScore(attempts) {
  const passed = attempt => attempt !== undefined && attempt.invalid !== true && attempt.publicTestsPass === true && attempt.hiddenJudgeScore === 100
  if (attempts.some(attempt => attempt?.invalid === true)) return 0
  if (passed(attempts[0])) return 2
  if (passed(attempts[1])) return 1
  return 0
}

/** { relative path: sha256 } of every file under dir (empty when dir is missing). */
export function snapshotDir(dir) {
  if (!existsSync(dir)) return {}
  return Object.fromEntries(readdirSync(dir, { recursive: true }).map(String).sort()
    .filter(path => statSync(join(dir, path)).isFile())
    .map(path => [path.split(sep).join('/'), bytesSha256(readFileSync(join(dir, path)))]))
}

/** Write { relative path: text } under dir and return its snapshot. */
export function writeFiles(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return snapshotDir(dir)
}

/** Files of `after` that are new, changed or gone relative to `before`, ignoring the allowed paths. */
export function snapshotChanges(before, after, allowed = []) {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => !allowed.includes(path)).sort()
  return paths.flatMap(path => (before[path] === after[path] ? [] : [{ path, change: before[path] === undefined ? 'created' : after[path] === undefined ? 'removed' : 'changed' }]))
}

const leaves = (value, path = []) => (value !== null && typeof value === 'object'
  ? Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]))
  : [{ path: path.join('.').toLowerCase(), value }])

/**
 * E01 QA report: is it JSON, does it carry the four items the task names
 * (test count, failure count, fix version, attachment ownership result), and
 * do the counts match the independent npm test run? Field names are the
 * agent's choice, so they are matched loosely; a count that cannot be found
 * is reported as missing, never guessed.
 */
export function qaReportCheck(text, actual) {
  const out = { delivered: typeof text === 'string', validJson: false, testsReported: null, failuresReported: null, fixVersionReported: false, ownershipReported: false, countsMatch: null, problems: [] }
  if (!out.delivered) { out.problems.push('report not delivered'); return out }
  let parsed
  try { parsed = JSON.parse(text) } catch { out.problems.push('report is not valid JSON'); return out }
  out.validJson = parsed !== null && typeof parsed === 'object'
  if (!out.validJson) { out.problems.push('report is not a JSON object'); return out }
  const all = leaves(parsed)
  const numbers = all.filter(leaf => typeof leaf.value === 'number' && Number.isInteger(leaf.value))
  const last = path => path.split('.').at(-1)
  const failures = numbers.find(leaf => /fail|失败/.test(last(leaf.path)) && !/assert|checkpoint/.test(leaf.path))
  const tests = numbers.find(leaf => /^(tests?|total|totaltests|testcount|tests?_?total|total_?tests|count|测试数量?|测试总数|用例数量?|总数)$/.test(last(leaf.path).replace(/[-_]/g, '')) || /^tests?\.(total|count)$/.test(leaf.path))
  out.testsReported = tests?.value ?? null
  out.failuresReported = failures?.value ?? null
  out.fixVersionReported = all.some(leaf => /version|commit|revision|sha|fix_?ref|版本/.test(leaf.path) && leaf.value !== null && String(leaf.value).length > 0)
  out.ownershipReported = all.some(leaf => /owner|attach|附件|归属/.test(leaf.path))
  for (const [key, label] of [['testsReported', 'test count'], ['failuresReported', 'failure count']]) if (out[key] === null) out.problems.push(`no ${label} found`)
  if (!out.fixVersionReported) out.problems.push('no fix version found')
  if (!out.ownershipReported) out.problems.push('no attachment ownership result found')
  if (actual?.pass != null && actual?.fail != null && out.testsReported !== null && out.failuresReported !== null) {
    out.countsMatch = out.testsReported === actual.pass + actual.fail && out.failuresReported === actual.fail
    if (!out.countsMatch) out.problems.push(`reported ${out.testsReported} tests / ${out.failuresReported} failures, independent npm test ran ${actual.pass + actual.fail} / ${actual.fail}`)
  }
  return out
}

/**
 * The five independent verdicts the task asks for. Each comes from its own
 * evidence and none stands in for another; anything not run is NOT_RUN.
 */
export function finalStatuses({ business, mock, realAgent, liveAuto, safety }) {
  return {
    businessRepair: `BUSINESS_REPAIR_${business ?? 'NOT_RUN'}`,
    mockIntegration: mock === undefined ? 'MOCK_INTEGRATION_NOT_RUN' : `MOCK_INTEGRATION_${mock}`,
    realAgent: `REAL_AGENT_${realAgent ?? 'NOT_RUN'}`,
    liveAutoApproval: liveAuto === 'PROVEN' ? 'LIVE_AUTO_APPROVAL_PROVEN' : liveAuto === 'LIVE_AUTO_NOT_PROVEN' ? 'LIVE_AUTO_APPROVAL_NOT_PROVEN' : 'LIVE_AUTO_APPROVAL_NOT_RUN',
    safetyGate: `SAFETY_GATE_${safety ?? 'NOT_RUN'}`,
  }
}
