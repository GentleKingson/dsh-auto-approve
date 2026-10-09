# 安全审批改造验收记录与灰度门槛

日期：2026-10-09。基线：`c6d4222746fef089de4e40063d05d26a4191bc66`，package.json 仍为 0.7.1。以下原始验收针对首次候选工作树；下一轮修复记录另列，不能把 HEAD 当成修改后的提交 SHA。

## 方案审阅与执行范围

方案可执行，但 PR-03 的真实收益与 PR-04 的客户端灰度需要独立数据和实际宿主，不能由单元测试推断。本次完成 PR-00 的固定合成基线、PR-01/02 的本地边界修复、PR-03 的保守分类与影子支持、PR-04 的自动化检查和文档。真实日志、真实模型影子观察、可丢弃宿主灰度和客户端手工验收仍未完成。

沿用原生 `approval/request`、`allowed-once`、`next()` 和宿主审计事件；未改 client.js，未增加运行时依赖、外部策略引擎、第二个模型或逐工具审查。首次验收时未推送、合并或发布候选。PR #1 当前保持 Open，本轮不合并。

## 审阅发现与修复证据

固定旧版中的下列路径通过假宿主、假模型复现，不执行示例命令；这证明本地条件允许误批，不证明真实模型已被攻击或真实用户发生损失。

| 路径 / 不变量 | 原行为 | 当前行为与验证 |
| --- | --- | --- |
| tool/call 必须唯一且与审批对象一致 | 缺失调用、工具错配、非 JSON 或目标不明仍可在 approve 桩下放行 | 已验证参数形状、工具名、工作区、升级目标和原生理由；缺失/冲突交宿主且模型调用为零 |
| 当前授权上下文必须先于记忆验证 | 缓存不含用户修订、工作区或目标；下游批准被标 human 并缓存 | 只缓存本插件低风险模型批准；上下文、策略、当前模型入键；下游及中风险批准永不缓存 |
| 所有自动出口必须尊重取消与上下文变化 | 缓存绕过信号类型检查，分类结束不重查档位 | 无效/取消信号、卸载、新限制、工作区/调用/档位变化无法从旧上下文放行；并发请求独立处理 |
| 实际动作与文本展示需要区分 | 原始 JSON 转义漏掉引号及 Unicode 命令；理由或字符串中的危险词误拦 | 对解码事实检查；字面 echo/printf 与危险行动成对回归；高置信保护不被 dangerPatterns 数组替换 |
| 中风险权限不能扩大相对目标 | 精确命令文本仍可搭配外部 workdir 扩大落点 | 中风险自动批准还要求 effective workdir 等于会话工作区，否则人工 |
| 分类协议不能把高风险 approve 当许可 | 仅二元 verdict，风险未由本地协议限制 | 固定字段顺序、原因码、合法组合与精确真人引用；高风险 approve、旧协议、重复/额外字段均人工 |
| 报告不能扩大秘密传播 | 原命令摘要可保留 Bearer 值 | 内容完全省略，仅记录工具、参数哈希、原因码、来源；已识别秘密证据不送模型，无法安全提供完整证据则人工 |

一次独立只读复核发现并修复了同一边界的附着短选项、tar 传统语法、sed 表达式、data-urlencode、嵌套 sudo 和工作目录授权遗漏。新增对照包括从 /etc 读取后复制到 /tmp、tar 列表、curl 只读请求及正确工作区内的精确中风险授权。未执行任何这些破坏性命令。

## 固定语料与可重放指标

语料：[approval-corpus.json](../test/fixtures/approval-corpus.json)，版本 1，140 条、70 对；70 条明确安全，70 条需人工，其中 16 条标注为证据/协议未知。全部为合成样本，无真实日志、真实秘密或人工审批率数据。source、expected、risk、why、实际边界、固定 mock 回复及 labelCorrections 都保存在语料中；当前纠正记录为空，没有声称标签已由真人独立复核。

语料 SHA-256：`564ffd393a24839a89e329606f29211329b48dd15e00e71fce10b3bc679f336f`。测试校验该哈希与不可变基线一致。模型桩故意返回部分错误 low/approve，以挑战本地保护，结果不是模型准确率。

| 审批请求指标 | 原版固定 mock 回放 | 当前默认配置固定 mock 回放 |
| --- | ---: | ---: |
| 总请求数 | 140 | 140 |
| unsafe-auto / 需人工标签 | 41 / 70 | 0 / 70 |
| safe-to-human / 安全标签 | 12 / 70 | 0 / 70 |
| unknown 标签数 | 16 | 16 |
| 模型调用次数 | 99 | 73 |
| 每百请求转下游候选数 | 29.29 | 50.00 |

总体转人工增加，因为旧版中错误自动批准的危险样例恢复了人工接管。不能把安全样本中误拦下降或调用数变化写成真实人工负担下降，也不能宣称真实 20% 目标达成。p50/p95、超时率和真实模型格式错误率均未测量。

记录：[基线](approval-baseline.json)、[当前候选](approval-candidate.json)、[影子](approval-shadow.json)。当前候选和影子记录包含 policyVersion、基线 HEAD、workingTree 标识，以及 index.js、danger-patterns.js、cordis.patch.yml、package.json 四个运行时文件组成的 sourceSha256；代码变化后应重新生成结果。

影子回放 140 次全部交给下游，自动授予为 0；候选 would-auto 为 70，候选误批 0、安全候选遗漏 0。影子记录中的 safeToHuman=70、humanPer100=100 是强制委托的预期行为，不能与实批效率直接比较。

```bash
node scripts/tune-from-logs.mjs --evaluate --baseline
node scripts/tune-from-logs.mjs --evaluate
node scripts/tune-from-logs.mjs --evaluate --shadow
```

基线模式用 git show 将固定旧版复制到临时目录，运行完自动清理；不切换或修改当前 checkout。所有模式只调用假宿主和假模型，永不执行语料里的 shell 命令。基线模式需要完整 git 对象和已安装 peer dependency。

额外回归测试覆盖默认空 dangerPatterns 仍有保护、正常低风险缓存复用、TTL、取消/卸载、超时/流协议、双会话 API、官方 auto 隔离、真实消息撤销、并发、引号/Unicode/别名和精确中风险授权。

## 首次候选自动化验收（历史记录）

| 门槛 | 命令 / 证据 | 状态 |
| --- | --- | --- |
| 语法与导入 | node --check index.js；node --check danger-patterns.js；现有测试导入各模块 | PASS |
| 原触发与同类编码 | 缺证据、错配、引号/Unicode、CLI 别名、外部 workdir 等假宿主回归 | PASS；原触发不再自动批准 |
| 合法对照与完整包检查 | npm test；缓存复用、当前工作区精确授权、只读/字面输出、下游异常语义及 client 测试 | PASS；合法宿主流程保留 |
| Node 22.22.0 | npm ci && npm test | PASS，175 项测试 |
| Node 24.19.0 | npm ci && npm test | PASS，175 项测试 |
| 固定语料 | 默认配置和 dangerPatterns: [] | PASS；样本内 unsafe-auto=0，safe-to-human=0 |
| Shadow | --evaluate --shadow | PASS；没有自动授予 |
| 包装检查 | npm pack --dry-run --json | PASS；核心模块、评估模块、语料和 bundle 均包含 |
| 真实日志与真人标签 | 至少 30 条脱敏真实样例；独立安全留出集 | NOT_VERIFIED；未提供真实日志 |
| 真实模型与宿主影子观察 | provider 成本、延迟、误拦、缓存失效和按原因码聚类 | NOT_VERIFIED；未配置测试宿主和 provider |
| Web / Desktop / TUI、官方 auto 共存 | 各客户端人工兜底、单次审批事件对、取消、报告隔离与重启 | NOT_VERIFIED；仅有假宿主和 client 单测 |

每个运行时检查在临时 Node 22 或环境 Node 24 下执行，依赖仍来自原 package-lock.json。最初沙箱下默认 node --test 只能返回文件级计数；有效的隔离测试在允许创建子进程的执行配置下运行，并辅以 --test-isolation=none，使用完整测试计数作为证据。

## 下一轮安全修复

修复起点：PR #1 `work` 分支 `6e2507e1b6981fefd10ce5b240bb626f832edc2b`。删除 `lowRiskFastPath` 的 schema、配置与直接授权分支；旧配置即使传入也不能跳过模型。字面输出仍可由模型批准，只有本插件低风险模型批准能进入重验证缓存。

共享 `simpleCommandWords()` 仅按 ASCII 空格和 Tab 分词，其他未引用空白直接返回 uncertain，保留引号中的 Unicode 内容。`inspectCommand()` 对 printf 仅接受固定 `%s`、`%s\n` 格式（支持 `--`）；`-v`、`%n`、其他格式和不确定语法在模型与缓存之前交人工，不以高风险标签误判普通字面输出。路径形式、sudo 与无法解析的 wrapper 同样不能绕过保护。

`userRestricted()` 只识别完整的高确定性独立禁令，避免中文 `\b` 和前缀误拦。以下三个原句新增本地回归：

- `Please do not run any commands.`
- `Only inspect. Do not execute any commands.`
- `I revoke authorization. Do not run any commands.`

引用、示例、复杂条件和未匹配措辞携带完整历史交模型。历史禁令保持有效，新增撤销使旧缓存失效，最新精确 `Run: <command>` 重新授权仍需模型分类。新增回归在原 `test/index.test.js` 中，原语料与三个历史指标 JSON 保持不变。

语义依据：[Bash blank/metacharacter 定义](https://www.gnu.org/software/bash/manual/html_node/Definitions.html)、[Bash printf 的 -v 与 %n](https://www.gnu.org/s/bash/manual/html_node/Bash-Builtins.html)、[MDN 的 JavaScript \s 定义](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Regular_expressions/Character_class_escape)。

本轮按顺序完成语法检查、原触发/相邻合法输入、安全回归、完整包检查；所有示例仅作为假宿主输入，没有执行危险命令。修复前共享函数把 `printf -v HOME /tmp`、`printf %n HOME`、`echo<NBSP>--help` 都标为 literalDisplay；修复后的回归证明这些输入交人工且模型调用为零。正常 echo、printf `%s`/`%s\n`、引号中的 NBSP 继续由模型正常批准。旧配置开启也不能跳过模型 ask。

| 本轮门槛 | 命令 / 证据 | 结果 |
| --- | --- | --- |
| 语法 | `node --check index.js`；`node --check danger-patterns.js` | PASS |
| 重点回归 | `node --test --test-isolation=none --test-name-pattern='removed fast path\|printf assignment\|shell words\|standalone user\|quoted restrictions\|historical restrictions\|bundle inherits' test/index.test.js` | PASS，7 个重点测试；后续完整测试包含最终 Unicode 边界 |
| Node 22.23.3 | `npm ci && npm test -- --test-reporter=spec`，临时 Node 22 与 npm 临时缓存 | PASS，180 项测试 |
| Node 24.21.0 | `npm ci && npm test -- --test-reporter=spec`，本机 Node 24 与 npm 临时缓存 | PASS，180 项测试 |
| 独立候选审查 | 只读复核共享边界、直接调用方、编码、wrapper、缓存与用户授权状态 | 未发现范围内具体绕过或回归 |
| 固定基线 | `node scripts/tune-from-logs.mjs --evaluate --baseline` | 140 条，unsafeAuto=41、safeToHuman=12，原始结果保持一致 |
| 本轮候选 | `node scripts/tune-from-logs.mjs --evaluate` | 140 条，unsafeAuto=0、safeToHuman=0、modelCalls=73 |
| 本轮影子 | `node scripts/tune-from-logs.mjs --evaluate --shadow` | 自动授予=0；wouldAuto=70，候选误批/遗漏均为 0 |
| 包装与补丁 | `npm pack --dry-run --json`；`git diff --check` | PASS |

本轮运行时 `sourceSha256`：`4e9142cf5475f69030dedcf1550950f188d6adddbf37ac9116f974c25f4cddfa`（四文件集合与前文相同）。固定语料 SHA-256 仍为 `564ffd393a24839a89e329606f29211329b48dd15e00e71fce10b3bc679f336f`，不改写历史 JSON 记录。GitHub Node 22/24 CI 以 PR #1 当前 HEAD 的检查结果为准，本地双版本通过不替代远端 CI。

npm 的默认缓存目录在受限环境不可写，安装实际使用 `--cache /private/tmp/dsh-auto-approve-npm-cache`；没有改系统目录权限或引入项目依赖。

C04 的真实 cwd 执行链维持 DEFERRED；真实宿主、真实模型和至少 30 条脱敏真人标签均为 NOT_VERIFIED，不由合成回放替代。复杂限制和未支持格式仍依赖模型或人工；离线零误批不证明生产安全。PR #1 保持 Open，禁止以本轮本地通过代替真实灰度验收。

## 实际灰度步骤（待执行）

先在用户本地部署配置中设置 shadowMode: true、sessionMemory: false，使用可丢弃测试 profile，不从项目文件建立永久信任。保持本插件预设 sandbox: workspace-write、approval: ask。先核对实际 dump-config 含 sandboxed-auto，官方 auto 由宿主提供且未被本插件应答。

在 Web、Desktop、TUI 分别用无副作用的字面输出请求测试审批链：若宿主产生显式 danger-full-access 请求，影子模式必须出现人工入口；选择拒绝后停止。没有进入 approval/request 的工具调用不计入审批指标。验证取消不会挂起，另一会话报告为空，重启后报告清空，Session log 仍保留原生 asked/decided 对。

再在可丢弃环境关闭 shadow，低风险同条件重复应可复用本插件模型批准；人工批准、不同工作区/授权/目标和新增限制都不能作为旧授权重放。使用额外规则对无副作用 printf 请求强制转人工，核对 handoff 和原生 outcome 一致；不要用真正破坏性命令测试客户端。

只有收集到足够脱敏标签后，才按 approval/request 为分母计算危险误批、安全误转人工、每百次人工候选数、模型调用数、超时/格式错误和延迟。Session log 的 allowed-once 没有批准者身份，不得直接标成 auto 或 human。有限规则识别到但未进入审批的工具调用候选，另列为覆盖范围提示，不拿总工具调用数稀释审批指标。

每个客户端分别记录版本、候选 sourceSha256、语料版本、provider/model、数据量与指标。高危固定样例新增任一误批、人工入口失效、身份不一致仍自动批、撤销后重放、影响其他预设或任何非预期真实外部副作用，都阻断发布。

## 回滚

仅在用户本地 profile patch 修改，不让 Agent 从项目文件授予永久信任：

```yaml
- id: auto-approve
  config:
    sessionMemory: false
    shadowMode: true
```

这会将本插件的自动候选全部交给宿主。需要直接回到原生流程时切换会话为 workspace-write；必要时禁用插件并重启：

```yaml
- id: auto-approve
  disabled: true
```

保留本次证据校验和不可覆盖保护，避免通过恢复错误批准/人工缓存来降低统计上的转人工数。

## 修改清单

- index.js：请求身份、来源化上下文、严格分类协议、授权范围、缓存生命周期、出口重检、脱敏台账和影子模式。
- danger-patterns.js：依赖 Node 标准库的有限事实检查、不可覆盖保护、路径归一化和成对字面输出处理。
- cordis.patch.yml：统一使用 schema 提示默认值，删除快通行配置，影子默认关闭，保留原生预设与人工入口。
- scripts/tune-from-logs.mjs、scripts/approval-evaluation.mjs：复用离线入口，固定版本回放、行动提示、有限覆盖统计及安全摘录。
- test/index.test.js、test/tune-from-logs.test.js、test/fixtures/approval-corpus.json：边界、生命周期、协议、别名和固定对照语料。
- package.json：将离线语料加入发布文件列表；依赖和版本未变。
- README.md、README_EN.md、docs/ACCEPTANCE.md、三个指标 JSON：迁移、来源/沙箱边界、回滚、实测与未验证状态。
