import { normalize, resolve } from 'node:path'

/**
 * Dependency-free built-in danger vocabulary shared by the runtime plugin and
 * the offline tuning script. Keep this module free of host or npm imports so
 * scripts/tune-from-logs.mjs remains a Node-standard-library-only tool.
 */
export const DEFAULT_DANGER_PATTERNS = Object.freeze([
  String.raw`\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(?:--\s+)?["']?(?:/|~)(?:[^\s"';&|]*)["']?`,
  String.raw`\bdd\b[^\n;&|]*\bof\s*=\s*["']?/dev/`,
  String.raw`\bmkfs(?:\.[a-z0-9_-]+)?\b`,
  String.raw`\bgit(?:\s+(?!push\b)[^\s;&|]+)*\s+push\b[^\n;&|]*(?:--force\b|-f\b|--mirror\b|(?:^|[\s"'])\+[^\s"';&|]+)`,
  String.raw`\b(?:curl|wget)\b[^\n|]*\|\s*(?:/usr/bin/env\s+)?(?:ba|z|da|k)?sh\b`,
  String.raw`\bdrop\s+(?:database|table)\b`,
  String.raw`\btruncate\b`,
  String.raw`(?:^|[\s;&|])(?:shutdown|reboot|halt)\b`,
  String.raw`\bchmod\s+-R\s+777\s+["']?/`,
  String.raw`:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`,
  String.raw`\bterraform\s+destroy\b`,
  String.raw`\bpulumi\s+destroy\b`,
  '(?=[^\\n]*\\b(?:rm|dd|mkfs(?:\\.[a-z0-9_-]+)?|chmod|chown)\\b)(?=[^\\n]*(?:\\$\\(|`|<\\())',
])

export const POLICY_VERSION = 'approval-v2'

/** A deliberately small word reader, not a shell parser. Reject composition,
 * expansion and escapes outside single quotes; unknown syntax goes to a human.
 * This is used to distinguish literal output from an executable action. */
export function simpleCommandWords(command) {
  if (typeof command !== 'string' || /[\r\n\0]/.test(command)) return undefined
  const words = []
  let word = ''
  let quote
  let started = false
  for (const char of command) {
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
    } else if (quote === '"') {
      if (char === '"') quote = undefined
      else if (/[$`\\]/.test(char)) return undefined
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (char === ' ' || char === '\t') {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      if (/[\s\p{White_Space};&|<>$`\\(){}*?\[\]#]/u.test(char)) return undefined
      word += char
      started = true
    }
  }
  if (quote !== undefined) return undefined
  if (started) words.push(word)
  return words.length === 0 ? undefined : words
}

export function sensitivePath(path) {
  const target = normalize(path)
  return /(?:^|\/)(?:\.ssh\/(?:id_[^/]+|config)|\.aws\/credentials|\.env(?:\.[^/]*)?|\.npmrc|\.netrc|\.git-credentials|[^/]*\.(?:pem|key)|credentials(?:\.json)?)(?:$|\/)/i.test(target)
    || /^\/(?:etc\/shadow|proc\/(?:self|\d+)\/environ)$/.test(target)
}

export function securityTarget(path) {
  return /(?:^|\/)(?:\.dsh|\.config\/dsh)(?:\/|$)|(?:^|\/)(?:\.bashrc|\.bash_profile|\.zshrc|\.profile)$|\/(?:LaunchAgents|LaunchDaemons)\//i.test(path)
    || /^\/(?:etc|usr|System|Library)(?:\/|$)/.test(path)
}

export function containsSecret(text) {
  return /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=-]{8,}|\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,})\b|\b(?:password|passwd|token|api[_-]?key|secret|access[_-]?key)\s*[=:]\s*["']?[^\s"']{4,}|https?:\/\/[^\s/:]+:[^\s/@]+@/i.test(text)
}

function result(handoffReason, minimumRisk = 'low', literalDisplay = false) {
  return Object.freeze({ handoffReason, minimumRisk, literalDisplay })
}

/** Non-overridable action guards. Configurable regexes are an additional layer.
 * This function never executes or predicts arbitrary code. */
export function inspectCommand(command, { workdir = '/' } = {}) {
  const words = simpleCommandWords(command)
  if (words === undefined) return result('uncertain')
  let args = words.slice(1)
  let executable = words[0].split('/').at(-1)
  if (words[0] === 'echo') return result(undefined, 'low', true)
  if (executable !== 'printf' && args.length === 1 && ['--help', '-h', '--version', '-V'].includes(args[0])) return result()
  if (executable === 'sudo') {
    if (args.length === 0 || args[0].startsWith('-')) return result('uncertain')
    executable = args[0].split('/').at(-1)
    args = args.slice(1)
    if (executable === 'sudo') return result('uncertain')
  }
  // Wrapper execution and environment indirection do not establish the
  // underlying action's identity in this bounded reader.
  if (['env', 'command', 'builtin', 'busybox', 'xargs', 'nice', 'nohup', 'timeout'].includes(executable)
    || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return result('uncertain')
  if (executable === 'printf') {
    // -v and %n assign variables; only these fixed string formats are proven output.
    const format = args[0] === '--' ? args[1] : args[0]
    return ['%s', '%s\\n'].includes(format) ? result(undefined, 'low', true) : result('uncertain')
  }
  if (executable === 'find' && args.some(arg => /^-(?:exec|execdir|ok|okdir)$/.test(arg))) return result('untrusted-execution')
  const joined = args.join(' ')
  const operands = args.filter(arg => !arg.startsWith('-'))
  let outputs = []
  if (['cp', 'mv', 'install'].includes(executable) && args.some(arg => /^-[^-]+t/.test(arg) && !arg.startsWith('-t'))) return result('uncertain')
  if (['cp', 'mv', 'install'].includes(executable) && !args.some(arg => arg.startsWith('-t') || arg.startsWith('--target-directory'))) outputs = operands.slice(-1)
  if (executable === 'tee') outputs = operands
  if (['chmod', 'chown'].includes(executable)) outputs = operands.slice(1)
  if (executable === 'sed' && args.some(arg => /^-[nErsuz]*i|^--in-place/.test(arg))) {
    const hasExpression = args.some(arg => /^-[nErsuz]*e|^--expression/.test(arg))
    let sawScript = hasExpression
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (['-e', '--expression'].includes(arg)) { index += 1; continue }
      if (/^-f|^--file/.test(arg)) return result('untrusted-execution')
      if (arg.startsWith('-')) continue
      if (!sawScript) sawScript = true
      else outputs.push(arg)
    }
  }
  const extractsArchive = executable === 'tar' && (args.some(arg => /^-[a-z]*x[a-z]*$|^--(?:extract|get)$/.test(arg)) || /^[a-z]*x[a-z]*$/.test(args[0] ?? ''))
  if (executable === 'tar' && args.some(arg => /^-[^-]+C/.test(arg) && !arg.startsWith('-C'))) return result('uncertain')
  const outputFlags = {
    curl: ['-o', '--output'], wget: ['-O', '--output-document'],
    tar: extractsArchive ? ['-C', '--directory'] : [], unzip: ['-d'],
    cp: ['-t', '--target-directory'], mv: ['-t', '--target-directory'], install: ['-t', '--target-directory'],
  }[executable] ?? []
  if (extractsArchive || (executable === 'unzip' && !args.some(arg => /^-[a-z]*[lp][a-z]*$/.test(arg)))) outputs.push(workdir)
  if (outputFlags.length > 0) {
    for (let index = 0; index < args.length; index += 1) {
      if (outputFlags.includes(args[index]) && args[index + 1] !== undefined) outputs.push(args[index + 1])
      for (const flag of outputFlags) {
        if (flag.startsWith('--') && args[index].startsWith(`${flag}=`)) outputs.push(args[index].slice(flag.length + 1))
        if (!flag.startsWith('--') && args[index].startsWith(flag) && args[index].length > flag.length) outputs.push(args[index].slice(flag.length))
      }
    }
  }
  if (outputs.some(path => securityTarget(resolve(workdir, path)) || securityTarget(path))) return result('security-config')
  if (['cat', 'head', 'tail', 'grep', 'rg', 'cp', 'scp', 'rsync'].includes(executable) && args.some(arg => sensitivePath(arg) || sensitivePath(resolve(workdir, arg)))) return result('credentials')
  if (executable === 'rm') {
    const targets = args.filter(arg => !arg.startsWith('-'))
    if (targets.length === 0 || targets.some(arg => /^(?:\/|~|\.\.(?:\/|$))/.test(arg))) return result('destructive')
    return result(undefined, 'medium')
  }
  if (executable === 'dd' && /\bof=\/dev\//.test(joined)) return result('destructive')
  if (/^mkfs(?:\.|$)/.test(executable) || ['shutdown', 'reboot', 'halt'].includes(executable)) return result('destructive')
  if (executable === 'chmod' && args.includes('-R') && args.includes('777') && args.includes('/')) return result('security-config')
  if (['terraform', 'pulumi'].includes(executable) && args.includes('destroy')) return result('destructive')
  if (['psql', 'mysql', 'sqlite3'].includes(executable) && /\b(?:drop\s+(?:database|table)|truncate)\b/i.test(joined)) return result('destructive')
  if (executable === 'truncate' || (executable === 'find' && args.includes('-delete'))) return result('destructive')
  if (executable === 'git') {
    while (args[0] === '-C' && args.length >= 3) {
      workdir = resolve(workdir, args[1])
      args = args.slice(2)
    }
    if (args[0]?.startsWith('-')) return result('uncertain')
    if (['clone', 'checkout', 'switch', 'reset', 'clean', 'pull'].includes(args[0])
      && (securityTarget(workdir) || (args[0] === 'clone' && securityTarget(resolve(workdir, args.at(-1)))))) return result('security-config')
    if (args[0] === 'push') {
      const pushArgs = args.slice(1)
      if (pushArgs.some(arg => /^--(?:force(?:-|$)|mirror(?:=|$)|delete(?:=|$))|^-[a-z]*[fd][a-z]*$|^\+/.test(arg))) return result('shared-environment')
      const refs = pushArgs.filter(arg => !arg.startsWith('-')).slice(1)
      if (refs.length === 0) return result('uncertain')
      if (refs.some(ref => /^(?:refs\/heads\/)?(?:main|master|prod|production|release)(?:$|\/)/i.test(ref.split(':').at(-1)))) return result('shared-environment')
      return result(undefined, 'medium')
    }
    if (args[0] === 'branch' && args.includes('-D')) return result('destructive')
  }
  if (['curl', 'wget'].includes(executable)) {
    const simpleFlags = executable === 'curl' ? /^-[fLsSkIvNq]+$/ : /^-[qspN]+$/
    const supportedValueFlag = executable === 'curl' ? /^-[odFTK].+/ : /^-O.+/
    if (args.some(arg => /^-[^-].+/.test(arg) && !simpleFlags.test(arg) && !supportedValueFlag.test(arg))) return result('uncertain')
    if (args.some(arg => /^(?:--config|-K)(?:=|$)|^-K./.test(arg))) return result('untrusted-execution')
    if (args.some(arg => /^--(?:upload-file|post-file)(?:=|$)|^-T./.test(arg) || arg === '-T')
      || args.some(arg => /^-[dF].*@|^--(?:data(?:-binary|-raw|-urlencode)?|form)=.*@/.test(arg))
      || (args.some(arg => /^(?:--data(?:-binary|-raw|-urlencode)?|--form|-d|-F)(?:=|$)/.test(arg)) && args.some(arg => /(?:^|=)@/.test(arg)))) return result('external-transfer')
  }
  if (executable === 'crontab' && !(args.length === 1 && args[0] === '-l')) return result('persistence')
  if (['systemctl', 'launchctl'].includes(executable) && args.some(arg => /^(?:enable|start|restart|load|bootstrap)$/.test(arg))) return result('persistence')
  if (executable === 'dsh' && args[0] === 'plugin' && args.some(arg => /^(?:add|remove|install|update|enable|disable)$/.test(arg))) return result('security-config')
  if (executable === 'nft' && args.includes('flush')) return result('security-config')
  if (executable === 'docker' && args.includes('prune')) return result('destructive')
  if (executable === 'kubectl' && args.includes('delete')) return result('shared-environment')
  if (executable === 'aws' && args.includes('rm')) return result('destructive')
  if (['eval', 'source', '.', 'ssh'].includes(executable)) return result('untrusted-execution')
  if (/^(?:ba|z|da|k)?sh$|^(?:python\d*(?:\.\d+)?|node|perl|ruby)$/.test(executable)) return result('untrusted-execution')
  if (['npm', 'pnpm', 'yarn'].includes(executable)) {
    if (args[0] === 'publish') return result('shared-environment')
    if (['install', 'i', 'add', 'update'].includes(args[0]) && args.some(arg => /^--global(?:=|$)|^-[a-z]*g[a-z]*$/.test(arg))) return result('persistence')
    if (args[0] === 'config' && ['set', 'delete'].includes(args[1])) return result('security-config')
    if (['exec', 'dlx'].includes(args[0])) return result('untrusted-execution')
    if (['install', 'i', 'ci', 'add', 'update'].includes(args[0])) return result(undefined, 'medium')
  }
  return result()
}
