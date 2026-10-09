<p align="center">
  <img src="./assets/icon.svg" width="96" alt="dsh-auto-approve shield and lightning icon">
</p>

<h1 align="center">dsh-auto-approve</h1>

<p align="center">
  <strong>More convenient than Workspace Write, safer than Full access / 比 Workspace Write 更省心，比 Full access 更安全</strong>
</p>

<p align="center">
  <a href="https://github.com/Jiao-XXX/dsh-auto-approve/actions/workflows/test.yml"><img src="https://github.com/Jiao-XXX/dsh-auto-approve/actions/workflows/test.yml/badge.svg" alt="test status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT"></a>
  <a href="https://dsh.directory/plugins/jiao-xxx/dsh-auto-approve"><img src="https://dsh.directory/badges/listed.svg" alt="Listed on DSH Directory"></a>
</p>

English | [中文](README.md)


`dsh-auto-approve` adds a **Sandboxed Auto** permission preset (preset id `sandboxed-auto`) to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). In that preset **the workspace sandbox stays in place**, and routine sandbox escalations may be approved once by a classifier model; deterministic danger matches, uncertain model decisions, timeouts, malformed responses, and internal failures continue to the normal human approval dialog.

The bundle restates the permission preset table as four entries, in this order: `read-only`, `workspace-write`, `sandboxed-auto`, and `danger-full-access` — this plugin's preset is inserted between the stock presets, all of which are preserved. Outside the `sandboxed-auto` preset, the plugin delegates every approval request unchanged.

> **Upgrading from 0.6.x?** From 0.7.0 the preset id changes from `auto` to `sandboxed-auto`: from dsh 0.1.7 on, `auto` is reserved for the shipped experimental Auto review, and keeping it makes the permission presets fail to load. Read [Upgrading from 0.6.x](#upgrading-from-06x) first.

## Positioning

Sandboxed Auto is a lower-friction safety layer on top of `workspace-write`: it keeps the same sandbox boundary and sends routine escalations to the classifier, while danger-list matches, classifier uncertainty, and classification failures return to human approval.

Unlike comparable schemes that switch the sandbox off and run their own approval channel, this plugin **relaxes no sandbox boundary**: the classifier only decides whether to grant **one** escalation, file tools and other non-shell operations stay sandboxed, and approvals still land in dsh's native session audit events.

Think of it as DeepSeek Harness's counterpart to [Claude Code's **auto mode**](https://code.claude.com/docs/en/permission-modes) and [Codex's **Auto-review mode**](https://developers.openai.com/codex/agent-approvals-security): routine approvals are handled automatically, while dangerous or uncertain actions go back to a human.

| Preset | Sandbox scope | When it prompts | Best for |
| --- | --- | --- | --- |
| `read-only` | Read-only workspace; project files cannot be changed | Writing, network access, or another out-of-bounds action needs escalation | Code review, exploration, and sensitive repositories |
| `workspace-write` | Workspace reads and writes are allowed; outside paths and restricted capabilities remain isolated | Network access, writes outside the workspace, or another sandbox escalation | Everyday development where a human reviews every escalation |
| **`sandboxed-auto`** | **Same as `workspace-write`** | **Routine escalations are auto-approved; destructive-list matches, classifier uncertainty, or failures go to a human** | **Long-running tasks and dependency installs; fewer interruptions with a complete audit trail** |
| `danger-full-access` | No workspace sandbox boundary; commands run with host permissions | No prompt (`approval: never`) | Isolated, disposable, fully trusted environments only |

## Compared with the official Auto review

From dsh 0.1.7 the install ships an **experimental** official preset, **Auto review** (package `@deepseek-ai/dsh-experimental-auto-review`, preset id `auto`, off by default, enabled from the sidebar **Plugins** page). The names are close, but it takes the opposite route:

| | Official Auto review | Sandboxed Auto (this plugin) |
| --- | --- | --- |
| Sandbox | **None** (Full access) | **Keeps** the workspace-write sandbox |
| What is reviewed | Every tool call | This preset’s sandbox escalation approval requests only; share not measured |
| Review model | The current agent's model; not changeable | Configurable, including a cheaper model |
| Deterministic floor | None | A danger list runs before the classifier and cannot be overridden |
| Configuration | None | Prompt, deadline, danger rules, session memory |
| When review fails | The call fails and does not run | Falls back to human approval |
| Where it works | Needs the Web layer enabled; not in Headless; cannot be the default for new sessions | Web / TUI / Desktop / Headless; can be the default preset |
| Audit | Risk tier, reasoning, and raw response are not persisted | Native `approval/asked` + `approval/decided` pairs and the `/auto-report` session ledger |

The official preset does things this plugin cannot: it reviews operations **inside** the workspace too, whereas this plugin never sees in-sandbox actions (such as deleting files in the project) because the sandbox already allows them; its review input is partitioned and deliberately excludes tool results against injection, with low/medium/high risk tiers that set authorization requirements; and it is maintained upstream, so it tracks dsh's interfaces.

**Which to use**: choose the official Auto review for maximum autonomy if you accept running without a sandbox and a per-call token cost; choose Sandboxed Auto to keep the sandbox as a hard boundary and let the model handle only boundary-crossing requests. The preset ids differ, so both can be installed and picked separately in the selector — this plugin acts only under `sandboxed-auto`, and when the official `auto` is selected it passes every approval request through unchanged, never answering an ask the official reviewer meant for you.

## How it works

Only the plugin preset's `approval/request` is handled:

1. Validate cancellation, workspace and a unique `tool/call`. Tool name, required arguments, sandbox target and native escalation reason must agree. Known `bash`, `write` and `edit` shapes are supported; missing, ambiguous or unknown evidence delegates.
2. Preserve genuine user messages and restrictions. The newest message is limited to 2,000 characters and total user context to 8,000. Malformed or oversized context goes to the host, without truncation. Agent claims, documents, tool output and justification cannot grant authority.
3. Inspect decoded execution facts using non-overridable action guards. Important data loss, device writes, force or production pushes, recognized secret access or exfiltration, DSH security changes and persistence delegate. Unsupported shell composition, expansion and interpreter execution also delegate. Literal echo/printf output does not become a dangerous action just because it mentions one.
4. Replay only the plugin's own low-risk model approval, after revalidation. Keys bind raw arguments, tool, session, workspace, workdir, target, genuine message revisions, policy and current classifier model. Downstream allowed-once and medium-risk grants are never cached.
5. Classify the remaining requests with one model. Low risk can approve; medium risk also needs a verifiable exact instruction from the newest genuine user. High risk, invalid replies, timeout and errors delegate. Every automatic exit rechecks context, preset and cancellation.

The host API remains `allowed-once` or `next()`. Official `auto` and other presets are left to the host; configuring `presetName: auto` fails at load time.

Developer-branch pushes have a medium-risk floor. A supported direct authorization is `Run: git push origin feature` or `请执行：git push origin feature`, matching the complete command and current scope. Broad tasks and command examples are insufficient; force and shared/production pushes always ask.

Literal output also requires model approval or a revalidated low-risk model cache entry; rules never grant permission directly. `shadowMode: true` records candidate decisions and always delegates without granting permission. No real logs establish the 20% false-handoff reduction target yet.

## Compatibility

The table describes interface support. This approval candidate has not been exercised in real Web, Desktop or TUI clients; all three rollout gates are NOT_VERIFIED.

The host-side plugin depends only on dsh's `approval/request` waterfall and the `permissionPresets` service, so it is frontend-agnostic; frontends differ only in how the human fallback is rendered and in cosmetic layers such as the icon shim.

| Frontend | Support | Notes |
| --- | --- | --- |
| **Web** (`dsh web`) | ✅ Full | Approval dialogs, the icon shim, and `/permission` switching all work |
| **Official Desktop** (DeepSeek Harness Desktop, [`apps/desktop`](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/desktop)) | ✅ Supported | The official Electron shell embeds the full Web app, so the host side is identical to Web. Install the plugin from the in-app **Plugins** page; see [Official Desktop](#official-desktop). The permission-menu icon needs 0.7.1+ |
| **TUI** ([ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)) | ✅ Supported | Routine escalations are auto-approved by the classifier; dangerous or uncertain requests enter the TUI's Claude Code-style approval panel (`allowed-once`/`rejected` only). The TUI does not wire `/permission` preset switching — set `permission.defaultPreset: sandboxed-auto` in that profile's settings to enter this plugin's preset. The icon shim is Web-DOM only and does not apply in the TUI (cosmetic) |
| **Community desktop shells** ([xiincs/deepseek-harness-desktop](https://github.com/xiincs/deepseek-harness-desktop), [bruc3van/dsh-desktop](https://github.com/bruc3van/dsh-desktop), et al.) | ✅ Supported | Native windows over the official Web UI that can reuse a running instance on `127.0.0.1:3080`, identical to Web; install as for Web |

## Install

This package ships **no runtime dependencies**: `@deepseek-ai/schemastery` is declared as a `peerDependency` and supplied by the dsh runtime. That follows Cordis's component-dependency semantics — a component does not bundle its dependencies internally but expects the runtime context to supply them — and structurally prevents a bundled copy from drifting out of step with the profile's copy and yielding two distinct Schema instances.

DeepSeek Harness must run on a supported Node.js version. The host-side plugin is pure ESM JavaScript, and the browser registration script is committed directly as a runtime file. The package has no `build`, `prepare`, or `install` script, so installing it from Git does not require pnpm build authorization.

From npm (recommended):

```bash
dsh plugin --profile web add dsh-auto-approve
```

The npm release is the fully tested one and the form listed on [DSH Directory](https://dsh.directory/plugins/jiao-xxx/dsh-auto-approve).

From GitHub (for changes that are not released yet):

```bash
dsh plugin --profile web add github:Jiao-XXX/dsh-auto-approve
```

From a local checkout:

```bash
dsh plugin --profile web add ./dsh-auto-approve
```

Restart `dsh web`, open the Permissions selector, and choose `Sandboxed Auto`.

To remove the bundle:

```bash
dsh plugin --profile web remove dsh-auto-approve
```

### Official Desktop

The official Desktop uses its own profile (`$DSH_HOME/profiles/desktop`). Installing from inside the app is recommended:

1. Open the sidebar **Plugins** page and choose to install an external bundle;
2. Enter the package name `dsh-auto-approve` (Desktop uses its bundled pnpm and installs by name from npm; no Node or pnpm is needed on the machine);
3. When the install finishes, **restart the app** as prompted (Desktop's Web form does not enable hot reload by default, so a new plugin takes effect after a restart);
4. Choose `Sandboxed Auto` in the composer's permission selector.

Compatibility: Desktop runs the host and plugins in Electron's embedded Node (Node 24 in Electron 44), which satisfies this package's `engines`. The package has no runtime dependencies, and `@deepseek-ai/schemastery` is supplied by Desktop's runtime resolution layer, so no second copy appears. Desktop's Web Host listens on port `19387` by default (Web uses `3080`); the plugin does not depend on the port.

If you installed 0.7.0, upgrade to **0.7.1**: from dsh 0.2.0 the permission menu is mounted at the top level of the page, and 0.7.0 shows no icon on the menu entry in Desktop (approvals are unaffected).

Local development: **quit Desktop** first, then run the app's bundled CLI (`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`) with `dsh plugin --profile desktop add link:<path to your checkout>`, and reopen the app. Changing the profile's dependencies while the app is running can freeze the UI.

Uninstall from the same **Plugins** page. If the plugin keeps Desktop from starting, Desktop's native recovery dialog offers to disable third-party plugins.

## Upgrading from 0.6.x

0.7.0 renames the preset id from `auto` to `sandboxed-auto`, a **breaking change**. From dsh 0.1.7 `auto` is reserved for the official Auto review: a preset named `auto` in the configured table makes the permission presets fail to load with `"auto" is reserved`.

**Before** upgrading dsh to 0.1.7 or later, in order:

1. Upgrade the plugin: `dsh plugin --profile web add dsh-auto-approve@0.7.1` (pin the version; `@latest` can resolve to an older release through pnpm's cached metadata);
2. If `$DSH_HOME/settings.yaml` sets `permission.defaultPreset: auto`, change it to `sandboxed-auto` (or `workspace-write`);
3. If a profile `cordis.patch.yml` overrides this plugin's config with `presetName: auto`, change that to `sandboxed-auto` as well;
4. Then upgrade dsh and restart.

**About old sessions**: a session whose recorded preset is `auto` fails to open on dsh 0.1.7+ while the official Auto review is off, with `cannot restore preset "auto" without its active integration`. Its data is not lost; it just cannot be opened for now. Enabling the official Auto review lets it open again, but it restores under the **official Auto (no sandbox)** semantics, so switch it to the preset you need right after opening.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `presetName` | `sandboxed-auto` | Permission preset in which the responder is active. Cannot be `auto` (reserved for the official Auto review from dsh 0.1.7). |
| `provider` | `null` | `null` = use the default model provider configured under **Settings → Models**; any API is supported. |
| `model` | `null` | `null` = use the default model id configured under **Settings → Models**; any API is supported. |
| `classifierPrompt` | Built-in default | Complete system-prompt replacement; must follow the risk/verdict/reasonCode protocol below. Cannot override local action guards. |
| `timeoutMs` | `15000` | End-to-end classification deadline in milliseconds. |
| `extraDangerPatterns` | `[]` | Additional human-handoff regexes applied to decoded commands or file targets. |
| `dangerPatterns` | `null` | null retains built-in risk hints; arrays replace only the configurable layer, preserving action invariants. This tightens the old replacement semantics. |
| `sessionMemory` | `true` | Cache only the plugin’s own low-risk model approvals; context changes, cancellation or unload invalidate them. Downstream grants are not cached. |
| `sessionMemoryTtlMs` | `1800000` | Lifetime of a memory entry (30 minutes by default); after that the call is classified again. |
| `shadowMode` | `false` | Evaluate candidates but always delegate; no automatic grant or memory writes. |

`provider` and `model` are resolved independently for every classification, which supports three common setups:

1. **Zero-config default**: leave both as `null` to follow your default model. Auto works directly whether you use DeepSeek, a custom OpenAI-compatible endpoint, or any other API.
2. **A cheaper classifier on the same API**: set only `model` to a model id offered by your API and leave `provider` as `null`.
3. **A completely different provider**: set both `provider` and `model` explicitly.

### Choosing a classifier model

Classification judges risk, concrete effects and authority; model capability and the prompt affect the result. If your default model is a large reasoning model — especially at a high reasoning effort — following it makes every approval pay that model's latency and cost, and makes `timeoutMs` far easier to hit. A timeout safely falls back to the human dialog, which looks like "the Sandboxed Auto preset is not doing anything".

How to tell: run `/auto-report` in a session. A high share of `verdict=timeout` entries under `Classifier-to-human` is this situation.

Two ways to handle it, separately or together:

- Pin a faster model on the same API for classification: keep `provider: null` and set only `model`.
- Raise `timeoutMs`.

This plugin never presets a concrete model name, because deployments connect to different APIs. Use a model id your own API offers.

Every field this plugin writes in its bundle layer equals the schema default, so an override may list only the fields you want to change; omitted fields fall back to the same defaults:

```yaml
- id: auto-approve
  config:
    model: <a fast model id from your API>
    timeoutMs: 20000
```

### Classifier protocol and migration

The default prompt has one source in index.js Config. The bundle no longer copies it; apply() fills schema defaults even after host configuration replacement. Override only the fields you need:

```yaml
- id: auto-approve
  config:
    presetName: sandboxed-auto
    model: <classifier model id from your API>
    timeoutMs: 20000
    extraDangerPatterns:
      - '\bkubectl\s+delete\b'
    shadowMode: true
```

Return one object in this field order:

```json
{"risk":"low","verdict":"approve","reasonCode":"routine"}
```

risk is low|medium|high; verdict is approve|ask. Allowed reason codes: routine, literal-display, explicit-user-authorization, destructive, credentials, external-transfer, shared-environment, security-config, untrusted-execution, persistence, uncertain. Low-risk approvals accept only routine or literal-display.

A medium approval must use explicit-user-authorization and append authorization with the newest genuine messageId and its complete text as quote. Local validation also requires the exact direct instruction for the complete command and effective workdir equal to the session workspace; other workdirs delegate. Filesystem operations use `Execute: <toolName> <raw JSON toolArguments>`. High approve, duplicate/extra fields, illegal combinations and legacy verdict-only replies all delegate.

```json
{"risk":"medium","verdict":"approve","reasonCode":"explicit-user-authorization","authorization":{"messageId":"user-1","quote":"Run: git push origin feature"}}
```

Custom classifierPrompt remains a full replacement. Preserve provenance, complete user restrictions, risk tiers and this protocol. Existing v1 prompts must migrate or requests safely hand off. An empty dangerPatterns array does not remove action invariants; invalid regexes fail at load time.

## Audit

Decisions use fixed reason codes and decisionSource (rule / model / cache / manual-handoff), for example `decision=auto-approve verdict=approve reasonCode=routine decisionSource=model`. The authoritative audit ledger remains dsh's paired `approval/asked` and `approval/decided` session events.

Enter `/auto-report` for low-risk auto, required handoff, model handoff, cache replay, missing evidence and shadow groups. Rows include reasonCode / decisionSource and an arguments hash; command, argument and justification contents are omitted. The report is isolated by session: running it in another session will not show this session's entries, and restarting dsh or reloading the plugin clears it. It is a convenient in-memory view, not a complete or durable audit log.

On the target Session page, click **Session log** or enter `/export`. Inspect the downloaded ZIP with:

```bash
unzip -p /path/to/dsh-session-*.zip session.jsonl |
  jq -c 'select(.type == "approval/asked" or .type == "approval/decided")
    | {type, seq, id: .data.id, toolName: .data.toolName,
       reason: .data.reason, outcome: .data.outcome}'
```

The two events for one approval share `data.id`. An `outcome: "allowed-once"` records a one-time grant only; rc.6 session events do not identify whether the plugin or a human granted it. Use `/auto-report` for plugin provenance during the current run and Session log for complete approval history; neither should be misrepresented as the other.

## Offline tuning from logs

Offline mock evaluation uses `npm run tune -- --evaluate`, `--evaluate --baseline`, and `--evaluate --shadow`. The immutable baseline comes from c6d4222746fef089de4e40063d05d26a4191bc66. Commands in the 140 synthetic fixtures are never executed. These are pipeline measurements with fixed mock model responses, not model accuracy or real approval burden. See [acceptance](./docs/ACCEPTANCE.md) for limits and recorded results.

The tuning script uses only the Node.js standard library to read one or more plaintext `session.jsonl` files extracted from Session log ZIPs; it never edits plugin configuration or code. Log paths are positional arguments, and `--extra-danger-pattern` is repeatable:

```bash
npm run tune -- /path/to/session-1.jsonl /path/to/session-2.jsonl
npm run tune -- \
  --extra-danger-pattern '\bkubectl\s+delete\b' \
  --extra-danger-pattern '\baws\s+s3\s+rm\b' \
  /path/to/session-1.jsonl /path/to/session-2.jsonl
```

Duplicate rules are deduplicated; an invalid regular expression reports an error and exits non-zero. With no custom rules, the critique includes the exact message `未提供自定义规则，仅执行日志统计` (“No custom rules supplied; log statistics only”). Exported rc.6 approval events cannot identify the approver behind `allowed-once`, so the script does not invent an automatic or human source. Every rule or tuning suggestion is only a candidate for human review and live validation, never a safety conclusion.

## Security considerations

### Limits of session memory

Only the plugin's own low-risk model grants enter memory; complete context and raw arguments enter the hash. Each replay revalidates the call, user restrictions and action guards. Workspace, workdir, target, user revision, model or policy changes invalidate old entries; cancellation, unload and restart clear them too. A downstream allowed-once does not identify an approver and is never learned as authority. Medium grants are not cached.

Genuine user restrictions, including earlier messages, reach the classifier intact. Agent, plugin, tool output and project documents cannot authorize actions. Literal mentions, command names, outside paths or origin alone do not establish high risk. Complex shell is conservatively delegated. Finite action guards and one model can still misclassify; zero errors in fixed offline fixtures do not prove zero real-world risk.

### What one automatic grant actually gives

A dsh sandbox escalation has no path granularity: the only target a model can request is `danger-full-access`. Every automatic grant therefore means **that one command runs unconfined by the workspace sandbox**, not that the single directory it mentioned was opened. The grant is one-shot (`allowed-once`) and does not carry to the next command, but for the duration of that command there is no workspace confinement.

### The runtime self-modification path

DSH plugin installation, runtime permission writes and recognized system persistence go directly to the host. Dependency installs may run lifecycle scripts and have a medium-risk floor; npm install is never automatically deemed safe merely by name. New objects and important existing data need distinct, concrete scope evidence.

Use workspace-write for human review on every escalation. Classification sends complete arguments, justification, workspace, workdir and genuine user context to the configured provider. Limits are 2,000 characters per genuine message, 8,000 total user characters and 32,000 argument characters. Oversized evidence and recognized secrets delegate without truncation or semantic rewriting. Secret detection is a finite heuristic, not a guarantee of finding all sensitive data; choose a provider consistent with your data-handling requirements.

The plugin report and decision logs retain metadata only. Native Session log is host-owned and may still contain original arguments and reasons; redact it before sharing.

Rollback starts by enabling shadowMode and disabling sessionMemory. Switch to workspace-write or disable the plugin for native human approval. Reproduction commands, offline metrics and unverified client rollout gates are in the [acceptance guide](./docs/ACCEPTANCE.md).

## Known limitations

The Permissions selector in DeepSeek Harness does not expose an API for custom preset icons. The plugin therefore uses a best-effort browser compatibility layer to recognize the `Sandboxed Auto` trigger and menu item and add the icon. The layer depends on the host's DOM structure and accessible copy: the menu must show `Sandboxed Auto` alongside at least two built-in preset labels (English `Read Only` / `Workspace Write` / `Full access`, or the Chinese labels shipped from 0.1.2 on). From dsh 0.2.0 the menu is mounted under `<body>` instead of next to its trigger; from 0.7.1 the layer recognizes that structure too, checking direct `<body>` menus only while a permission trigger is on the page. If dsh changes that copy or structure again the icon may disappear — a cosmetic failure only, with no effect on automatic approvals, danger rules, or the human fallback.

### Host version compatibility

The plugin supports the session APIs from both before and after dsh 0.1.2, selecting the call form by runtime feature detection, while unverifiable required tool parameters safely delegate:

| Interface | Before 0.1.2 | From 0.1.2 |
| --- | --- | --- |
| Reading session events | `session.events` | `session.snapshotEvents()` |
| Resolving the current preset | `permissionPresets.current(events)` | `permissionPresets.current(session)` |

From dsh **0.1.7** there is one more incompatibility that feature detection cannot absorb: `auto` becomes the reserved preset name of the official Auto review. From 0.7.0 this plugin uses `sandboxed-auto`, preserving both session APIs while unverifiable escalation shapes delegate; 0.6.x and earlier cannot be used with dsh 0.1.7+ — see [Upgrading from 0.6.x](#upgrading-from-06x).

To insert `sandboxed-auto`, this bundle restates the complete permission preset table rather than appending one entry. If a future `dsh-base` release adds, renames, or changes presets, an installed release will not inherit those changes automatically. Recheck and update the patch whenever dsh is upgraded; see the [acceptance guide](./docs/ACCEPTANCE.md).

## FAQ

**Why is there no card for this plugin on the plugin-settings "configuration" page?**
That page only renders namespaces on the host api-proxy whitelist (currently `bash`, `agent-loop`, and `web-search-deepseek`). The upstream docs state that plugins distributed outside the DeepSeek Harness repository cannot surface configuration cards there without host changes. This limitation applies to every third-party plugin, not just this one. Configure the plugin through the patch mechanism below instead.

**Where is it on the plugin inventory page?**
The inventory tab lists every Loader-tree plugin row; search for `dsh-auto-approve` or the entry id `auto-approve`. The snapshot is read once when Settings opens, so reopen Settings after installing. The page is a deliberately read-only view with no enable/disable controls.

**How do I pause auto-approval temporarily?**
Switch the session's permission preset back to `Workspace Write`. The plugin is completely inert outside the `sandboxed-auto` preset — no restart needed; this is the built-in switch.

**How do I disable it entirely?**
Append the following to your profile's user patch layer at `$DSH_HOME/profiles/web/cordis.patch.yml` (default `~/.dsh/profiles/web/`) and restart `dsh web`, or uninstall with `dsh plugin --profile web remove dsh-auto-approve`:

```yaml
- id: auto-approve
  disabled: true
```

**How do I change the classifier model or other settings?**
The classifier follows Settings → Models. Override only the required fields, then restart the host:

```yaml
- id: auto-approve
  config:
    presetName: sandboxed-auto
    provider: null
    model: <classifier model id from your API>
```

**Why does an ordinary push still prompt?**
Developer-branch pushes have a medium-risk floor and require the newest genuine user to authorize the complete command directly, for example Run: git push origin feature. Shared or production-like branches such as `main`, `master`, `release`, `production`, and `prod` should still go to a human; force-pushes hit the danger list directly. Any classifier uncertainty also goes to a human.

**Why is `/auto-report` empty or shorter than Session log?**
It shows plugin decisions only for the current session during the current dsh process. Another session cannot see those rows, and restarting dsh or reloading the plugin clears them; use Session log for complete history. That durable log cannot distinguish an automatic from a human `allowed-once`, so the tuning script does not guess the approver either.

**How do I tune danger rules from audit logs?**
Extract one or more plaintext `session.jsonl` files from Session log ZIPs, then run `npm run tune -- [--extra-danger-pattern '...'] session-1.jsonl session-2.jsonl`. The option is repeatable, duplicates are removed, and invalid regular expressions fail with a non-zero exit. Treat every output suggestion as a candidate for human review and live acceptance testing.

## Development

The test suite uses only Node's built-in test runner:

```bash
npm test
```

The offline tuning script also has no third-party dependencies. Positional arguments are extracted log paths, and the pattern option is repeatable:

```bash
npm run tune -- [--extra-danger-pattern '...'] /path/to/session.jsonl [...]
```

Before release and after every DeepSeek Harness upgrade, complete the static, unit, and live checks in the [acceptance guide](./docs/ACCEPTANCE.md).
