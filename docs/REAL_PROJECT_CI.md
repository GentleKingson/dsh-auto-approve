# 真实小型项目端到端：clsx（Mock）

2026-10-12。唯一宿主 DSH `0.2.0-rc.2`（Node 24），工作流 `.github/workflows/dsh-real-project.yml`，脚本 `scripts/ci-dsh-real-project.mjs`。本轮只加测试夹具、脚本、工作流与本文档；`index.js`、`danger-patterns.js`、`cordis.patch.yml` 未改。`scripts/ci-dsh-integration.mjs` 只给 `installLinkedPlugin()`、`dumpConfig()` 加了默认值为 `acp` 的 `profile` 参数，原有调用不变。

## 验证了什么

一次真实的 `dsh --profile headless --json` 运行，在固定提交的第三方仓库里完成"基线通过 → 注入缺陷后失败 → 修复后通过"，同一运行内带两次沙箱升级。Agent 与分类器的回复来自本地脚本化端点，所以这证明的是**驱动、工具执行、沙箱、审批链和独立断言可靠**，不是模型能力。

| 阶段 | 检查 |
| --- | --- |
| prepare | 只检出 `test/fixtures/real-projects/clsx.json` 中的 40 位提交；`src/index.js`、`test/index.js`、`package.json` 的 SHA-256 一致；复制本仓库审核过的锁文件后 `npm ci --ignore-scripts`；基线 `npm test` 通过；`git apply --check` 后注入 `clsx-numeric-bug.patch`，`npm test` 恰好在 3 个预期用例上失败。任一不符即 `BLOCKED`，不启动 DSH。 |
| config | 宿主恰为 `0.2.0-rc.2`；headless profile 中插件唯一且启用（`shadowMode=false`、`sessionMemory=false`）；默认预设 `sandboxed-auto` = `workspace-write + ask`；`approval.policy=ask`；`sandbox-policy=workspace-write`。任一不符即 `BLOCKED`。 |
| headless | 退出码 0、`--json` 以 `session` 开、以 `final` 收，原生会话日志 `turn/end=completed`，工具调用顺序与脚本一致；Agent 看到注入后的失败和修复后的通过。 |
| 升级 | 恰好 2 次 `approval/asked`，都按 `callId` 绑定到脚本参数。低风险标记文件：分类器恰被调用一次，`approval/decided=allowed-once`，文件实际创建。`rm -rf` 一次性目录：本地危险规则在分类器之前转交，headless 无应答方，结果 `unavailable`，目录完好。headless 没有审批客户端，`allowed-once` 只可能来自插件。 |
| 独立断言 | 运行后由脚本自己再跑 `npm test`；`git status` 只允许 `src/index.js`；`test/index.js`、`package.json`、锁文件哈希不变；脚本化修复使 `src/index.js` 逐字节恢复。 |

产物 `dsh-real-project-mock` 含 `real-project-summary.json`、`assertions.json`、配置摘要与审批事件。本作业不使用任何密钥；`--json` 原始流和 stderr 留在 runner 临时目录。

## 与原计划不同之处

- **clsx 在 Node 22/24 上基线失败。** `npm test` 是 `uvu -r esm test`，`esm@3.2.25` 在 Node 22.22 和 24.21 上报 `SyntaxError: Cannot use import statement outside a module`；Node 18.20、20.20 上 32/32 通过；上游 CI 只覆盖 Node 8–18。因此项目自身的安装与测试固定在 Node 20（`--project-node`，工作流中第一个 `setup-node`），DSH 仍在 Node 24 上运行。Agent 的 shell 继承这个 PATH，所以 Agent 运行的 `npm test` 也用 Node 20。
- **锁文件不是上游的。** clsx 的 `.gitignore` 忽略 `*-lock.*`，上游没有锁文件。`clsx.package-lock.json` 由 `npm install --package-lock-only` 依固定提交生成，12 个包全部来自 `registry.npmjs.org` 并带 integrity。
- **ACP canary 并入 headless 运行。** 计划要求另起 ACP 会话复用 `autoPhase()`。headless 没有任何审批客户端，在这里观察到 `allowed-once` 比在 ACP 中更直接地归属于插件；ACP 下的 `allowed-once` 与高风险转交仍由 `test.yml` 的 `dsh-integration` 每个 PR 运行，`autoPhase()` 未导出也未复制。
- **惰性执行器未重跑。** 社区 30 例的惰性边界已在 `test.yml` 的 `community-host-boundary` 中每个 PR 运行，本工作流不重复。

## 真实模型阶段：`LIVE_EXECUTION_BLOCKED`

计划的 Phase 2 要求先证明模型密钥与 Agent 执行的第三方代码隔离。当前证据表明**没有隔离**：

- 本脚本在 DSH 宿主环境中放入随机伪密钥 `CI_REAL_PROJECT_CANARY`，由 Agent 在**未升级**的 `workspace-write` 沙箱中执行 `printenv`。结果：`shellSawHostEnvCanary: true`（本地 Node 22 与 Node 24 各一次）。即宿主进程环境变量原样进入模型 shell，`npm test` 运行的第三方依赖代码（uvu、esm）也在同一环境中。
- `dsh-bash-local` 传给子进程的 `env` 只列出颜色/分页等覆盖项与 `DSH_*`，没有清空继承环境的步骤（以上实测为准）；`dsh-launch-environment` 的 README 明说其快照"不隔离子进程"。
- 内置 provider 从 `apiKeyEnv` 指定的环境变量读密钥，所以 `OPENCODE_GO_API_KEY` 必须在 DSH 进程环境里，`hostEnv()` 也不清理它。

结论：在当前架构下，带真实密钥运行真实 Agent，等于把密钥交给 Agent 和第三方代码。本仓库**不提供 `live` 入口**，替代证据仍是本 Mock 实执行 + `dsh-live.yml` 的真实分类器 Shadow（其 Agent 是脚本，只执行固定命令）。

要解除阻断，至少需要同时做到并在 CI 中实测：

1. 密钥只在一个独立的转发代理里（不同 Unix 用户或单独容器），DSH 只拿到占位密钥和指向代理的 `baseURL`；
2. Agent 所在用户无法读取代理进程的 `/proc/<pid>/environ`、文件和内存；
3. 代理侧有调用次数/费用上限与只允许固定模型的白名单，因为 Agent shell 仍能直接调用代理；
4. 用同样的伪密钥探针证明 Agent shell 看不到真实密钥，日志和产物中也没有。

## 运行

```sh
node scripts/ci-dsh-real-project.mjs \
  --dsh <dsh 安装目录>/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --root </tmp 以外的空目录> --evidence <目录> \
  --project-node <含 Node 20 的 bin 目录>
```

需要能访问 GitHub（按 SHA 浅取 clsx）与 npm 源。回滚：删除或停用 `dsh-real-project.yml`，不涉及运行时。

## 不代表

一个小项目上的脚本化通过，不代表真实模型的修复能力、自动批准率或误批率；`approvalRequests=2` 是本脚本设计的升级次数，不是统计口径。
