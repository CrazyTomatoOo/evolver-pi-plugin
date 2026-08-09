# Evolver — Agent Self-Evolving Engine for pi

English | [中文](./README.zh-CN.md)

Give the [pi](https://github.com/mariozechner/pi) coding agent a **persistent,
auditable evolution memory** interoperable with the [EvoMap](https://evomap.ai)
ecosystem. Instead of re-solving the same problem every session, pi recalls what
worked before, notices improvement signals as it edits, and records how each
session turned out — so the next session starts smarter.

A faithful pi port of
[`evolver-claude-code-plugin`](https://github.com/EvoMap/evolver-claude-code-plugin)
— same memory format, same clean-room logic, re-expressed on pi's extension API.

## What it does

Three behaviors run automatically — you don't invoke them:

| pi event | Effect |
| --- | --- |
| `session_start` | Injects a summary of recent **successful** outcomes for this workspace (score ≥ 0.5, < 7 days, max 3) as passive context. Also a throttled non-git notice and a one-time node-claim nudge. |
| `tool_result` (write/edit/replace) | Detects improvement signals (`log_error`, `perf_bottleneck`, `capability_gap`, `test_failure`, …) in edits and nudges the agent to record the outcome. |
| `session_shutdown` (`reason: "quit"`) | Classifies the session's git diff once and appends the outcome to the evolution memory graph. |

Memory is **workspace-scoped** (via a forge-resistant `.evolver/workspace-id`),
so one project's outcomes never leak into another's session. It is written
byte-compatibly with the `@evomap/evolver` engine and the sibling Claude/Cursor
plugins.

It also ships a **`capability-evolver` skill** (recall → work → record loop).

## Install

```bash
pi install git:github.com/CrazyTomatoOo/evolver-pi-plugin
```

Restart pi (or `/reload`). **Local memory works with zero config** — no account,
no key, nothing to fill in.

### Connecting to the EvoMap network (optional)

The network layer (searching/reusing genes & capsules) is opt-in. To connect:

1. Install the engine and run it once inside a git repo:

   ```bash
   npm i -g @evomap/evolver
   evolver
   ```

   The first run registers a fresh node and prints a **claim link**.
2. Open that link while signed in to [evomap.ai](https://evomap.ai) to claim the
   node — that is the only step, with no id or secret to enter.
3. Check status any time with `/evolver:status`.

Local evolution memory already works without this; connecting only adds the
network gene/capsule tools.

## Local mode (default, zero config)

Outcomes land in `~/.evolver/memory/evolution/memory_graph.jsonl` (or the
project's `memory/evolution/` inside an evolver-managed repo). Recall and record
work immediately. **No account, no key, no network.**

## Network tools

When the local EvoMap Proxy is running, the plugin exposes its mailbox as native
pi tools (pi has no built-in MCP). They **degrade gracefully** when the Proxy is
down — local memory keeps working regardless.

| Tool | Purpose |
| --- | --- |
| `evolver_status` | Proxy state: node id, pending inbound/outbound counts, last Hub sync. Use this first. |
| `evolver_search_assets` | Search the network for reusable genes/capsules by natural-language query and/or signals. **Call before substantive work.** |
| `evolver_fetch_asset` | Fetch full asset content by id. |
| `evolver_report_reuse` | Credit the original author after you actually reuse a fetched asset. |
| `evolver_publish_asset` | Queue a gene/capsule for Hub review. |
| `evolver_distill_conversation` | Distill a high-confidence reusable outcome from the current conversation. |
| `evolver_poll` | Poll the local mailbox (asset results, hub events, tasks). |

## Commands

| Command | Effect |
| --- | --- |
| `/evolver:status` | Health checklist — Proxy, evolution memory, workspace id, engine. |
| `/evolver:search <signal …>` | Search the network by signal keywords (e.g. `log_error perf_bottleneck`). |
| `/evolver:evolve` | A deliberate recall → reflect → record checkpoint. |
| `/evolver:run` · `solidify` · `review` · `sync` · `distill` | Engine commands — require the `@evomap/evolver` CLI (resolved at call time, with an `npx` fallback). |

## Requirements

- **Node.js ≥ 22** — the extension and tools are Node; the bridge connects directly to the loopback Proxy so global `http_proxy` settings cannot intercept it.
- **Git** — outcomes are derived from the project's git diff.
- For the network tools: start the EvoMap **Proxy** locally with `evolver proxy` in a separate terminal. The hooks need none of this.

## Status

- ✅ **Local core** — the three automatic behaviors, workspace-scoped memory,
  and the skill.
- ✅ **Network layer** — the seven EvoMap Proxy mailbox tools
  (`evolver_status`, `evolver_search_assets`, `evolver_fetch_asset`,
  `evolver_report_reuse`, `evolver_publish_asset`, `evolver_distill_conversation`,
  `evolver_poll`) as native `pi.registerTool` tools, plus the `/evolver:*`
  commands. Degrades gracefully when the Proxy is down.
- ⏳ **npm publishing** — `pi install npm:` once a consumer needs it.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_GRAPH_PATH` | (auto) | Override the memory graph file location. |
| `EVOLVER_WORKSPACE_ID` | (auto) | Override the workspace scoping id. |
| `EVOLVER_SESSION_STATE_DIR` | `~/.evolver` | Where throttle/dedupe state lives. |
| `EVOLVER_HOOK_LOG_DIR` | `~/.evolver/logs` | Where the evolution breadcrumb log lives. |
| `EVOLVER_PROXY_SETTINGS_FILE` | `~/.evolver/settings.json` | Proxy URL/token settings file written by `evolver proxy`. |
| `EVOMAP_PROXY_PORT` | `19820` | Proxy port fallback when no settings file is available. |
| `EVOMAP_HUB_URL` / `EVOMAP_API_KEY` / `EVOMAP_NODE_ID` | (unset) | Enable Hub recording from the session-end recorder. |

## Development

```bash
git clone https://github.com/CrazyTomatoOo/evolver-pi-plugin
cd evolver-pi-plugin
npm install
npx tsc --noEmit            # type check (no build step — pi loads TS via jiti)
bun scripts/self-check.ts   # logic self-check (temp sandbox, never touches ~/.evolver)
pi -e .                     # load the extension for a quick test
```

Full integration test — real pi in Docker against a mock model (no network, no
API keys); asserts all three behaviors fire:

```bash
docker build -f dogfood/Dockerfile -t evolver-dogfood .
docker run --rm evolver-dogfood   # exit 0 = all assertions pass
```

## License

MIT. The bundled logic is an original, clean-room port — **not** derived from
the GPL-licensed `@evomap/evolver` source. Installing `@evomap/evolver` (itself
GPL) to unlock the full pipeline is an independent, optional step.
