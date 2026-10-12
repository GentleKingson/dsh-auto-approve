# Python 编译执行证据契约 v1

这是 P3 的宿主扩展接口，不是来自模型的证明，也不是可直接启用的 DSH 内置能力。本仓库实现消费者、校验器和合成提供者测试。当前没有生产提供者；真实 DSH 适配和端到端执行绑定仍待实现及验证。没有提供者时保持人工审批。

## 开关与来源

插件配置 `pythonCompileReview` 默认 `false`。开启后，在已有上下文、工具身份、参数、用户限制、后台执行和自定义规则校验通过的前提下，插件才会查找 `ctx.get('autoApproveExecutionEvidence')`。不修改部署配置，不从项目文件、环境变量或工具参数加载证明，不把前次人工批准作为证明。

提供者必须由部署所有者在受保护的宿主配置中注册，并与真实执行器集成。插件名称、命令前缀、文件哈希、Agent 自述或证据中的布尔值，本身都不能证明真实执行器会遵守它。**不得实现一个仅返回这些布尔值的生产提供者。**

## 提供者协议

`acquire(request, { signal })` 返回 Promise 或一个租约：

```js
{
  facts,                       // 下面定义的可序列化快照
  isCurrent(requestHash),      // 同步返回严格的 true 才有效
  dispose(),                   // 释放审查资源；必须幂等
}
```

`request` 包含 `version`、`sessionId`、`callId`、`toolName`、原始 JSON 参数字符串 `arguments`、当前授权上下文键 `contextKey`、`workspacePath`、`workdir`、`platform`、编译 `candidate`、解析后的 `sourcePath` 和 `requestHash`。`candidate` 包含原始可执行文件词、源码参数、结构类型及可选成功提示文本。绑定摘要为上述对象（不含 `requestHash`）按发送顺序 `JSON.stringify` 后的 SHA-256。提供者应将收到的摘要关联到实际待执行调用，并核对全部字段，不独立猜测另一条命令。

`acquire` 不得运行待审批命令、目标源码、项目脚本或未知解释器来“探测安全”。它可以使用受保护的宿主能力检查实际执行规格、原生 AST、既有安装清单和文件状态。获取时间受 `timeoutMs` 限制，传递取消信号；超时或取消之后晚到的租约会被清理。

`facts` 必须满足以下要求。所有路径是当前宿主平台下规范化的绝对路径；不支持 UNC、设备路径、盘符相对路径和绝对 ADS 路径。哈希字段均为 64 位小写十六进制。

| 字段 | 要求 |
| --- | --- |
| `version` | `1` |
| `requestHash`, `platform`, `shell`, `structure` | 与请求完全一致；结构为 `command` 或 `success-message` |
| `expiresAt` | 未来的整数毫秒时间戳，获取时有效期不超过 120 秒 |
| `executionBound` | `true`；实际执行器只允许绑定的调用、命令、cwd、环境、解释器及路径，变动后拒绝执行 |
| `parserVerified` | `true`；已用实际执行 Shell 的语法/AST核对完整命令，PowerShell 尾句只能是成功条件下的单个字面字符串 |
| `shellStartupVerified`, `environmentBound` | `true`；Shell 启动没有额外 profile/初始化动作，命令解析不会变成函数/别名/另一程序；环境快照绑定到执行 |
| `isolated`, `siteDisabled`, `importBytecodeDisabled` | `true`；实际参数包含严格形式 `-I -S -B -m py_compile`，无额外参数 |
| `runtimeRoot`, `executablePath` | 解释器是运行时根目录内的应用程序，且运行时根目录与工作区不重叠；显式可执行路径必须匹配 |
| `runtimeProtected` | `true`；解释器、标准库、加载依赖和配置由受保护安装管理，工作区/Agent 无法替换其代码或查找规则 |
| `executableSha256`, `runtimeSha256` | 实际可执行文件及受保护完整运行时快照的摘要；不是只哈希命令字符串 |
| `workspaceRealPath`, `cwdRealPath` | 与请求工作区、工作目录相同；经过真实路径检查，不存在导致作用域变化的映射 |
| `sourcePath`, `sourceRealPath`, `sourceRegular`, `sourceSha256` | 源码位于工作区内部，真实路径与目标相同，是普通文件；记录其内容摘要 |
| `cachePrefix`, `cacheTag` | 前者为 `null`，后者为 `cpython-<数字>`（可带 `t` 后缀），不能改变缓存根路径 |
| `outputPath`, `outputParentRealPath` | 精确为源码旁的 `__pycache__/<stem>.<cacheTag>.pyc` 及其父目录；父目录不存在时也必须约束创建过程 |
| `outputKind`, `outputNoFollow` | 输出为 `absent` 或 `regular-file`；后者为 `true`，执行时不允许 symlink、junction、reparse point 或替换竞争重定向写入 |

`isCurrent` 必须核验所绑定的实际执行事实仍然有效，且调用未取消、消费或替换。返回 Promise、抛异常、过期、提供者替换或快照变动均转人工。插件在模型评审前后重检，并禁用该通路的审批缓存。用户限制、自定义危险规则和模型判断仍可阻止批准。

`dispose` 只释放审查资源，不撤销执行器必须遵守的约束；批准返回到工具执行之间的竞争必须由执行器原子绑定/拒绝处理。不能用“最后再 stat 一次”代替执行时约束。若现有 DSH 无法提供这些保证，提供者必须拒绝签发有效证据。

## 支持范围与验证

初始范围只支持单个 `.py` 文件和精确参数顺序 `-I -S -B -m py_compile`，可带 P2 的固定成功提示。`-c`、脚本执行、其他模块、多目标、额外选项、未知路径或运行时不受保护均不进入该通路。原始截图命令不会被静默改写成支持形式。

`test/compile-evidence.test.js` 使用明确标注的合成宿主租约测试策略边界，没有声称验证了真实解释器、ACL 或执行器绑定。`test/windows-approval.test.js` 在 Windows 上用原生 PowerShell AST 对照 P2 子集；Python 烟雾测试仅在临时目录执行固定的受控编译。生产准入还需真实 DSH 提供者、环境变化/文件替换竞争测试、影子评估和可丢弃环境灰度。
