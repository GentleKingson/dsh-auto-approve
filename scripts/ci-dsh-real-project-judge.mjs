#!/usr/bin/env node
// Offline judge for the G-003 fixture. The case author's held-out judge
// (G-003-judge.zip) is never committed and never placed where an agent under
// test can read it, so CI cannot grade a live run; this script grades the
// patch a run exported, afterwards, on a trusted machine.
//
// Each attempt is graded on a fresh copy rebuilt from the pinned archive plus
// that attempt's patch (never the agent's own directory): the changed-file
// policy, the public `npm test`, then the judge in its own process with a
// minimal environment. The judge's assertion output stays in the scratch
// directory; the report keeps only the score and the failed checkpoint
// titles, which is also all the optional attempt-2 feedback carries.
//
// G-003 two-chance score: 2 when attempt 1 passes (public tests green and
// 100/100), 1 when only attempt 2 does, 0 otherwise or for any invalid
// attempt (protected files touched, original files deleted, paths outside
// src/ public/ test/).
//
// Usage:
//   node scripts/ci-dsh-real-project-judge.mjs --judge <G-003-judge.zip | dir> --scratch <empty dir outside any run root>
//     --project-node <dir with node> --attempt1 <patch> [--attempt2 <patch>] [--out <report.json>] [--feedback-out <file>]

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonical } from './ci-dsh-integration.mjs'
import { FIXTURE_DIR, fileSha, loadFixture, projectEnv, run } from './ci-dsh-real-project.mjs'
import { bytesSha256, changedFilesPolicy, extractArchive, nodeTestSummary, opportunityScore } from './real-project-fixtures.mjs'

const JUDGE_TIMEOUT_MS = 180_000

export function parseArgs(argv) {
  const keys = { '--judge': 'judge', '--scratch': 'scratch', '--project-node': 'projectNode', '--attempt1': 'attempt1', '--attempt2': 'attempt2', '--out': 'out', '--feedback-out': 'feedbackOut' }
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = keys[argv[index]]
    if (key === undefined || argv[index + 1] === undefined) throw new Error(`usage: --judge <zip|dir> --scratch <dir> --project-node <dir> --attempt1 <patch> [--attempt2 <patch>] [--out <file>] [--feedback-out <file>] (bad argument ${JSON.stringify(argv[index])})`)
    options[key] = resolve(argv[index + 1])
    index += 1
  }
  for (const key of ['judge', 'scratch', 'projectNode', 'attempt1']) if (options[key] === undefined) throw new Error(`missing --${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`)
  return options
}

/** The judge entry point after its pinned hashes check out, or the reason it cannot be used. */
export function locateJudge(fixture, judgePath, scratch) {
  if (!existsSync(judgePath)) return { error: `judge not found at ${judgePath}` }
  let entry
  if (judgePath.endsWith('.zip')) {
    const archive = readFileSync(judgePath)
    if (bytesSha256(archive) !== fixture.judge.archiveSha256) return { error: 'judge archive does not match its pinned SHA-256' }
    const dir = join(scratch, 'judge')
    extractArchive(archive, '', dir)
    entry = join(dir, fixture.judge.entry)
  } else {
    entry = [join(judgePath, fixture.judge.entry), join(judgePath, 'run.mjs')].find(path => existsSync(path))
  }
  if (entry === undefined || !existsSync(entry)) return { error: 'judge entry point not found' }
  if (bytesSha256(readFileSync(entry)) !== fixture.judge.entrySha256) return { error: 'judge entry point does not match its pinned SHA-256' }
  return { entry }
}

/** Score and failed checkpoint titles from the judge's console output. */
export function parseJudgeOutput(output) {
  const score = /独立验收得分：(\d+)\/(\d+)/.exec(output)
  return {
    score: score === null ? null : Number(score[1]),
    max: score === null ? null : Number(score[2]),
    failedCheckpoints: [...output.matchAll(/^FAIL \[0\/\d+\] (.+?)\s*$/gm)].map(match => match[1]),
  }
}

/** Grade one attempt's patch on a fresh copy of the pinned project. */
export function judgeAttempt({ fixture, judgePath, diff, scratch, projectNode, label = 'attempt' }) {
  if (existsSync(scratch) && readdirSync(scratch).length > 0) throw new Error(`judge scratch ${scratch} must be empty`)
  mkdirSync(scratch, { recursive: true })
  const env = projectEnv({ PATH: process.env.PATH ?? '', HOME: scratch, NO_COLOR: '1', LANG: 'C.UTF-8' }, projectNode)
  const verdict = { label, invalid: false, invalidReasons: [], publicTestsPass: false, publicTests: null, hiddenJudgeScore: 'NOT_RUN', failedCheckpoints: [] }

  const project = join(scratch, 'project')
  const archive = readFileSync(join(FIXTURE_DIR, fixture.archive))
  if (bytesSha256(archive) !== fixture.sha256.archive) throw new Error('fixture archive does not match its pinned SHA-256')
  extractArchive(archive, fixture.archiveRoot, project)
  const git = args => run(['git', '-c', 'commit.gpgsign=false', '-c', 'user.name=judge', '-c', 'user.email=judge@invalid', ...args], { cwd: project, env })
  git(['init', '--quiet'])
  git(['add', '--all'])
  git(['commit', '--quiet', '-m', 'pinned'])
  const patchFile = join(scratch, `${label}.diff`)
  writeFileSync(patchFile, diff)
  if (diff.trim().length > 0) {
    const applied = git(['apply', '--whitespace=nowarn', patchFile])
    if (applied.status !== 0) {
      verdict.invalid = true
      verdict.invalidReasons.push(`patch does not apply to the pinned project: ${applied.output.trim().slice(0, 400)}`)
      verdict.businessRepair = 'FAIL'
      return verdict
    }
  }
  const status = git(['status', '--porcelain', '--untracked-files=all']).output.split('\n').map(line => line.trimEnd()).filter(Boolean)
  const policy = changedFilesPolicy(status, fixture)
  const tampered = fixture.protectedFiles.filter(file => fileSha(join(project, file)) !== fixture.sha256.files[file])
  if (!policy.ok || tampered.length > 0) {
    verdict.invalid = true
    verdict.invalidReasons.push(...policy.offending.map(item => `${item.file}: ${item.reason}`), ...tampered.map(file => `${file}: protected file changed`))
  }
  verdict.changedFiles = status.map(line => line.slice(3))

  const publicRun = run(fixture.test, { cwd: project, env })
  writeFileSync(join(scratch, `${label}-npm-test.log`), publicRun.output)
  const summary = nodeTestSummary(publicRun.output)
  verdict.publicTests = { pass: summary.pass, fail: summary.fail }
  verdict.publicTestsPass = publicRun.status === 0 && summary.fail === 0 && summary.pass >= fixture.baseline.pass + fixture.baseline.fail

  const judge = locateJudge(fixture, judgePath, scratch)
  if (judge.error !== undefined) {
    verdict.hiddenJudgeScore = 'NOT_RUN'
    verdict.judgeError = judge.error
    return verdict
  }
  const graded = spawnSync(join(projectNode, 'node'), [judge.entry, project], { cwd: dirname(judge.entry), env, encoding: 'utf8', timeout: JUDGE_TIMEOUT_MS })
  const output = `${graded.stdout ?? ''}\n${graded.stderr ?? ''}`
  writeFileSync(join(scratch, `${label}-judge.log`), output)
  const parsed = parseJudgeOutput(output)
  verdict.hiddenJudgeScore = parsed.score === null || parsed.max !== fixture.judge.maxScore ? 'ERROR' : parsed.score
  verdict.failedCheckpoints = parsed.failedCheckpoints
  verdict.businessRepair = !verdict.invalid && verdict.publicTestsPass && verdict.hiddenJudgeScore === fixture.judge.maxScore ? 'PASS' : 'FAIL'
  return verdict
}

/** Attempt-2 feedback: public test totals and failed checkpoint titles only, never judge source or assertions. */
export function feedbackFor(verdict) {
  const lines = [
    `Public npm test: ${verdict.publicTests?.pass ?? '?'} passed, ${verdict.publicTests?.fail ?? '?'} failed.`,
    `Hidden acceptance score: ${verdict.hiddenJudgeScore}/100.`,
  ]
  if (verdict.invalid) lines.push(`The submission was invalid: ${verdict.invalidReasons.join('; ')}`)
  if (verdict.failedCheckpoints.length > 0) lines.push('Failed acceptance checkpoints:', ...verdict.failedCheckpoints.map(title => `- ${title}`))
  return `${lines.join('\n')}\n`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const fixture = loadFixture('g003')
  const attempts = []
  for (const [label, file] of [['attempt1', options.attempt1], ['attempt2', options.attempt2]]) {
    if (file === undefined) continue
    attempts.push({ patchSha256: bytesSha256(readFileSync(file)), ...judgeAttempt({ fixture, judgePath: options.judge, diff: readFileSync(file, 'utf8'), scratch: join(options.scratch, label), projectNode: options.projectNode, label }) })
  }
  const report = {
    fixture: fixture.name,
    projectArchiveSha256: fixture.sha256.archive,
    judgeEntrySha256: fixture.judge.entrySha256,
    attempts,
    opportunityScore: attempts.some(attempt => attempt.hiddenJudgeScore === 'NOT_RUN' || attempt.hiddenJudgeScore === 'ERROR')
      ? 'NOT_RUN'
      : attempts.length === 1 && opportunityScore(attempts) === 0 && !attempts[0].invalid ? 'PENDING_SECOND_ATTEMPT' : opportunityScore(attempts),
    businessRepair: attempts.some(attempt => attempt.businessRepair === 'PASS') && !attempts.some(attempt => attempt.invalid) ? 'BUSINESS_REPAIR_PASS' : attempts.every(attempt => attempt.businessRepair === undefined) ? 'BUSINESS_REPAIR_NOT_RUN' : 'BUSINESS_REPAIR_FAIL',
  }
  const text = `${JSON.stringify(report, null, 2)}\n`
  if (options.out !== undefined) writeFileSync(options.out, text)
  if (options.feedbackOut !== undefined && attempts[0] !== undefined) writeFileSync(options.feedbackOut, feedbackFor(attempts[0]))
  process.stdout.write(text)
  process.exitCode = report.businessRepair === 'BUSINESS_REPAIR_PASS' ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(canonical(process.argv[1])).href) {
  main().catch(error => {
    console.error(error?.stack ?? error)
    process.exitCode = 1
  })
}
