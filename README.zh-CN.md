# Evolver —— pi 的代理自进化引擎

[English](./README.md) | 中文

为 [pi](https://github.com/mariozechner/pi) 编码代理提供一套**持久、可审计的进化记忆**。
pi 不再每个会话都从零重新解决同一个问题——它会召回此前管用的做法、
在编辑时察觉改进信号、记录每次会话的结果，让下一个会话开局更聪明。

这是 [`evolver-claude-code-plugin`](https://github.com/EvoMap/evolver-claude-code-plugin)
的 pi 移植版——记忆格式相同、洁净室逻辑相同，只是在 pi 的扩展 API 上重新表达。
**纯本地版**：无 Proxy、无 Hub、无网络。记忆图与 `@evomap/evolver` 引擎及兄弟插件逐字节兼容。

## 它做什么

三个行为自动运行——你无需调用：

| pi 事件 | 作用 |
| --- | --- |
| `session_start` | 以被动上下文注入本工作区近期**成功**结果的摘要（score ≥ 0.5、< 7 天、最多 3 条）。 |
| `tool_result`（write/edit/replace） | 检测编辑中的改进信号（`log_error`、`perf_bottleneck`、`capability_gap`、`test_failure` 等），并提醒代理记录结果。 |
| `session_shutdown`（`reason: "quit"`） | 对会话的 git diff 做一次分类，把结果追加进进化记忆图。 |

记忆**按工作区隔离**（通过防伪造的 `.evolver/workspace-id`），
因此一个项目的结果绝不会泄漏进另一个项目的会话。
其写入格式与 `@evomap/evolver` 引擎及 Claude/Cursor 兄弟插件逐字节兼容。

还内置一个 **`capability-evolver` skill**（召回 → 干活 → 记录 的循环）。

## 安装

```bash
pi install git:github.com/CrazyTomatoOo/evolver-pi-plugin
```

重启 pi（或 `/reload`）。**本地记忆零配置即用**——无需账号、无需密钥、什么都不用填。

## 本地模式（默认，零配置）

结果落在 `~/.evolver/memory/evolution/memory_graph.jsonl`
（evolver 托管的项目则落在该项目的 `memory/evolution/` 下）。
召回与记录立即生效。**无需账号、无需密钥、无需网络。**

## 运行要求

- **Node.js ≥ 22**——纯 Node 扩展，无 HTTP 网桥。
- **Git**——结果由项目的 git diff 推导。

## 状态

- ✅ **本地核心**——三个自动行为、按工作区隔离的记忆、skill。
- ⏳ **npm 发布**——等有消费者需要时再上 `pi install npm:`。

## 环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `MEMORY_GRAPH_PATH` | （自动） | 覆盖记忆图文件位置。 |
| `EVOLVER_WORKSPACE_ID` | （自动） | 覆盖工作区隔离 id。 |
| `EVOLVER_SESSION_STATE_DIR` | `~/.evolver` | 节流/去重状态存放处。 |
| `EVOLVER_HOOK_LOG_DIR` | `~/.evolver/logs` | 进化面包屑日志存放处。 |

## 开发

```bash
git clone https://github.com/CrazyTomatoOo/evolver-pi-plugin
cd evolver-pi-plugin
npm install
npx tsc --noEmit            # 类型检查（无构建步骤——pi 经 jiti 直接加载 TS）
bun scripts/self-check.ts   # 逻辑自检（临时沙箱，绝不触碰 ~/.evolver）
pi -e .                     # 加载扩展做快速测试
```

完整集成测试——容器里跑真实 pi，对接 mock 模型（无需网络、无需 API key）；
断言三个行为全部触发：

```bash
docker build -f dogfood/Dockerfile -t evolver-dogfood .
docker run --rm evolver-dogfood   # exit 0 = 全部断言通过
```

## 许可

MIT。内置逻辑为原创洁净室移植——**不**源自 GPL 许可的 `@evomap/evolver` 源码。
