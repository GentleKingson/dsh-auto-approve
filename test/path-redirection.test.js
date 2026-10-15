import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Config, canonicalTarget, createApprovalHandler } from '../index.js'
import { inspectCommand } from '../danger-patterns.js'

// Disposable fixtures only: the "protected" directory is a mock `.dsh` under a
// fresh temp root, never a real profile. Nothing is executed; the tests check
// how requests are classified. Windows uses junctions (no privilege needed).
const linkDir = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')

function fixture() {
  // Native realpath, like canonicalTarget: it also expands Windows 8.3 names (RUNNER~1).
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'approval-links-')))
  const workspace = join(root, 'workspace')
  const protectedDir = join(root, 'profile', '.dsh')
  const ordinary = join(root, 'docs')
  for (const dir of [workspace, protectedDir, ordinary, join(workspace, 'plain')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(workspace, 'a.txt'), 'fixture')
  linkDir(protectedDir, join(workspace, 'innocent'))
  linkDir(ordinary, join(workspace, 'docs-link'))
  linkDir(join(root, 'missing'), join(workspace, 'dangling'))
  return { root, workspace, protectedDir, ordinary, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function request(workspace, tool, args) {
  const justification = 'Disposable path classification check.'
  const full = { ...args, sandbox_permissions: 'danger-full-access', justification }
  return { toolName: tool, callId: 'link-call', reason: `escalate sandbox to danger-full-access: ${justification}`,
    agent: { session: { id: 'link-session', header: { cwd: workspace }, events: [
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'link-call', name: tool, arguments: JSON.stringify(full) } },
    ] } } }
}

function runner({ onStream, risk = 'low' } = {}) {
  let calls = 0
  const rows = []
  const ctx = {
    get(name) {
      if (name === 'permissionPresets') return { current: () => 'sandboxed-auto' }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) }
      if (name === 'llm') return { async *stream() {
        calls++
        onStream?.()
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ risk, verdict: 'approve', reasonCode: 'routine' }) } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    },
    logger: { info() {} },
  }
  const handle = createApprovalHandler(ctx, Config({ shadowMode: false, sessionMemory: false }), [], { recordDecision: row => rows.push(row) })
  return { rows, get calls() { return calls }, run: req => handle(req, () => 'manual') }
}

test('canonicalTarget resolves existing links, keeps missing tails and rejects dangling links', () => {
  const f = fixture()
  try {
    assert.equal(canonicalTarget(join(f.workspace, 'a.txt')), join(f.workspace, 'a.txt'))
    assert.equal(canonicalTarget(join(f.workspace, 'plain', 'new', 'file.txt')), join(f.workspace, 'plain', 'new', 'file.txt'))
    assert.equal(canonicalTarget(join(f.workspace, 'innocent', 'config.yml')), join(realpathSync.native(f.protectedDir), 'config.yml'))
    assert.equal(canonicalTarget(join(f.workspace, 'docs-link', 'x', 'y')), join(realpathSync.native(f.ordinary), 'x', 'y'))
    assert.throws(() => canonicalTarget(join(f.workspace, 'dangling')))
    assert.throws(() => canonicalTarget(join(f.workspace, 'dangling', 'child.txt')))
  } finally {
    f.cleanup()
  }
})

test('existing path rules also apply to the real target, and only there', () => {
  // Keys use this platform's resolve(), as inspectCommand does (D:\w\out on Windows).
  const map = new Map([['/w/out', '/home/u/.dsh/out'], ['/w/notes', '/home/u/.ssh/id_rsa'], ['/w/link', '/home/u/.dsh']].map(([key, value]) => [resolve(key), value]))
  const realTarget = path => map.get(path) ?? path
  const at = (command, shell = 'bash') => inspectCommand(command, { workdir: '/w', shell, realTarget }).handoffReason
  assert.equal(at('cp a.txt out'), 'security-config')
  assert.equal(at('cat notes'), 'credentials')
  assert.equal(at("git -C '/w/link' status", 'pwsh'), 'security-config')
  assert.equal(at("git init '/w/link'", 'pwsh'), 'security-config')
  // Identity view: identical to the lexical result for representative commands.
  for (const [command, shell] of [['cp a.txt b.txt', 'bash'], ['cat README.md', 'bash'], ['git status', 'pwsh'], ["git init '/w/repo'", 'pwsh'], ['tee log.txt', 'bash'], ['rm -rf /', 'bash']]) {
    assert.equal(inspectCommand(command, { workdir: '/w', shell, realTarget: path => path }).handoffReason, inspectCommand(command, { workdir: '/w', shell }).handoffReason, command)
  }
  // Rules that never looked at a path (e.g. a plain touch) do not start to.
  assert.equal(inspectCommand('touch out', { workdir: '/w', realTarget }).handoffReason, undefined)
})

test('a link into a protected or sensitive target hands off locally before the model', async () => {
  const f = fixture()
  try {
    for (const [tool, args] of [
      ['write', { file_path: join(f.workspace, 'innocent', 'config.yml'), content: 'fixture' }],
      ['write', { file_path: 'innocent/config.yml', content: 'fixture' }],
      ['edit', { file_path: join(f.workspace, 'innocent', 'config.yml'), old_string: 'a', new_string: 'b' }],
      ['bash', { command: 'cp a.txt innocent/config.yml', description: 'Copy a fixture' }],
      ['pwsh', { command: `git init '${join(f.workspace, 'innocent', 'repo')}'`, description: 'Create a fixture repository' }],
      ['pwsh', { command: `git -C '${join(f.workspace, 'innocent')}' status`, description: 'Inspect a fixture repository' }],
    ]) {
      const app = runner()
      assert.equal(await app.run(request(f.workspace, tool, args)), 'manual', `${tool} ${JSON.stringify(args)}`)
      assert.equal(app.calls, 0)
      assert.equal(app.rows[0].reasonCode, 'path-redirected')
    }
  } finally {
    f.cleanup()
  }
})

test('dangling links are unverified, while ordinary paths and non-protected links keep their outcome', async () => {
  const f = fixture()
  try {
    const dangling = runner()
    assert.equal(await dangling.run(request(f.workspace, 'write', { file_path: join(f.workspace, 'dangling'), content: 'fixture' })), 'manual')
    assert.equal(dangling.calls, 0)
    assert.equal(dangling.rows[0].reasonCode, 'path-unverified')
    for (const target of ['plain', 'docs-link']) {
      const app = runner()
      assert.equal(await app.run(request(f.workspace, 'pwsh', { command: `git init '${join(f.workspace, target, 'repo')}'`, description: 'Create a fixture repository' })), 'allowed-once', target)
      assert.equal(app.calls, 1)
      // write keeps its medium floor: it reaches the model and a low reply stays manual as before.
      const write = runner()
      assert.equal(await write.run(request(f.workspace, 'write', { file_path: join(f.workspace, target, 'notes.txt'), content: 'fixture' })), 'manual', target)
      assert.equal(write.calls, 1)
      assert.equal(write.rows[0].reasonCode, 'risk-understated')
    }
    // Non-path words that cannot name a file (an over-long message) are not unverified paths.
    const message = runner()
    assert.equal(await message.run(request(f.workspace, 'pwsh', { command: `git commit -m '${'long message '.repeat(40)}'`, description: 'Commit fixture work' })), 'allowed-once')
    assert.equal(message.calls, 1)
  } finally {
    f.cleanup()
  }
})

test('a link that appears while the model runs blocks the approval (narrows, does not close, TOCTOU)', async () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'swap')
    mkdirSync(target)
    const app = runner({ onStream() { rmSync(target, { recursive: true }); linkDir(f.protectedDir, target) } })
    assert.equal(await app.run(request(f.workspace, 'pwsh', { command: `git init '${join(target, 'repo')}'`, description: 'Create a fixture repository' })), 'manual')
    assert.equal(app.calls, 1)
    assert.equal(app.rows[0].reasonCode, 'context-changed')
  } finally {
    f.cleanup()
  }
})
