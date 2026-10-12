import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, createApprovalHandler } from '../index.js'
import { inspectCommand, powershellCommandPlan, powershellCommandWords, securityTarget, sensitivePath, unverifiedWindowsPath } from '../danger-patterns.js'

function request(command = 'git status', tool = 'pwsh') {
  const justification = 'due to a sandbox permission issue (same as grantwrite acl problem)'
  const args = { command, description: 'Inspect local state', sandbox_permissions: 'danger-full-access', justification }
  return { toolName: tool, callId: 'windows-call', reason: `escalate sandbox to danger-full-access: ${justification}`,
    agent: { session: { id: 'windows-session', header: { cwd: tmpdir() }, events: [
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'windows-call', name: tool, arguments: JSON.stringify(args) } },
    ] } } }
}

function runner({ shadowMode = false, verdict = 'approve', onStream } = {}) {
  let calls = 0
  const rows = []
  const logs = []
  const evidence = []
  const ctx = {
    get(name) {
      if (name === 'permissionPresets') return { current: () => 'sandboxed-auto' }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) }
      if (name === 'llm') return { async *stream(options) {
        calls++
        evidence.push(JSON.parse(options.messages[0].content[0].text))
        onStream?.()
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ risk: 'low', verdict, reasonCode: 'routine' }) } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    },
    logger: { info(message) { logs.push(message) } },
  }
  const handle = createApprovalHandler(ctx, Config({ shadowMode }), [], { recordDecision: row => rows.push(row) })
  return { rows, logs, evidence, get calls() { return calls }, run: req => handle(req, () => 'manual') }
}

test('pwsh uses its verified command and reaches classification with shell/platform evidence', async () => {
  const app = runner()
  assert.equal(await app.run(request()), 'allowed-once')
  assert.equal(app.calls, 1)
  assert.equal(app.evidence[0].shell, 'pwsh')
  assert.equal(app.evidence[0].platform, process.platform)
  assert.equal(app.evidence[0].command, 'git status')
  assert.equal(app.rows[0].tool, 'pwsh')
  assert.equal(app.rows[0].callHash, createHash('sha256').update(JSON.stringify('windows-call')).digest('hex').slice(0, 16))
  assert.doesNotMatch(JSON.stringify(app.rows), /grantwrite|git status/)
})

test('PowerShell handoffs distinguish unsupported syntax, aliases, and Python execution', async () => {
  const cases = [
    [String.raw`python -m py_compile "D:\AI\票据审核应用\InvoiceTool.py"; if ($LASTEXITCODE -eq 0) { "SYNTAX OK" }`, 'python-compile-environment-unverified'],
    [String.raw`python -m py_compile "D:\AI\票据审核应用\InvoiceTool.py"`, 'python-compile-environment-unverified'],
    ['python -I -S -m py_compile InvoiceTool.py', 'python-compile-environment-unverified'],
    ['python -c "print(1)"', 'untrusted-execution'],
    ['powershell -Command "Get-Date"', 'untrusted-execution'],
    ['Get-Content file.txt', 'unsupported-command'],
    ['rm file.txt', 'unsupported-command'],
    ['curl https://example.invalid', 'unsupported-command'],
    ['echo safe', 'unsupported-command'],
    ['git push origin main --force', 'shared-environment'],
    [String.raw`git diff "C:\Users\test\.aws\credentials"`, 'credentials'],
    [String.raw`git -C "C:\Users\test\.dsh" status`, 'security-config'],
    [String.raw`git -C "\\server\share" status`, 'path-unverified'],
    [String.raw`git -C C:relative status`, 'path-unverified'],
    [String.raw`git diff "C:\file.txt:stream"`, 'path-unverified'],
    [String.raw`C:\local\git.exe status`, 'execution-environment-unverified'],
  ]
  for (const [command, reason] of cases) {
    const app = runner()
    assert.equal(await app.run(request(command)), 'manual', command)
    assert.equal(app.calls, 0, command)
    assert.equal(app.rows[0].reasonCode, reason, command)
  }
})

test('pwsh request identity, unknown arguments and unsupported tools fail before classification', async () => {
  for (const mutate of [
    req => { req.toolName = 'bash' },
    req => { req.agent.session.events.push(structuredClone(req.agent.session.events[0])) },
    req => { req.reason += ' different' },
    req => { const call = req.agent.session.events[0].data; call.arguments = JSON.stringify({ ...JSON.parse(call.arguments), script: 'git status' }) },
    req => { const call = req.agent.session.events[0].data; call.arguments = JSON.stringify({ ...JSON.parse(call.arguments), timeoutMs: -1 }) },
  ]) {
    const req = request(); mutate(req)
    const app = runner()
    assert.equal(await app.run(req), 'manual')
    assert.equal(app.calls, 0)
    assert.equal(app.rows[0].reasonCode, 'call-unverified')
  }
  const app = runner()
  assert.equal(await app.run(request('git status', 'unknown')), 'manual')
  assert.equal(app.rows[0].reasonCode, 'unsupported-tool')
})

test('pwsh honors model ask, shadow mode, cancellation and evidence changes', async () => {
  for (const options of [{ verdict: 'ask' }, { shadowMode: true }]) {
    const app = runner(options)
    assert.equal(await app.run(request()), 'manual')
    assert.equal(app.calls, 1)
  }
  const cancelled = request(); cancelled.signal = AbortSignal.abort()
  const app = runner()
  assert.equal(await app.run(cancelled), 'manual')
  assert.equal(app.calls, 0)
  const req = request()
  const changing = runner({ onStream() { req.agent.session.events[0].data.arguments = '{}'; } })
  assert.equal(await changing.run(req), 'manual')
  assert.equal(changing.rows[0].reasonCode, 'context-changed')
})

const staticCommands = [
  [String.raw`python -m py_compile "D:\AI\票据 审核\InvoiceTool.py"`, ['python', '-m', 'py_compile', String.raw`D:\AI\票据 审核\InvoiceTool.py`]],
  [String.raw`git -C 'D:\project files' status`, ['git', '-C', String.raw`D:\project files`, 'status']],
  ['git status', ['git', 'status']],
  ['git diff "literal;name"', ['git', 'diff', 'literal;name']],
]

const compoundCommands = [
  'git status; if ($LASTEXITCODE -eq 0) { "SYNTAX OK" }',
  String.raw`python -I -S -B -m py_compile "D:\AI\票据 审核\InvoiceTool.py"; if ($LASTEXITCODE -eq 0) { 'SYNTAX OK' }`,
  'git status ; IF ( $lastExitCode -eq 0 ) { "Done" }',
]

test('PowerShell success-message grammar validates the entire suffix and primary command', () => {
  for (const command of compoundCommands) assert.equal(powershellCommandPlan(command)?.kind, 'success-message')
  for (const command of [
    'git status; if ($LASTEXITCODE -eq 0) { whoami }',
    'git status; if ($LASTEXITCODE -eq 0) { "$(whoami)" }',
    'git status; if ($LASTEXITCODE -eq 0) { "OK"; whoami }',
    'git status; if ($LASTEXITCODE -eq 0) { "OK" }; whoami',
    'git status; if ($LASTEXITCODE -eq 0) { "OK" } else { whoami }',
    'git status; if ($LASTEXITCODE -ne 0) { "OK" }',
    'git status; if ($LASTEXITCODE -eq (whoami)) { "OK" }',
    'git status; whoami; if ($LASTEXITCODE -eq 0) { "OK" }',
    'git status | whoami; if ($LASTEXITCODE -eq 0) { "OK" }',
    'git status; if ($LASTEXITCODE -eq 0) { "`"; whoami; "" }',
  ]) assert.equal(powershellCommandPlan(command), undefined, command)
  assert.equal(inspectCommand('git push origin main --force; if ($LASTEXITCODE -eq 0) { "OK" }', { shell: 'pwsh' }).handoffReason, 'shared-environment')
})

test('bounded compound grammar agrees with native PowerShell AST (parse only)', { skip: process.platform !== 'win32' }, () => {
  const script = `
$items = [Console]::In.ReadToEnd() | ConvertFrom-Json
$results = @()
foreach ($item in $items) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($item, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0 -or $ast.EndBlock.Statements.Count -ne 2) { throw 'Unexpected statements' }
  $primary = $ast.EndBlock.Statements[0]
  $condition = $ast.EndBlock.Statements[1]
  if ($primary.PipelineElements.Count -ne 1 -or $condition -isnot [System.Management.Automation.Language.IfStatementAst] -or $condition.Clauses.Count -ne 1 -or $null -ne $condition.ElseClause) { throw 'Unexpected control flow' }
  $expr = $condition.Clauses[0].Item1.PipelineElements[0].Expression
  if ($expr -isnot [System.Management.Automation.Language.BinaryExpressionAst] -or $expr.Operator.ToString() -ne 'Ieq' -or $expr.Left.VariablePath.UserPath.ToLowerInvariant() -ne 'lastexitcode' -or $expr.Right.Value -ne 0) { throw 'Unexpected condition' }
  $body = $condition.Clauses[0].Item2.Statements
  $literal = $body[0].PipelineElements[0].Expression
  if ($body.Count -ne 1 -or $body[0].PipelineElements.Count -ne 1 -or $literal -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { throw 'Unexpected body' }
  $results += @{ kind = 'success-message'; command = $primary.Extent.Text; message = $literal.Value }
}
ConvertTo-Json -InputObject $results -Compress
`
  const actual = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { input: JSON.stringify(compoundCommands), encoding: 'utf8', timeout: 15000 }))
  assert.deepEqual(actual, compoundCommands.map(command => {
    const { kind, command: primary, message } = powershellCommandPlan(command)
    return { kind, command: primary, message }
  }))
})

test('static PowerShell tokenizer preserves literal Windows paths and rejects expansion/composition', () => {
  for (const [command, words] of staticCommands) assert.deepEqual(powershellCommandWords(command), words)
  for (const command of [
    'git status; whoami', 'git status | more', 'git status > file', 'git $args', 'git "$(whoami)"',
    'git "`n"', 'git --% status', '& git status', 'git @args', 'git st*', 'git status # comment',
    "git 'a''b'", "git 'a'b", 'git "a"b', "'git' status", 'git status\nwhoami', 'git status\0',
    'git “push” origin main --force', 'git "" push origin main --force',
  ]) assert.equal(powershellCommandWords(command), undefined, command)
  assert.equal(inspectCommand('echo safe', { shell: 'bash' }).handoffReason, undefined)
  assert.equal(inspectCommand('echo safe', { shell: 'pwsh' }).handoffReason, 'unsupported-command')
})

test('Windows path guards work on every test host, including normalization and case', () => {
  for (const path of [String.raw`C:\Users\Alice\.aws\credentials`, String.raw`C:\Users\Alice\.ssh\..\.ssh\id_rsa`, String.raw`C:\project\.ENV`, String.raw`C:\project\.env. `]) assert.equal(sensitivePath(path), true, path)
  for (const path of [String.raw`C:\Users\Alice\.DSH\config.yml`, String.raw`C:\Windows\System32`, String.raw`C:\Program Files\app`, String.raw`C:\Users\Alice\AppData\Roaming\dsh\config`, String.raw`C:\Users\Alice\.dsh.\config`]) assert.equal(securityTarget(path), true, path)
  for (const path of [String.raw`C:\project\InvoiceTool.py`, String.raw`D:\AI\票据审核应用\InvoiceTool.py`]) {
    assert.equal(sensitivePath(path), false)
    assert.equal(securityTarget(path), false)
    assert.equal(unverifiedWindowsPath(path), false)
  }
  for (const path of [String.raw`\\?\C:\project`, String.raw`\\server\share`, 'C:relative', String.raw`C:\file:stream`]) assert.equal(unverifiedWindowsPath(path), true, path)
})

test('Windows-sensitive file writes are guarded before model approval on every host', async () => {
  for (const file_path of [String.raw`C:\Users\Alice\.dsh\config.yml`, String.raw`C:\Users\Alice\.aws\credentials`, String.raw`\\server\share\file.txt`]) {
    const req = request('', 'write')
    req.agent.session.events[0].data.arguments = JSON.stringify({ file_path, content: 'fixture', sandbox_permissions: 'danger-full-access', justification: req.reason.split(': ').slice(1).join(': ') })
    const app = runner()
    assert.equal(await app.run(req), 'manual', file_path)
    assert.equal(app.calls, 0)
  }
})

test('static tokenizer matches native PowerShell AST values (parse only)', { skip: process.platform !== 'win32' }, () => {
  // The input is JSON on stdin, never interpolated into executable script.
  const script = `$items = [Console]::In.ReadToEnd() | ConvertFrom-Json; $results = @(); foreach ($item in $items) { $tokens = $null; $errors = $null; $ast = [System.Management.Automation.Language.Parser]::ParseInput($item, [ref]$tokens, [ref]$errors); if ($errors.Count -ne 0 -or $ast.EndBlock.Statements.Count -ne 1 -or $ast.EndBlock.Statements[0].PipelineElements.Count -ne 1) { throw 'Unexpected syntax' }; $elements = $ast.EndBlock.Statements[0].PipelineElements[0].CommandElements; $results += ,@($elements | ForEach-Object { if ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $_.Value } elseif ($_ -is [System.Management.Automation.Language.CommandParameterAst] -and $null -eq $_.Argument) { '-' + $_.ParameterName } else { throw 'Unexpected argument' } }) }; ConvertTo-Json -InputObject $results -Compress`
  const actual = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { input: JSON.stringify(staticCommands.map(([command]) => command)), encoding: 'utf8', timeout: 15000 }))
  assert.deepEqual(actual, staticCommands.map(([, words]) => words))
})

test('isolated Python compile writes cache but does not run source or cwd shadow module', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'approval-compile-'))
  try {
    await writeFile(join(dir, 'InvoiceTool.py'), 'raise RuntimeError("source must not execute")\n')
    await writeFile(join(dir, 'py_compile.py'), 'raise RuntimeError("cwd module must not load")\n')
    // CPython py_compile docs: explicit compilation writes a cache even when
    // -B disables caches from imports. Exercise the exact P3 candidate flags.
    execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-S', '-B', '-m', 'py_compile', 'InvoiceTool.py'], { cwd: dir, timeout: 15000 })
    const files = await readdir(join(dir, '__pycache__'))
    assert.equal(files.length, 1)
    assert.match(files[0], /^InvoiceTool\..*\.pyc$/)
    assert.match(await readFile(join(dir, 'InvoiceTool.py'), 'utf8'), /must not execute/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('CPython documented non-regular cache refusal preserves the existing target', async () => {
  // Source: pinned CPython Doc/library/py_compile.rst in public corpus manifest.
  const dir = await mkdtemp(join(tmpdir(), 'approval-cache-kind-'))
  try {
    const script = `import pathlib, py_compile
source = pathlib.Path('InvoiceTool.py')
source.write_text('raise RuntimeError("must not execute")\\n', encoding='utf-8')
target = pathlib.Path('cache-target')
target.mkdir()
sentinel = target / 'keep.txt'
sentinel.write_text('keep', encoding='utf-8')
try:
    py_compile.compile(str(source), cfile=str(target), doraise=True)
except FileExistsError:
    pass
else:
    raise AssertionError('non-regular output was accepted')
assert sentinel.read_text(encoding='utf-8') == 'keep'
`
    execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-S', '-B', '-c', script], { cwd: dir, timeout: 15000 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
