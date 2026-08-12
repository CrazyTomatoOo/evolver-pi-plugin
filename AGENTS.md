# evolver-pi-plugin

Evolver — agent self-evolving engine for pi (`@earendil-works/pi-coding-agent`
^0.84.1). A pi **package** that gives pi a persistent, workspace-scoped
evolution memory, interoperable with the EvoMap ecosystem (same
`memory_graph.jsonl` the `@evomap/evolver` engine reads). Clean-room port of
`EvoMap/evolver-claude-code-plugin`. **Local-only edition**: no Hub, no Proxy,
no outbound network.

## Build / Test / Lint / Format

No build step — pi loads the TypeScript directly via jiti. No lint or formatter
is configured; match existing style by hand (tabs, double quotes).

```bash
npm ci                        # reproducible install
npm test                      # 108 Bun contract tests
npm run typecheck             # tsc --noEmit
npm run self-check            # composed core flow in temp sandboxes
npm pack --dry-run            # package metadata sanity
docker build -f dogfood/Dockerfile -t evolver-dogfood .
docker run --rm --network none evolver-dogfood   # 21/21 = pass
```

## Architecture & key abstractions

**Primary seam**: a Pi-independent `CoreCoordinator` (`src/core-coordinator.ts`)
owns domain orchestration; a thin `PiAdapter` (`src/pi-adapter.ts`) only
translates events and effects. Everything fails open — handlers never throw.

`src/index.ts` is composition only: it creates dependencies, the Coordinator,
and registers the Pi adapter. Dependencies are injected so lifecycle behavior is
testable without loading real Pi.

| Module | Responsibility |
| --- | --- |
| `core-coordinator.ts` | Session start/recovery, Recall preparation, mutation-signal accumulation, explicit submission, lifecycle finalization, Ready-outbox drain, status inspection, one-shot announcements. |
| `pi-adapter.ts` | Registers `evolver_outcome` tool + `/evolver-outcome` + `/evolver-status` commands; maps pi events to Coordinator calls; renders the status widget; clears widget on input/shutdown. |
| `session-transition.ts` | Durable per-session state: content-level workspace baseline, accumulated signals, pending Outcome, Ready Outbox, result slots, read-only status inspection. Atomic 0600 writes. |
| `workspace-snapshot.ts` | Canonical manifest of tracked + nonignored untracked paths (path/mode/hash); symlink target hashed without following. |
| `graph-recorder.ts` | Exclusive local lock + check-and-append to `memory_graph.jsonl`; immutable first record; duplicate detection; read-only `inspect`. |
| `recall.ts` | Loads workspace-scoped Graph entries for Recall. |
| `memory.ts` / `filter.ts` | JSONL graph I/O, workspace scoping, Recall filter (success ∧ score ≥ 0.5 ∧ ≤ 7 days ∧ balanced newest 3, ≤ 2 000 chars). |
| `signals.ts` | Advisory signal detection from mutation fragments. |
| `status.ts` | Read-only `StatusSnapshot` types + renderer (12-char prefixes, ≤ 160-char lesson preview, health derivation). |
| `paths.ts` | Forge-resistant `.evolver/workspace-id` (32-hex, `O_EXCL|O_NOFOLLOW`, mode 0600) + memory-graph path resolution. |

### State, lock, and outbox invariants

- **Transition state** (`<stateRoot>/sessions/<wsid>/<session>.json`): baseline,
  signals, pending Outcome. Atomic 0600, symlink + mode guarded.
- **Ready Outbox** (`<stateRoot>/outbox/<wsid>/<diff_hash>.json`): a fully
  validated final record materialized before Graph append; survives lock/IO
  failure; drained before Recall on later starts/boundaries.
- **Result slots** (`<stateRoot>/results/<wsid>.json`): `lastAttempt` (every
  finalization) separate from `lastRecorded` (recorded/duplicate only); no
  TTL/history; duplicate/skip never erase the last append.
- **Graph** (`memory_graph.jsonl`): the sole deduplication truth. Identity is
  `workspaceId + diff_hash` (versioned SHA-256 over ordered start/end
  snapshots), never Session ID. First record immutable.
- **Lock**: `O_EXCL|O_NOFOLLOW` 0600 lock file with stall detection; serializes
  the check-and-append transaction only.

### Dependencies

`@earendil-works/pi-ai` 0.84.1 and `typebox` 1.3.7 are runtime dependencies
(the Outcome tool schema uses `StringEnum`). Pi is a `^0.84.1` peer and a
0.84.1 dev dependency. The dogfood pins pi 0.84.1. Bump all three together.

## Configuration & Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_GRAPH_PATH` | (auto) | Override the memory-graph file location. |
| `EVOLVER_WORKSPACE_ID` | (auto) | Override the workspace-scoping id. |
| `EVOLVER_SESSION_STATE_DIR` | `~/.evolver` | Where durable transition/outbox/result state lives. |

Only these three are read by production code. `MOCK_PORT` is dogfood-only.

## Conventions & gotchas

- **The `memory_graph.jsonl` record shape is a hard external contract** — the
  `@evomap/evolver` engine and the Claude/Cursor siblings read it
  byte-compatibly. Never rename fields (see `filter.ts`).
- **No compile step** — TS is loaded by jiti; keep imports extensionless and
  node built-ins via `node:*`. Explicit `.ts` extensions and bare built-ins
  break loading.
- **No backward compatibility** — remove obsolete paths rather than adding
  compatibility layers. The local-only edition intentionally replaced the
  network layer; do not re-add Hub/Proxy/mailbox/OAuth paths.
- **Outcomes are explicit only** — never classify a verdict from a diff keyword
  or fabricate `stable_success_plateau`. Only a complete explicit submission
  can produce a record.
- **Recall delivers once** — armed on `session_start`, delivered on the next
  `before_agent_start`, idempotent via `workspaceId + recallHash` on the active
  branch. `reload` never finalizes or re-injects.

## References

- `README.md` / `README.zh-CN.md` — user-facing overview (English/Chinese agree).
- `skills/capability-evolver/SKILL.md` — agent capability guidance.
- `docs/agents/` — agent-workflow conventions (issue tracker, triage, domain).
- `docs/research/` — **historical port research only**; labelled as such and
  does not document current runtime behavior.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, each mapped to a same-name label. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — root `CONTEXT.md` plus `docs/adr/`, read before exploring. See `docs/agents/domain.md`.
