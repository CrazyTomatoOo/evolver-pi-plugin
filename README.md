# Evolver — Agent Self-Evolving Engine for pi

English | [中文](./README.zh-CN.md)

Give the [pi](https://github.com/mariozechner/pi) coding agent a **persistent,
auditable evolution memory**. Instead of re-solving the same problem every
session, pi recalls what worked before, notices improvement signals as it
edits, and records how each session turned out — so the next session starts
smarter.

A pi port of
[`evolver-claude-code-plugin`](https://github.com/EvoMap/evolver-claude-code-plugin)
— same memory format, same clean-room logic, re-expressed on pi's extension API.
**Local-only edition**: no Proxy, no Hub, no network. The memory graph stays
byte-compatible with the `@evomap/evolver` engine and sibling plugins.

## What it does

Three behaviors run automatically — you don't invoke them:

| pi event | Effect |
| --- | --- |
| `session_start` | Injects a summary of recent **successful** outcomes for this workspace (score ≥ 0.5, < 7 days, max 3) as passive context. |
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

## Local mode (default, zero config)

Outcomes land in `~/.evolver/memory/evolution/memory_graph.jsonl` (or the
project's `memory/evolution/` inside an evolver-managed repo). Recall and record
work immediately. **No account, no key, no network.**

## Requirements

- **Node.js ≥ 22** — the extension is pure Node; no HTTP bridge.
- **Git** — outcomes are derived from the project's git diff.

## Status

- ✅ **Local core** — the three automatic behaviors, workspace-scoped memory,
  and the skill.
- ⏳ **npm publishing** — `pi install npm:` once a consumer needs it.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_GRAPH_PATH` | (auto) | Override the memory graph file location. |
| `EVOLVER_WORKSPACE_ID` | (auto) | Override the workspace scoping id. |
| `EVOLVER_SESSION_STATE_DIR` | `~/.evolver` | Where throttle/dedupe state lives. |
| `EVOLVER_HOOK_LOG_DIR` | `~/.evolver/logs` | Where the evolution breadcrumb log lives. |

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
the GPL-licensed `@evomap/evolver` source.
