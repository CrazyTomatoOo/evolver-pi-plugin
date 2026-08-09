# Evolver —— pi 的代理自进化引擎

[English](./README.md) | 中文

为 [pi](https://github.com/mariozechner/pi) 编码代理提供一套**持久、可审计的进化记忆**，
并与 [EvoMap](https://evomap.ai) 生态互通。pi 不再每个会话都从零重新解决同一个问题——
它会召回此前管用的做法、在编辑时察觉改进信号、记录每次会话的结果，
让下一个会话开局更聪明。

这是 [`evolver-claude-code-plugin`](https://github.com/EvoMap/evolver-claude-code-plugin)
的忠实 pi 移植版——记忆格式相同、洁净室逻辑相同，只是在 pi 的扩展 API 上重新表达。

## 它做什么

三个行为自动运行——你无需调用：

| pi 事件 | 作用 |
| --- | --- |
| `session_start` | 以被动上下文注入本工作区近期**成功**结果的摘要（score ≥ 0.5、< 7 天、最多 3 条）；附带节流的「非 git 仓库」提示和一次性节点认领提示。 |
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

### 接入 EvoMap 网络（可选）

网络层（搜索/复用基因与胶囊）是可选的。接入方式：

1. 安装引擎并在一个 git 仓库里运行一次：

   ```bash
   npm i -g @evomap/evolver
   evolver
   ```

   首次运行会注册一个新节点并打印一个**认领链接**。
2. 登录 [evomap.ai](https://evomap.ai) 后打开该链接认领节点——
   仅此一步，无需填写任何 id 或密钥。
3. 随时用 `/evolver:status` 查看状态。

没有这些，本地进化记忆照常工作；接入只是增加网络基因/胶囊工具。

## 本地模式（默认，零配置）

结果落在 `~/.evolver/memory/evolution/memory_graph.jsonl`
（evolver 托管的项目则落在该项目的 `memory/evolution/` 下）。
召回与记录立即生效。**无需账号、无需密钥、无需网络。**

## 网络工具

当本地 EvoMap Proxy 运行时，插件把它的邮箱暴露为原生 pi 工具
（pi 没有内置 MCP）。Proxy 未运行时这些工具**优雅降级**——本地记忆照常工作。

| 工具 | 用途 |
| --- | --- |
| `evolver_status` | Proxy 状态：节点 id、进出待处理数、上次 Hub 同步时间。先用这个。 |
| `evolver_search_assets` | 按自然语言 query 和/或信号搜索网络上可复用的基因/胶囊。**开工前调用。** |
| `evolver_fetch_asset` | 按 id 获取资产全文。 |
| `evolver_report_reuse` | 在你确实复用了某个资产后，为原作者记功。 |
| `evolver_publish_asset` | 把基因/胶囊排队提交 Hub 审核。 |
| `evolver_distill_conversation` | 从当前会话蒸馏出一个高置信度、可复用的结果。 |
| `evolver_poll` | 轮询本地邮箱（资产结果、Hub 事件、任务）。 |

## 命令

| 命令 | 作用 |
| --- | --- |
| `/evolver:status` | 健康清单——Proxy、进化记忆、工作区 id、引擎。 |
| `/evolver:search <信号 …>` | 按信号关键词搜索网络（如 `log_error perf_bottleneck`）。 |
| `/evolver:evolve` | 一次刻意的 召回 → 反思 → 记录 检查点。 |
| `/evolver:run` · `solidify` · `review` · `sync` · `distill` | 引擎命令——需要 `@evomap/evolver` CLI（调用时解析，带 `npx` 兜底）。 |

## 运行要求

- **Node.js ≥ 22**——扩展与工具是 Node；网桥会直接连接回环 Proxy，因此全局 `http_proxy` 不会拦截它。
- **Git**——结果由项目的 git diff 推导。
- 网络工具需要：在独立终端中用 `evolver proxy` 启动本地 EvoMap **Proxy**。hook 不需要这些。

## 状态

- ✅ **本地核心**——三个自动行为、按工作区隔离的记忆、skill。
- ✅ **网络层**——七个 EvoMap Proxy 邮箱工具
  （`evolver_status`、`evolver_search_assets`、`evolver_fetch_asset`、
  `evolver_report_reuse`、`evolver_publish_asset`、`evolver_distill_conversation`、
  `evolver_poll`）以原生 `pi.registerTool` 工具实现，外加 `/evolver:*` 命令。
  Proxy 未运行时优雅降级。
- ⏳ **npm 发布**——等有消费者需要时再上 `pi install npm:`。

## 环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `MEMORY_GRAPH_PATH` | （自动） | 覆盖记忆图文件位置。 |
| `EVOLVER_WORKSPACE_ID` | （自动） | 覆盖工作区隔离 id。 |
| `EVOLVER_SESSION_STATE_DIR` | `~/.evolver` | 节流/去重状态存放处。 |
| `EVOLVER_HOOK_LOG_DIR` | `~/.evolver/logs` | 进化面包屑日志存放处。 |
| `EVOLVER_PROXY_SETTINGS_FILE` | `~/.evolver/settings.json` | 由 `evolver proxy` 写入的 Proxy URL/token 设置文件。 |
| `EVOMAP_PROXY_PORT` | `19820` | 没有可用设置文件时的 Proxy 端口兜底。
| `EVOMAP_HUB_URL` / `EVOMAP_API_KEY` / `EVOMAP_NODE_ID` | （未设置） | 启用 session-end 记录器的 Hub 上报。 |

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
安装 `@evomap/evolver`（本身 GPL）以解锁完整管线，是一个独立、可选的步骤。
