<p align="center">
  <img src="./assets/icon.svg" width="96" alt="dsh-auto-approve shield and lightning icon">
</p>

<h1 align="center">dsh-auto-approve</h1>

<p align="center">
  <strong>比 Workspace Write 更省心，比 Full access 更安全 / More convenient than Workspace Write, safer than Full access</strong>
</p>

<p align="center">
  <a href="https://github.com/Jiao-XXX/dsh-auto-approve/actions/workflows/test.yml"><img src="https://github.com/Jiao-XXX/dsh-auto-approve/actions/workflows/test.yml/badge.svg" alt="test status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT"></a>
  <a href="https://dsh.directory/plugins/jiao-xxx/dsh-auto-approve"><img src="https://dsh.directory/badges/listed.svg" alt="Listed on DSH Directory"></a>
</p>

中文 | [English](README_EN.md)

`dsh-auto-approve` 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 增加 **Sandboxed Auto**（档位 id `sandboxed-auto`）权限档。在该档位下，**默认使用 `workspace-write` 沙箱**，分类模型可以对例行的沙箱升级做一次性批准；获批的单次 `bash/write/edit` 升级可以不受该次沙箱限制。命中确定性危险规则、模型拿不准、超时、响应格式错误或插件内部异常时，审批仍会交给正常的人工弹窗。

该 bundle 会把权限预设表重述为四个档位，顺序为 `read-only`、`workspace-write`、`sandboxed-auto`、`danger-full-access`——即在 dsh 原生三档中间插入本插件的档位，原有档位全部保留。不在 `sandboxed-auto` 档时，插件会原样放行所有审批请求给后续应答者。

> **从 0.6.x 升级？** 0.7.0 起档位 id 由 `auto` 改为 `sandboxed-auto`：dsh 0.1.7 起 `auto` 被官方实验性的 Auto review 占用为保留名，继续使用会导致权限预设加载失败。请先阅读[从 0.6.x 升级](#从-06x-升级)。

## 定位

Sandboxed Auto 使用 `workspace-write` 作为默认沙箱，把例行升级交给分类器；命中危险清单、分类器拿不准或分类失败时，回到人工审批。

分类器只决定是否放行**一次**升级。被批准的 `bash/write/edit` 调用可在本次执行中绕过工作区沙箱；文件工具也可申请升级。`allowed-once` 不是路径级权限，不会授予未来调用；后续调用仍须按当时的上下文独立决策。审批记录保留在 dsh 原生的会话审计事件里。

DSH 沙箱主要限制文件修改，不提供通用网络隔离。启用前还须核对宿主控制面的隔离，见[验收门槛](./docs/ACCEPTANCE.md)。

直观地说，它类似 [Claude Code 的 **auto mode**](https://code.claude.com/docs/en/permission-modes) 与 [Codex 的 **Auto-review mode**](https://developers.openai.com/codex/agent-approvals-security)：把例行审批交给安全评审，危险或拿不准时再交还人工。

| 权限档 | 沙箱范围 | 什么时候弹窗 | 适合场景 |
| --- | --- | --- | --- |
| `read-only` | 默认只读，不能修改项目文件 | 需要写入或进行其他沙箱升级时 | 代码审阅、探索和敏感仓库 |
| `workspace-write` | 默认允许工作区内修改，工作区外写入需升级 | 需要写工作区外或进行其他沙箱升级时 | 常规开发；每次升级都由人确认 |
| **`sandboxed-auto`** | **默认与 `workspace-write` 相同；获批调用可单次绕过沙箱** | **例行升级自动批；命中删库级危险清单、分类器拿不准或失败时才问人** | **长任务和依赖安装；减少打断且全程保留审计台账** |
| `danger-full-access` | 不受工作区沙箱限制，按宿主权限运行 | 不弹窗（`approval: never`） | 仅限隔离、可丢弃且充分信任的环境 |

## 与官方 Auto review 的区别

dsh 0.1.7 起随安装附带一个**实验性**的官方权限档 **Auto review**（包 `@deepseek-ai/dsh-experimental-auto-review`，档位 id `auto`，默认关闭，在侧栏「插件」页开启）。它与本插件名字相近，但走的是相反的路线：

| | 官方 Auto review | Sandboxed Auto（本插件） |
| --- | --- | --- |
| 沙箱 | **无沙箱**（Full access） | **默认** workspace-write；获批调用可单次绕过 |
| 审查范围 | 每一次工具调用 | 仅本插件预设的沙箱升级审批请求；占比未测 |
| 审查模型 | 当前 agent 的模型，不可更换 | 可配置，可换更便宜的模型 |
| 确定性兜底 | 无 | 危险清单先于分类器执行且不可推翻 |
| 可配置项 | 无 | 提示词、超时、危险规则、会话记忆 |
| 审查失败时 | 调用失败，不执行 | 转人工审批 |
| 可用形态 | 需开启 Web 层；Headless 不可用；不能设为新会话默认档 | Web / TUI / Desktop / Headless，可设为默认档 |
| 审计 | 风险分级、推理与原始响应不持久化 | 原生 `approval/asked` + `approval/decided` 审计对，`/auto-report` 会话台账 |

官方方案也有本插件做不到的地方：它连**工作区内**的操作也逐条审查，而本插件对沙箱内的操作（例如在项目里删除文件）完全不介入，因为沙箱已经放行；它的审查输入有分区设计并刻意排除工具结果以防注入，还按低/中/高三级风险区分授权要求；它由上游维护，会跟随 dsh 的接口演进。

**怎么选**：想要最大自主、能接受无沙箱和逐调用的 token 成本，用官方 Auto review；想默认使用 `workspace-write`、由模型处理单次升级请求，用 Sandboxed Auto。两者档位 id 不同，可以同时安装并在选择器里分别选择——本插件只在 `sandboxed-auto` 档下工作，选中官方 `auto` 时会原样交给宿主处理所有审批请求，不会替官方审查员回答本应交给你的询问。

## 工作原理

只处理本插件预设的 `approval/request`，按以下顺序决策：

1. 校验取消信号、会话工作区和唯一的 `tool/call`；工具名、必要参数、`sandbox_permissions` 与原生审批理由必须一致。支持已核对的 `bash`、`write`、`edit` 参数形状；缺失、歧义、未知工具或不一致直接交给宿主。
2. 完整保留带真实用户来源的消息及限制。最新消息超过 2000 字符、整个用户上下文超过 8000 字符或内容无法可靠读取时转人工。项目文档、Agent 自述、工具输出和 justification 不能授予权限。
3. 根据解码后的执行参数检查不可覆盖的行动保护。破坏重要数据、设备写入、强推或生产分支推送、已识别的秘密访问与外传、DSH 安全配置写入和持久化操作转人工。有限词法检查无法确认的 shell 组合、展开和解释器执行也转人工；纯 `echo` / `printf` 字符串展示不会因为出现危险词而触发内置行动保护。
4. 在重新通过保护后，仅复用本插件自己的低风险模型批准。缓存绑定完整原始参数、工具、会话、工作区、工作目录、权限目标、真实用户消息修订、策略和当前分类模型。下游 `allowed-once` 不进入缓存，中风险批准也不缓存。
5. 其余请求交给单个分类模型。低风险可自动批；中风险还需精确的最新真人授权与可验证的引用；高风险、格式错误、超时或异常转人工。每个自动批准出口再次校验上下文、档位和取消状态。

自动批准仍只返回原生 `allowed-once`，人工入口仍是 `next()`。官方 `auto` 与其他预设不受本插件处理；`presetName: auto` 配置会在加载时报错。

普通工作分支推送至少按中风险审查。可验证的直接授权形如 `Run: git push origin feature` 或 `请执行：git push origin feature`，需与完整命令及当前范围一致；宽泛任务和命令示例不够。强推、共享/生产分支仍交人工。

字面输出也必须经过模型审批或重验证的低风险模型缓存，没有规则直接授权的出口。`shadowMode: true` 会记录候选结果并始终交给宿主，不自行授予权限。尚无真实日志证明误拦下降 20% 的目标已达成。

## 适用性矩阵

下表说明接口适配范围；本次审批改造尚未在真实 Web、Desktop、TUI 上验收，状态均为 `NOT_VERIFIED`，不能据此推断本候选版本已通过。

插件宿主侧只依赖 dsh 的 `approval/request` 瀑布流与 `permissionPresets` 服务，与前端形态无关；不同前端只在「人工兜底如何呈现」和图标等视觉层上有差异。

| 前端 | 支持 | 说明 |
| --- | --- | --- |
| **Web**（`dsh web`） | ✅ 完整支持 | 审批对话框、图标兼容层、`/permission` 切换全部可用 |
| **官方桌面端**（DeepSeek Harness Desktop，[`apps/desktop`](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/desktop)） | ✅ 支持 | 官方 Electron 壳内嵌完整 Web 应用，宿主侧与 Web 完全相同。插件需在应用内「插件」页安装，见[官方桌面端](#官方桌面端)。权限菜单里的图标需 0.7.1+ |
| **TUI**（[ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)） | ✅ 支持 | 例行升级由分类器自动批；危险/拿不准时进入 TUI 的 Claude Code 风格审批面板（仅 `allowed-once` / `rejected`）。注意：TUI 未接入 `/permission` 预设切换，需在该 profile 的 settings 中设置 `permission.defaultPreset: sandboxed-auto` 才能进入本插件的档位；图标兼容层为 Web DOM 专属，TUI 中不生效（纯视觉） |
| **社区桌面壳**（[xiincs/deepseek-harness-desktop](https://github.com/xiincs/deepseek-harness-desktop)、[bruc3van/dsh-desktop](https://github.com/bruc3van/dsh-desktop) 等） | ✅ 支持 | 包裹官方 Web UI 的原生窗口，可复用本机 `127.0.0.1:3080` 实例，与 Web 体验一致；按 Web 的方式安装 |

## 安装

DeepSeek Harness 需要运行在受支持的 Node.js 版本上。宿主侧插件为纯 ESM JavaScript，浏览器注册脚本也作为运行时文件随仓库直接提交。本包没有 `build`、`prepare` 或 `install` 脚本，因此从 Git 安装时不需要授权 pnpm 执行构建。

本包**不携带任何运行时依赖**：`@deepseek-ai/schemastery` 声明为 `peerDependency`，由 dsh 运行时供给。这遵循 Cordis 的组件依赖语义——组件不内捆依赖，而是期待运行时上下文提供——从机制上杜绝插件自带副本与 profile 版本漂移后出现两份 Schema 实例的问题。

从 npm 安装（推荐）：

```bash
dsh plugin --profile web add dsh-auto-approve
```

npm 上的版本经过发布前的完整测试，也是 [DSH Directory](https://dsh.directory/plugins/jiao-xxx/dsh-auto-approve) 收录的形式。

从 GitHub 安装（获取尚未发布的改动）：

```bash
dsh plugin --profile web add github:Jiao-XXX/dsh-auto-approve
```

从本地 checkout 安装：

```bash
dsh plugin --profile web add ./dsh-auto-approve
```

重启 `dsh web`，然后在 Permissions 下拉框中选择 `Sandboxed Auto`。

卸载：

```bash
dsh plugin --profile web remove dsh-auto-approve
```

### 官方桌面端

官方桌面端使用自己的 profile（`$DSH_HOME/profiles/desktop`），推荐在应用内安装：

1. 打开侧栏的「**插件**」页，选择安装外部组合包；
2. 输入包名 `dsh-auto-approve`（桌面端使用内置 pnpm，按包名从 npm 安装，无需本机装有 Node 或 pnpm）；
3. 安装完成后按提示**重启应用**（桌面端 Web 形态默认未开启热重载，新插件在重启后生效）；
4. 在输入框的权限选择器中选择 `Sandboxed Auto`。

兼容性说明：桌面端在 Electron 内置的 Node（Electron 44 为 Node 24）中运行宿主与插件，满足本包的 `engines` 要求；本包零运行时依赖，`@deepseek-ai/schemastery` 由桌面端运行时解析层提供，不会出现第二份副本。桌面端 Web Host 默认监听 `19387` 端口（Web 为 `3080`），本插件不依赖端口。

已装 0.7.0 的用户请升级到 **0.7.1**：dsh 0.2.0 起权限菜单改为挂在页面最外层，0.7.0 在桌面端的菜单项上不显示图标（审批功能不受影响）。

本地开发调试：先**退出桌面端**，再用应用自带的 CLI（`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`）执行 `dsh plugin --profile desktop add link:<本地仓库路径>`，然后重新打开应用。应用运行时改动 profile 依赖可能导致界面卡死。

卸载同样在「插件」页操作。若插件导致桌面端启动失败，桌面端的原生恢复对话框提供「禁用第三方插件」选项。

## 从 0.6.x 升级

0.7.0 把档位 id 从 `auto` 改为 `sandboxed-auto`，这是一次**破坏性变更**。原因是 dsh 0.1.7 起把 `auto` 保留给官方 Auto review：配置表里出现名为 `auto` 的档位会让权限预设在加载时报错 `"auto" is reserved`。

升级 dsh 到 0.1.7 或更高版本**之前**，按顺序完成：

1. 升级插件：`dsh plugin --profile web add dsh-auto-approve@0.7.1`（请写明版本号，`@latest` 可能被 pnpm 缓存的元数据解析到旧版）；
2. 若 `$DSH_HOME/settings.yaml` 里设置了 `permission.defaultPreset: auto`，改为 `sandboxed-auto`（或 `workspace-write`）；
3. 若在 profile 的 `cordis.patch.yml` 里覆盖过本插件配置并写了 `presetName: auto`，同样改为 `sandboxed-auto`；
4. 再升级 dsh 并重启。

**关于旧会话**：档位记录为 `auto` 的旧会话，在 dsh 0.1.7+ 上且未开启官方 Auto review 时，打开会报错 `cannot restore preset "auto" without its active integration`。会话数据不会丢失，只是暂时无法打开。开启官方 Auto review 能让它们重新打开，但会以**官方 Auto（无沙箱）**的语义恢复，打开后请立即切回你需要的档位。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `presetName` | `sandboxed-auto` | 插件应答者生效的权限档名。不能设为 `auto`（dsh 0.1.7 起为官方 Auto review 保留）。 |
| `provider` | `null` | `null` = 使用 **Settings → Models** 中配置的默认模型 provider，任何 API 均适用。 |
| `model` | `null` | `null` = 使用 **Settings → Models** 中配置的默认模型 id，任何 API 均适用。 |
| `classifierPrompt` | 内置默认提示 | 完整替换分类 system prompt；必须遵守下述 risk/verdict/reasonCode 协议。不可覆盖本地行动保护。 |
| `timeoutMs` | `15000` | 分类调用的端到端超时，单位毫秒。 |
| `extraDangerPatterns` | `[]` | 对解码后的命令或文件目标追加人工接管正则。 |
| `dangerPatterns` | `null` | `null` 保留内置风险提示；数组仅替换可配置层，不移除不可覆盖的行动保护。这是对旧替换语义的安全迁移。 |
| `sessionMemory` | `true` | 只缓存本插件已确认的低风险模型批准；上下文变化、取消或卸载后失效。下游批准不缓存。 |
| `sessionMemoryTtlMs` | `1800000` | 记忆条目的有效期（默认 30 分钟），过期后重新分类。 |
| `shadowMode` | `false` | 仅评估和记录候选，所有请求仍交宿主审批，不自动授权或缓存。 |

`provider` 与 `model` 会在每次分类时独立解析，因此有三种常见用法：

1. **默认零配置**：两者保持 `null`，自动跟随你的默认模型；无论接入 DeepSeek、自定义 OpenAI 兼容端点还是其他 API，都可以直接使用 Sandboxed Auto 档。
2. **同一 API 下换用更便宜的分类模型**：只把 `model` 设为你自己 API 中的模型名，`provider` 保持 `null`。
3. **指定完全不同的 provider**：同时显式配置 `provider` 与 `model`。

### 分类模型选型建议

分类要判断风险、具体副作用和授权范围，模型能力及提示词会影响结果。如果你的默认模型是大型推理模型（尤其开启了较高的 reasoning effort），跟随默认模型会让每次审批都付出该模型的延迟与成本，也更容易撞上 `timeoutMs`——超时会安全回退到人工弹窗，表现出来就是"Sandboxed Auto 档好像没生效"。

判断方法：在会话里运行 `/auto-report`，如果 `分类器转人工` 分组里 `verdict=timeout` 占比偏高，就是这种情况。

两种处理方式，可任选其一或同时使用：

- 指定一个同 API 下更快的模型做分类：保持 `provider: null`，只设置 `model`；
- 调高 `timeoutMs`。

本插件不预设任何具体模型名，因为各部署接入的 API 不同；请填写你自己 API 中可用的模型 id。

本插件在 bundle 层写入的每个字段取值都与 schema 默认值相同，因此覆盖时只写想改的字段即可，未列出的字段会回落到相同的默认值：

```yaml
- id: auto-approve
  config:
    model: <你 API 中的快速模型 id>
    timeoutMs: 20000
```

### 分类协议与配置迁移

默认提示统一保存在 `index.js` 的 Config 中；bundle 不再复制提示，`apply()` 会在宿主配置替换后补齐缺省字段，因此只需写需要修改的配置。

```yaml
- id: auto-approve
  config:
    presetName: sandboxed-auto
    model: <你 API 中的分类模型 id>
    timeoutMs: 20000
    extraDangerPatterns:
      - '\bkubectl\s+delete\b'
    shadowMode: true
```

模型必须按顺序输出一个对象：

```json
{"risk":"low","verdict":"approve","reasonCode":"routine"}
```

`risk` 只能为 `low|medium|high`，`verdict` 只能为 `approve|ask`。原因码为 `routine`、`literal-display`、`explicit-user-authorization`、`destructive`、`credentials`、`external-transfer`、`shared-environment`、`security-config`、`untrusted-execution`、`persistence`、`uncertain` 之一。低风险批准只接受前两种原因码。

中风险批准必须使用 `explicit-user-authorization` 并追加 `authorization`，其 `messageId` 指向最新真人消息，`quote` 等于该消息的完整文本；本地还要求直接授权与当前完整命令一致，并且实际工作目录等于会话工作区；其他工作目录交人工。文件工具的精确形式是 `Execute: <toolName> <原始 JSON 参数>`。高风险批准、重复/额外字段、非法组合和旧版只含 verdict 的回复都会转人工。

```json
{"risk":"medium","verdict":"approve","reasonCode":"explicit-user-authorization","authorization":{"messageId":"user-1","quote":"Run: git push origin feature"}}
```

自定义 `classifierPrompt` 仍是完整替换项，需保留来源隔离、完整用户限制、风险分级和此协议。已有 v1 自定义提示需迁移，否则请求会安全转人工。`dangerPatterns: []` 也不能移除行动保护。无效正则在加载时报错。

## 审计

插件决策日志只记录固定原因码和来源，例如 `decision=auto-approve verdict=approve reasonCode=routine decisionSource=model`，不摘录命令、参数或 justification。权威审计台账仍由 dsh 内置、成对出现的 `approval/asked` 与 `approval/decided` 会话事件承担。

在当前会话输入 `/auto-report`，可查看低风险自动批准、必需人工、模型转人工、缓存重放、缺少证据及影子评估六组记录。报告包含 `reasonCode` / `decisionSource`，命令和参数只保留摘要哈希，原文及理由不摘录。报告按 session 隔离：在另一个会话运行不会看到本会话的条目；重启 dsh 或重新加载插件会清空它。它只是便捷的内存视图，不是完整、持久的审计日志。

在目标 Session 页面点击 **Session log**，或输入 `/export`。可用下面的命令查看下载 ZIP 中的审批事件：

```bash
unzip -p /path/to/dsh-session-*.zip session.jsonl |
  jq -c 'select(.type == "approval/asked" or .type == "approval/decided")
    | {type, seq, id: .data.id, toolName: .data.toolName,
       reason: .data.reason, outcome: .data.outcome}'
```

同一次审批的两条事件具有相同的 `data.id`。`outcome: "allowed-once"` 只表示一次性放行；rc.6 的会话事件本身不能区分它来自插件自动批准还是人工批准。需要插件当次运行中的来源视图时使用 `/auto-report`，需要完整审批历史时使用 Session log；不要把前者当作后者的替代品。

### 从日志离线调优

合成审批管线回放：`npm run tune -- --evaluate`、`--evaluate --baseline`、`--evaluate --shadow`。基线固定为 `c6d4222746fef089de4e40063d05d26a4191bc66`；140 条样本中的命令从不执行，模型回复均为固定 mock。结果不代表模型准确率或真实人工负担，记录与限制见[验收说明](./docs/ACCEPTANCE.md)。

调优脚本只用 Node.js 标准库读取一个或多个从 Session log ZIP 解压出的纯文本 `session.jsonl`，不会修改插件配置或代码。日志路径使用位置参数；`--extra-danger-pattern` 可以重复：

```bash
npm run tune -- /path/to/session-1.jsonl /path/to/session-2.jsonl
npm run tune -- \
  --extra-danger-pattern '\bkubectl\s+delete\b' \
  --extra-danger-pattern '\baws\s+s3\s+rm\b' \
  /path/to/session-1.jsonl /path/to/session-2.jsonl
```

重复规则会去重，无效正则会报错并以非零状态退出。未提供自定义规则时，critique 会原样显示“`未提供自定义规则，仅执行日志统计`”。导出的 rc.6 审批事件不能识别 `allowed-once` 的批准者，因此脚本不会把它擅自标成自动或人工；所有规则或调优建议都只是待人工审阅和真机验证的候选，不能直接当作安全结论。

## 安全说明

### 会话内命令记忆的边界

只记忆本插件的低风险模型批准，完整上下文与原始参数都进入哈希。每次重放先重新校验调用、用户消息及行动保护；当前工作区、工作目录、权限目标、用户消息、模型或策略变化会使旧记忆失效。取消、卸载和重启也清空记忆。下游的 `allowed-once` 无法证明批准者身份，永不学习为授权；中风险批准不缓存。

最新真人消息及更早的真实限制完整传给分类模型；Agent、插件、工具结果和项目文档不属于授权来源。字面输出、命令名、外部路径或 `origin` 单独出现不会被当成高风险动作。复杂 shell 会保守转人工，有限行动保护与单模型分类仍可能误判；离线固定语料的零误批不能证明现实中零风险。

### 一次自动批准实际授予了什么

dsh 的沙箱升级没有路径粒度：模型能申请的目标只有 `danger-full-access`。获批的单次 `bash/write/edit` 升级调用可以不受该次工作区沙箱限制，按宿主权限执行。`allowed-once` 不是路径级权限，不会授予未来调用；后续调用仍须重新核对当前授权上下文，包括缓存命中时。

### 运行时自我修改这条路径

DSH 的插件安装、运行时权限配置写入及已识别的系统持久化操作直接转人工。依赖安装可能执行生命周期脚本，至少按中风险处理；不会仅因 `npm install` 命令名而无条件放行。新建对象与已有重要数据的影响范围仍需具体证据。

需要每次人工确认时使用 `workspace-write`。分类请求会向已配置的 provider 发送完整执行参数、理由、工作区、工作目录及真实用户上下文；每条真人消息上限 2000 字符，用户上下文总上限 8000 字符，参数上限 32000 字符。超限或检测到已知秘密形态时直接转人工，不截断、改写后猜测。秘密检测是有限启发式，不保证识别所有敏感数据；请按 provider 的数据处理约束选择模型。

`/auto-report` 和插件决策日志仅保留必要元数据。原生 Session log 由宿主保存，可能仍含原始工具参数和理由，分享前需自行脱敏。

回滚先开启 `shadowMode` 并关闭 `sessionMemory`；切换到 `workspace-write` 或禁用插件可恢复原生人工审批。复现命令、离线指标和未验证的客户端灰度项见[验收说明](./docs/ACCEPTANCE.md)。

## 已知限制

DeepSeek Harness 的 Permissions 选择器尚未提供自定义预设图标 API。本插件因此通过浏览器侧的 best-effort 兼容层识别 `Sandboxed Auto` 触发器和菜单项，再补上图标。该兼容层依赖宿主的 DOM 结构与无障碍文案：菜单需同时出现 `Sandboxed Auto` 与至少两个内置档位标签（英文 `Read Only` / `Workspace Write` / `Full access`，或 0.1.2 起的中文「仅可查看」「工作区内修改」「完全权限」）。dsh 0.2.0 起该菜单被挂到 `<body>` 下、不再与触发器相邻，0.7.1 起兼容层同时识别这种结构（仅在页面上存在权限触发器时才检查 `<body>` 的直接子菜单）。dsh 再次改动这些文案或结构后，图标可能消失——这种失效只影响图标显示，不影响自动审批、危险规则或人工兜底。

### 宿主版本兼容

插件同时兼容 dsh 0.1.2 之前与之后的会话接口，按运行时特性探测选择调用方式，无需按 dsh 版本安装不同版本：

| 接口 | 0.1.2 之前 | 0.1.2 起 |
| --- | --- | --- |
| 读会话事件 | `session.events` | `session.snapshotEvents()` |
| 解析当前权限档 | `permissionPresets.current(events)` | `permissionPresets.current(session)` |

dsh **0.1.7** 起还有一处不兼容无法靠特性探测化解：`auto` 成为官方 Auto review 的保留档位名。0.7.0 起本插件改用 `sandboxed-auto`，保留两代会话 API 的兼容路径，无法验证必要工具参数的请求交人工；0.6.x 及更早版本不能用于 dsh 0.1.7+，升级步骤见[从 0.6.x 升级](#从-06x-升级)。

本 bundle 为插入 `sandboxed-auto` 会整体重述权限预设表，而不是增量追加。未来 `dsh-base` 若新增、重命名或调整权限档，已安装版本不会自动继承这些变化；升级 dsh 时应重新核对并更新 patch，具体步骤见[验收文档](./docs/ACCEPTANCE.md)。

## FAQ

**为什么插件设置的"插件配置"页里没有本插件的卡片？**
那个页面只显示 host 端 api-proxy 白名单里的官方命名空间（目前是 `bash`、`agent-loop`、`web-search-deepseek`）。上游文档明确说明：仓库外分发的第三方插件在不改动 host 代码的情况下无法在此页出现配置卡片。这是 DeepSeek Harness 当前版本对所有第三方插件的共同限制，不是本插件的缺陷。配置请用下文的 patch 方式。

**"插件列表"页里怎么找到它？**
列表页展示 Loader 树的全部插件行，搜 `dsh-auto-approve` 或条目 id `auto-approve` 即可。注意该页快照只在打开 Settings 时读取一次，装完插件后要关掉 Settings 重新打开；该页是官方设计的只读视图，没有启停按钮。

**怎么临时关掉自动批准？**
把会话权限档切回 `Workspace Write` 即可——插件对 `sandboxed-auto` 之外的档位完全隐形，无需重启，这就是内置的开关。

**怎么彻底停用？**
在 profile 的用户层补丁 `$DSH_HOME/profiles/web/cordis.patch.yml`（默认 `~/.dsh/profiles/web/`）中追加以下内容并重启 `dsh web`；或直接 `dsh plugin --profile web remove dsh-auto-approve` 卸载：

```yaml
- id: auto-approve
  disabled: true
```

**怎么修改分类模型等配置？**
分类模型默认跟随 Settings → Models。需要单独配置时只覆盖所需字段，再重启宿主：

```yaml
- id: auto-approve
  config:
    presetName: sandboxed-auto
    provider: null
    model: <你 API 中的分类模型 id>
```

**为什么普通 push 仍然弹窗？**
工作分支推送至少按中风险处理，最新真人消息须直接授权当前完整命令；例如 `Run: git push origin feature`。`main`、`master`、`release`、`production`、`prod` 等共享/生产类分支仍应转人工；force push 会直接命中危险清单。模型只要拿不准也会转人工。

**`/auto-report` 为什么是空的或少于 Session log？**
它只展示当前 dsh 进程内、当前 session 的插件裁决。切到另一个 session 不会串数据，重启 dsh 或重新加载插件会清空内存记录；完整历史请看 Session log。后者的 `allowed-once` 又不能区分自动与人工批准，所以调优脚本也不会猜测批准者。

**如何根据审计日志调优危险规则？**
先从 Session log ZIP 解压一个或多个纯文本 `session.jsonl`，再运行 `npm run tune -- [--extra-danger-pattern '...'] session-1.jsonl session-2.jsonl`。该选项可重复，重复项会去重，无效正则会失败退出；输出中的任何建议都只是需要人工复核和真机验收的候选。

## 开发

测试只使用 Node 内置测试运行器：

```bash
npm test
```

离线调优脚本同样零第三方依赖；位置参数是已解压的日志路径，规则选项可重复：

```bash
npm run tune -- [--extra-danger-pattern '...'] /path/to/session.jsonl [...]
```

发布前以及每次升级 DeepSeek Harness 后，请按[验收文档](./docs/ACCEPTANCE.md)完成静态、单元与真机检查。

