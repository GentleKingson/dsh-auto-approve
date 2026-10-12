import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pythonCompileCandidate, securityTarget, sensitivePath, unverifiedWindowsPath } from './danger-patterns.js'

const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const inside = (root, target) => {
  const path = relative(root, target)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** Host-owned capability only. No tool argument, project manifest or model
 * response may act as this provider. The host must enforce the receipt at the
 * actual executor boundary, including races after the approval returns. */
export const COMPILE_EVIDENCE_SERVICE = 'autoApproveExecutionEvidence'

function leaseCurrent(lease, requestHash) {
  try {
    if (typeof lease?.isCurrent !== 'function') return false
    const value = lease.isCurrent(requestHash)
    if (value === true) return true
    if (typeof value?.then === 'function') Promise.resolve(value).catch(() => {})
  } catch { /* A broken or asynchronous freshness check cannot approve. */ }
  return false
}

export function compileEvidenceRequest(context, req) {
  const candidate = pythonCompileCandidate(context.verified.command, req.toolName)
  if (candidate === undefined) return undefined
  const sourcePath = resolve(context.workdir, candidate.source)
  if (!inside(context.workspacePath, sourcePath) || sensitivePath(sourcePath) || securityTarget(sourcePath)) return undefined
  const binding = Object.freeze({ version: 1, sessionId: context.session.id, callId: req.callId,
    toolName: req.toolName, arguments: context.verified.raw, contextKey: context.key,
    workspacePath: context.workspacePath, workdir: context.workdir, platform: process.platform,
    candidate, sourcePath })
  return Object.freeze({ ...binding, requestHash: sha256(binding) })
}

function validateFacts(facts, request) {
  if (facts === null || typeof facts !== 'object' || facts.version !== 1
    || facts.requestHash !== request.requestHash || facts.platform !== request.platform
    || facts.shell !== request.toolName || facts.structure !== request.candidate.structure
    || !Number.isSafeInteger(facts.expiresAt) || facts.expiresAt <= Date.now()
    || facts.expiresAt > Date.now() + 120_000) return false
  for (const key of ['executionBound', 'parserVerified', 'runtimeProtected', 'shellStartupVerified', 'environmentBound', 'isolated', 'siteDisabled',
    'importBytecodeDisabled', 'sourceRegular', 'outputNoFollow']) if (facts[key] !== true) return false
  if (facts.cachePrefix !== null || !/^cpython-\d+t?$/.test(facts.cacheTag)
    || !hash(facts.executableSha256) || !hash(facts.runtimeSha256) || !hash(facts.sourceSha256)) return false
  for (const key of ['executablePath', 'runtimeRoot', 'sourcePath', 'sourceRealPath',
    'outputPath', 'outputParentRealPath', 'workspaceRealPath', 'cwdRealPath']) {
    const path = facts[key]
    if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path)
      || unverifiedWindowsPath(path) || resolve(path) !== path) return false
  }
  if (facts.workspaceRealPath !== request.workspacePath || facts.cwdRealPath !== request.workdir
    || facts.sourcePath !== request.sourcePath || facts.sourceRealPath !== request.sourcePath
    || !inside(facts.runtimeRoot, facts.executablePath)
    || facts.runtimeRoot === request.workspacePath || inside(request.workspacePath, facts.runtimeRoot)
    || inside(facts.runtimeRoot, request.workspacePath)) return false
  if ((isAbsolute(request.candidate.executable) || /[\\/]/.test(request.candidate.executable))
    && resolve(request.workdir, request.candidate.executable) !== facts.executablePath) return false
  const output = join(dirname(request.sourcePath), '__pycache__', `${basename(request.sourcePath).slice(0, -3)}.${facts.cacheTag}.pyc`)
  return facts.outputPath === output && facts.outputParentRealPath === dirname(output)
    && inside(request.workspacePath, output) && ['absent', 'regular-file'].includes(facts.outputKind)
}

/** Bounded acquisition; a late provider result is disposed even after abort.
 * No filesystem reads or execution are performed by the approval plugin. */
export async function acquireCompileEvidence(provider, request, { signal, timeoutMs }) {
  if (typeof provider?.acquire !== 'function') return { error: 'compile-evidence-unavailable' }
  const deadline = new AbortController()
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  let timer
  let onAbort
  let lease
  const dispose = value => {
    try {
      // Providers must use synchronous cleanup; absorb rejected promises too.
      Promise.resolve(value?.dispose?.()).catch(() => {})
    } catch { /* Cleanup never grants authority. */ }
  }
  try {
    if (combined.aborted) return { error: 'compile-evidence-cancelled' }
    timer = setTimeout(() => deadline.abort(), timeoutMs)
    const pending = Promise.resolve().then(() => provider.acquire(request, { signal: combined })).then(value => {
      if (combined.aborted) { dispose(value); return undefined }
      return value
    })
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('evidence acquisition aborted'))
      combined.addEventListener('abort', onAbort, { once: true })
    })
    lease = await Promise.race([pending, aborted])
    // Detach a serializable snapshot. Methods never enter model evidence.
    const facts = structuredClone(lease?.facts)
    if (!validateFacts(facts, request) || typeof lease?.dispose !== 'function' || !leaseCurrent(lease, request.requestHash)) {
      dispose(lease)
      return { error: 'compile-evidence-invalid' }
    }
    let disposed = false
    const factsDigest = sha256(facts)
    return Object.freeze({
      // Only a bounded derived summary is sent to the model, not provider text.
      summary: Object.freeze({ kind: 'python-py-compile', requestHash: request.requestHash,
        executableSha256: facts.executableSha256, runtimeSha256: facts.runtimeSha256,
        sourceSha256: facts.sourceSha256, sourcePath: facts.sourcePath, outputPath: facts.outputPath,
        isolated: true, siteDisabled: true, executionBound: true }),
      isCurrent() {
        try { return !disposed && !signal?.aborted && facts.expiresAt > Date.now()
          && sha256(lease.facts) === factsDigest && leaseCurrent(lease, request.requestHash) } catch { return false }
      },
      dispose() { if (!disposed) { disposed = true; dispose(lease) } },
    })
  } catch {
    dispose(lease)
    return { error: combined.aborted ? 'compile-evidence-cancelled' : 'compile-evidence-invalid' }
  } finally {
    clearTimeout(timer)
    if (onAbort) combined.removeEventListener('abort', onAbort)
  }
}
