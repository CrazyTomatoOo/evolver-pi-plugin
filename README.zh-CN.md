# Evolver —— pi 的代理自进化引擎

[English](./README.md) | 中文

为 [pi](https://github.com/earendil-works/pi-coding-agent) 编码代理提供一套
**持久、可审计的进化记忆**。pi 不再每个会话都从零重新解决同一个问题——
它会召回此前管用的做法、在编辑时察觉改进信号、并让你或代理显式记录每次会话的结果，
让下一个会话开局更聪明。

这是 [`evolver-claude-code-plugin`](https://github.com/EvoMap/evolver-claude-code-plugin)
的洁净室移植版——记忆图格式相同，在 pi 的扩展 API 上重新表达。
**纯本地版**：无 Hub、无 Proxy、无外部网络。记忆图与 `@evomap/evolver` 引擎及兄弟插件逐字节兼容。

## 它做什么

生命周期事件驱动一个本地核心；任何结果都**不会自动推断**：

| pi 事件 | 作用 |
| --- | --- |
| `session_start` | 为下一轮武装一次**首轮均衡 Recall**（成功/失败、≤ 7 天、score ≥ 0.5、最新优先、最多 3 条、≤ 2 000 字符）。 |
| `before_agent_start` | 先清空 Ready Outbox，再投递一次已武装的 Recall（经 `workspaceId + recallHash` 在 reload/resume/fork 间幂等）。 |
| `tool_result`（write/edit/replace） | 扫描成功变更中的建议性信号（`log_error`、`perf_bottleneck`、`capability_gap`、`test_failure` 等）。 |
| `session_shutdown`（quit/new/resume/fork） | 将一个显式待定 Outcome 终结进不可变 Graph（reload 绝不终结）。 |

Outcome **仅显式提交**——通过 `evolver_outcome` 工具或 `/evolver-outcome` 命令提交一个裁决和一条可复用 lesson。
任何结果都不会从 diff 关键词分类、也不会因信号缺失而捏造。

记忆**按工作区隔离**（通过防伪造的 `.evolver/workspace-id`），因此一个项目的结果绝不会泄漏进另一个项目。
状态（基线、Ready Outbox、结果槽）在 `EVOLVER_SESSION_STATE_DIR` 下以原子 0600 写入、防符号链接。

## 安装

```bash
pi install git:github.com/CrazyTomatoOo/evolver-pi-plugin
```

重启 pi（或 `/reload`）。**本地记忆零配置即用**——无需账号、无需密钥、什么都不用填。

## 命令与工具

| 面 | 名称 | 用途 |
| --- | --- | --- |
| LLM 工具 | `evolver_outcome` | `set`/`clear` 一个已验证的待定裁决 + lesson（Google 兼容扁平 schema）。 |
| 斜杠命令 | `/evolver-outcome` | 同一契约，用户发起；回执留在 model context 之外。 |
| 斜杠命令 | `/evolver-status` | 渲染只读编辑器下方 widget（重复刷新，下次输入清除）。 |

提交不发起 model call、不返回 Session 消息；回执仅为本地通知。

## 本地存储

| 路径 | 内容 |
| --- | --- |
| `~/.evolver/memory/evolution/memory_graph.jsonl` | 仅追加的不可变 Outcome 记录（唯一去重真相）。 |
| `~/.evolver/state/sessions/<wsid>/<session>.json` | 每 session 的基线、信号、待定 Outcome。 |
| `~/.evolver/state/outbox/<wsid>/<diff_hash>.json` | 待 Graph 追加的滞留 Ready 项。 |
| `~/.evolver/state/results/<wsid>.json` | `lastAttempt`/`lastRecorded` 回执槽 + 公告状态。 |

evolver 托管的项目则把图放在该项目的 `memory/evolution/` 下。

## 运行要求

- **Node.js ≥ 22**——纯 TypeScript，pi 经 jiti 直接加载；无构建步骤。
- **Git**——workspace 快照取自工作树。
- **pi `^0.84.1`**——已测试的 Pi 版本线（`package.json` 与 dogfood 均锁定）。

## 环境变量

生产代码只读取四个：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `MEMORY_GRAPH_PATH` | （自动） | 覆盖记忆图文件位置。 |
| `EVOLVER_WORKSPACE_ID` | （自动） | 覆盖工作区隔离 id。 |
| `EVOLVER_SESSION_STATE_DIR` | `~/.evolver` | 持久 transition/outbox/result 状态存放处。 |

## 验证

```bash
npm ci
npm test                    # 108 项 Bun 契约测试
npm run typecheck           # tsc --noEmit
npm run self-check          # 临时沙箱中的组合核心流程
npm pack --dry-run          # 包元数据健全性
docker build -f dogfood/Dockerfile -t evolver-dogfood .
docker run --rm --network none evolver-dogfood   # 21/21 = 通过
```

Docker 网关在 **`--network none`** 下用真实 pi 对接 loopback mock 模型——证明无需 Hub 或外部网络依赖。

## 许可

MIT。内置逻辑为原创洁净室移植——**不**源自 GPL 许可的 `@evomap/evolver` 源码。
