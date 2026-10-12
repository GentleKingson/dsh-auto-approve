import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { corpusURL, evaluatePublicCorpus } from '../scripts/evaluate-public-corpus.mjs'
import { inspectCommand, powershellCommandPlan } from '../danger-patterns.js'

const corpus = JSON.parse(await readFile(corpusURL))

test('public corpus has unique commands and traceable, explicitly labelled sources', () => {
  const sources = new Map(corpus.sources.map(source => [source.id, source]))
  assert.equal(new Set(corpus.cases.map(c => `${c.shell}:${c.command}`)).size, corpus.cases.length)
  assert.equal(new Set(corpus.cases.map(c => c.id)).size, corpus.cases.length)
  for (const sample of corpus.cases) {
    const source = sources.get(sample.sourceId)
    assert.ok(source, sample.id)
    assert.match(source.sha256, /^[a-f0-9]{64}$/)
    assert.ok(sample.excerpt.length && sample.sourceLine > 0 && sample.rationale.length)
    assert.ok(['verbatim', 'adapted', 'derived'].includes(sample.provenance))
    if (sample.provenance === 'verbatim') assert.equal(sample.command, sample.excerpt)
    if (source.kind !== 'public-issue-report') assert.ok(source.url.includes(source.revision))
  }
})

test('public examples and adaptations challenge the entire approval handler with a permissive model', async () => {
  const result = await evaluatePublicCorpus()
  assert.deepEqual(result.unexpectedAuto, [])
  assert.deepEqual(result.unexpectedManual, [])
  // Medium-risk pushes may reach the model but its low-risk answer must fail.
  assert.ok(result.modelCalls >= result.expectedModelCandidates)
})

test('Git destructive guards distinguish dry-run flags from exclusions and operands', () => {
  for (const shell of ['bash', 'pwsh']) {
    for (const command of ['git reset --ha', 'git reset --har', 'git clean -e -n -f', 'git clean --exclude=-n -f', 'git clean -en -f', 'git clean -i -n', 'git clean --unknown -n']) {
      assert.ok(inspectCommand(command, { shell }).handoffReason, command)
    }
    for (const command of ['git clean -n -e -f', 'git clean --dry-run --exclude=n', 'git -C project clean -nd']) {
      assert.equal(inspectCommand(command, { shell }).handoffReason, undefined, command)
    }
    assert.equal(inspectCommand('git reset --soft HEAD', { shell }).minimumRisk, 'medium')
  }
})

test('all accepted public PowerShell primary commands agree with native AST (parse only)', { skip: process.platform !== 'win32' }, () => {
  const plans = corpus.cases.filter(c => c.shell === 'pwsh').map(c => powershellCommandPlan(c.command)).filter(Boolean)
  const script = `
$items = [Console]::In.ReadToEnd() | ConvertFrom-Json
$results = @()
foreach ($item in $items) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($item, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0 -or $ast.EndBlock.Statements.Count -ne 1 -or $ast.EndBlock.Statements[0].PipelineElements.Count -ne 1) { throw 'Unexpected syntax' }
  $elements = $ast.EndBlock.Statements[0].PipelineElements[0].CommandElements
  $results += ,@($elements | ForEach-Object {
    if ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $_.Value }
    elseif ($_ -is [System.Management.Automation.Language.CommandParameterAst] -and $null -eq $_.Argument) { '-' + $_.ParameterName }
    else { throw 'Unexpected argument' }
  })
}
ConvertTo-Json -InputObject $results -Compress
`
  const actual = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify(plans.map(p => p.command)), encoding: 'utf8', timeout: 20000,
  }))
  assert.deepEqual(actual, plans.map(p => [...p.words]))
})
