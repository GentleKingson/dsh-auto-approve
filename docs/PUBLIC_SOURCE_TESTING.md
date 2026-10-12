# 公开资料驱动的审批回归测试

2026-10-12 收集了 28 份官方文档/源码并检索公开问题报告；最终将其中 19 份官方文档和 5 条 PowerShell 公开问题报告用于 151 条审批案例。未使用的下载材料不计入测试覆盖。

## 来源与标签

- 85 条保留来源中的原文命令或完整代码块，15 条仅移除 Git 文档的提示符/说明标记，51 条由文档语义派生。
- 原文代码块可能含多个语句；151 是审批请求数量，不是独立事故数量。
- 每条案例包含来源、短引文、原文行号、转换类型、预期行为及理由。官方文档固定到 commit SHA；问题报告记录抓取时间、更新时间及正文 SHA-256，后续正文变化会令在线核验失败。
- 公开问题是特定版本/平台的报告。本测试只回放其文本，不声称已重现对应上游缺陷。没有获得用户的真实 DSH 会话日志，也没有查到与截图 `grantwrite acl problem` 精确对应的公开事故证据。

## 测试方法与发现

通过真实插件审批入口回放，模型桩对所有请求固定返回 low/approve，从而检验本地规则能否抵挡错误批准。语料中的命令不交给执行器。`auto` 只表示在这个桩响应下可通过审批，不表示该命令在任意环境中安全。

首轮发现 27 条破坏性请求被放行，集中在 `git reset --hard` 与非预演 `git clean`。Git 官方文档明确前者丢弃工作树修改，后者在 `clean.requireForce=false` 时甚至无需 `-f` 即可删除文件。新增本地规则：hard reset（包括缩写）转人工，其他 reset 至少 medium；clean 仅在确认存在有效预演参数时继续审核，并区分排除参数值、路径操作数和选项。

首轮另有一条预期标签错误：PowerShell `git clean -n -- -f` 使用了适配器明确不支持的 `--`，因此改为人工预期。这是纠正语法支持范围标签，不是修复运行时行为；27 条危险案例标签未改变。

修复后：151 条中 120 条预期人工、31 条模型候选，非预期放行和非预期转人工均为 0。模型调用 33 次：另有两条 medium 风险 push 进入模型后拒绝 low 回答。人工案例包括不支持的无害语法，因此不能把 120 条称作危险命令，也不能用它们估算生产误报率。

原有 140 条合成基准保持不变：误放行 0、预期自动却转人工 0、模型调用 73。语料 SHA-256：`564ffd393a24839a89e329606f29211329b48dd15e00e71fce10b3bc679f336f`。

## 平台验证与复现

Windows CI 增加公开语料回放以及所有被本地解析器接受的 PowerShell 主命令与原生 AST 的比较。AST 比较仅调用 ParseInput，不执行语料命令；复合成功消息另由现有原生测试验证。

受控临时目录中的 Python 实测使用 `-I -S -B -m py_compile`，验证源码不执行、当前目录同名模块不加载、仍产生显式字节码缓存；另验证文档声明的非普通缓存目标拒绝行为和目标保留。此测试不提供生产解释器可信证明。

```sh
node scripts/evaluate-public-corpus.mjs
node scripts/evaluate-public-corpus.mjs --verify-sources
npm test
```

在线核验需要 GitHub 网络访问；使用环境代理的 Node 24 可加 `--use-env-proxy`。普通 CI 离线使用固定语料，不依赖外部网页可用性。完整来源元数据在 `test/fixtures/public-approval-corpus.json`。

P3 默认关闭，尚无生产宿主证据提供器。这批测试不证明 Windows DSH ACL 集成、实际分类模型准确率或真实人工审批减少比例。

## 实际使用的来源

- [ps-parsing](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/a3de8f22552170e70852470d46cd52cd9ca471ec/reference/7.4/Microsoft.PowerShell.Core/About/about_Parsing.md)
- [ps-quoting_rules](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/a3de8f22552170e70852470d46cd52cd9ca471ec/reference/7.4/Microsoft.PowerShell.Core/About/about_Quoting_Rules.md)
- [ps-special_characters](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/a3de8f22552170e70852470d46cd52cd9ca471ec/reference/7.4/Microsoft.PowerShell.Core/About/about_Special_Characters.md)
- [ps-operators](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/a3de8f22552170e70852470d46cd52cd9ca471ec/reference/7.4/Microsoft.PowerShell.Core/About/about_Operators.md)
- [ps-comparison_operators](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/a3de8f22552170e70852470d46cd52cd9ca471ec/reference/7.4/Microsoft.PowerShell.Core/About/about_Comparison_Operators.md)
- [ps-if](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/a3de8f22552170e70852470d46cd52cd9ca471ec/reference/7.4/Microsoft.PowerShell.Core/About/about_If.md)
- [ps-redirection](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/a3de8f22552170e70852470d46cd52cd9ca471ec/reference/7.4/Microsoft.PowerShell.Core/About/about_Redirection.md)
- [ps-automatic_variables](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/a3de8f22552170e70852470d46cd52cd9ca471ec/reference/7.4/Microsoft.PowerShell.Core/About/about_Automatic_Variables.md)
- [ps-environment_variables](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/a3de8f22552170e70852470d46cd52cd9ca471ec/reference/7.4/Microsoft.PowerShell.Core/About/about_Environment_Variables.md)
- [ps-command_precedence](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/a3de8f22552170e70852470d46cd52cd9ca471ec/reference/7.4/Microsoft.PowerShell.Core/About/about_Command_Precedence.md)
- [ps-pipelines](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/a3de8f22552170e70852470d46cd52cd9ca471ec/reference/7.4/Microsoft.PowerShell.Core/About/about_Pipelines.md)
- [ps-pipeline_chain_operators](https://github.com/MicrosoftDocs/PowerShell-Docs/blob/a3de8f22552170e70852470d46cd52cd9ca471ec/reference/7.4/Microsoft.PowerShell.Core/About/about_Pipeline_Chain_Operators.md)
- [py-py_compile](https://github.com/python/cpython/blob/0b05ead877f909b7efe712db758012d9dbece7ce/Doc/library/py_compile.rst)
- [git-push](https://github.com/git/git/blob/777489f9e09c8d0dd6b12f9d90de6376330577a2/Documentation/git-push.txt)
- [git-reset](https://github.com/git/git/blob/777489f9e09c8d0dd6b12f9d90de6376330577a2/Documentation/git-reset.txt)
- [git-clean](https://github.com/git/git/blob/777489f9e09c8d0dd6b12f9d90de6376330577a2/Documentation/git-clean.txt)
- [git-status](https://github.com/git/git/blob/777489f9e09c8d0dd6b12f9d90de6376330577a2/Documentation/git-status.txt)
- [git-diff](https://github.com/git/git/blob/777489f9e09c8d0dd6b12f9d90de6376330577a2/Documentation/git-diff.txt)
- [git-rev-parse](https://github.com/git/git/blob/777489f9e09c8d0dd6b12f9d90de6376330577a2/Documentation/git-rev-parse.txt)
- [All verbatim arguments (`--%`) are ignored when passed to a native command.](https://github.com/PowerShell/PowerShell/issues/26198)
- [Argument with colon in it is incorrectly handled if not quoted](https://github.com/PowerShell/PowerShell/issues/23819)
- [Unix-like platforms, Windows with the experimental `PSNativeWindowsTildeExpansion` feature: Native tilde expansion unexpectedly expands tilde in variable references](https://github.com/PowerShell/PowerShell/issues/21323)
- [Unix: Native globbing cannot be bypassed when using splatting](https://github.com/PowerShell/PowerShell/issues/24178)
- [Backtick-escaping doesn't work for suppressing native tilde and pathname expansions](https://github.com/PowerShell/PowerShell/issues/27116)
