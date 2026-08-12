# Evolver — Agent Self-Evolving Engine for pi

English | [中文](./README.zh-CN.md)

Give the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent a
**persistent, auditable evolution memory**. Instead of re-solving the same
problem every session, pi recalls what worked before, notices improvement
signals as it edits, and lets you or the agent explicitly record how each session
turned out — so the next session starts smarter.

A clean-room port of
[`evolver-claude-code-plugin`](https://github.com/EvoMap/evolver-claude-code-plugin)
— same memory-graph format, re-expressed on pi's extension API.
**Local-only edition**: no Hub, no Proxy, no outbound network. The memory graph
stays byte-compatible with the `@evomap/evolver` engine and sibling plugins.

## What it does

Lifecycle events drive one local core; nothing is inferred automatically:

| pi event | Effect |
| --- | --- |
| `session_start` | Arms one **first-turn balanced Recall** (success/failed, ≤ 7 days, score ≥ 0.5, newest-first, max 3, ≤ 2 000 chars) for the next user turn. |
| `before_agent_start` | Drains the Ready Outbox, then delivers the armed Recall once (idempotent across reload/resume/fork via `workspaceId + recallHash`). |
| `tool_result` (`write`/`edit`/`replace`) | Scans successful mutations for advisory signals (`log_error`, `perf_bottleneck`, `capability_gap`, `test_failure`, …). |
| `session_shutdown` (`quit`/`new`/`resume`/`fork`) | Finalizes one explicit pending Outcome into the immutable Graph (`reload` never finalizes). |

Outcomes are **explicit only** — submit a verdict and one reusable lesson via the
`evolver_outcome` tool or `/evolver-outcome` command. Nothing is classified from
a diff keyword or fabricated from the absence of signals.

Memory is **workspace-scoped** via a forge-resistant `.evolver/workspace-id`, so
one project's outcomes never leak into another's. State (baselines, Ready
Outbox, result slots) is atomic mode-0600 and symlink-guarded under
`EVOLVER_SESSION_STATE_DIR`.

## Install

```bash
pi install git:github.com/CrazyTomatoOo/evolver-pi-plugin
```

Restart pi (or `/reload`). **Local memory works with zero config** — no account,
no key, nothing to fill in.

## Commands and tools

| Surface | Name | Purpose |
| --- | --- | --- |
| LLM tool | `evolver_outcome` | `set`/`clear` one verified pending verdict + lesson (Google-compatible flat schema). |
| Slash command | `/evolver-outcome` | Same contract, user-initiated; receipts stay outside model context. |
| Slash command | `/evolver-status` | Render a read-only below-editor widget (refresh on repeat, clears on next input). |

Submission makes no model call and returns no Session message; the receipt is a
local notification only.

## Local storage

| Path | Contents |
| --- | --- |
| `~/.evolver/memory/evolution/memory_graph.jsonl` | Append-only immutable Outcome records (the sole deduplication truth). |
| `~/.evolver/state/sessions/<wsid>/<session>.json` | Per-session baseline, signals, pending Outcome. |
| `~/.evolver/state/outbox/<wsid>/<diff_hash>.json` | Stranded Ready items awaiting Graph append. |
| `~/.evolver/state/results/<wsid>.json` | `lastAttempt`/`lastRecorded` receipt slots + announcement state. |

Inside an evolver-managed repo the graph lands under that project's
`memory/evolution/`.

## Requirements

- **Node.js ≥ 22** — pure TypeScript loaded by pi via jiti; no build step.
- **Git** — workspace snapshots are derived from the working tree.
- **pi `^0.84.1`** — the tested Pi line (pinned in `package.json` and the dogfood).

## Environment variables

Only four are read by production code:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_GRAPH_PATH` | (auto) | Override the memory-graph file location. |
| `EVOLVER_WORKSPACE_ID` | (auto) | Override the workspace-scoping id. |
| `EVOLVER_SESSION_STATE_DIR` | `~/.evolver` | Where durable transition/outbox/result state lives. |

## Verification

```bash
npm ci
npm test                    # 108 Bun contract tests
npm run typecheck           # tsc --noEmit
npm run self-check          # composed core flow in temp sandboxes
npm pack --dry-run          # package metadata sanity
docker build -f dogfood/Dockerfile -t evolver-dogfood .
docker run --rm --network none evolver-dogfood   # 21/21 = pass
```

The Docker gate runs real pi against a loopback mock model with
**`--network none`** — proving no Hub or external-network dependency is required.

## License

MIT. The bundled logic is an original, clean-room port — **not** derived from
the GPL-licensed `@evomap/evolver` source.
