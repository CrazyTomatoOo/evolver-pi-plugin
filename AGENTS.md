# evolver-pi-plugin

Evolver — agent self-evolving engine for pi. A pi **package** that gives pi a
persistent, workspace-scoped evolution memory, interoperable with the EvoMap
ecosystem (same `memory_graph.jsonl` the `@evomap/evolver` engine reads).
Faithful, clean-room port of `EvoMap/evolver-claude-code-plugin`.

## Commands

No build step — pi loads the TypeScript directly via jiti. Run in this order:

```bash
npm install                 # deps (typebox is a RUNTIME dependency)
npx tsc --noEmit            # type check (there is no compile/build)
bun scripts/self-check.ts   # logic self-check; temp sandbox, never touches ~/.evolver
pi -e .                     # load the extension in pi for a quick manual check
```

Full integration test — real pi in Docker against a mock model (no network, no
API keys; asserts all three behaviors fire; exit 0 = pass):

```bash
docker build -f dogfood/Dockerfile -t evolver-dogfood .
docker run --rm evolver-dogfood
```

## Architecture

Entry: `src/index.ts` (declared under `pi.extensions` in `package.json`). It
wires three pi events to the ported logic — **everything fails open** (handlers
never throw):

| pi event | behavior | module |
| --- | --- | --- |
| `session_start` | inject recent successful outcomes (`sendMessage`, `deliverAs:"nextTurn"`) | `recall.ts` |
| `tool_result` (`write`/`edit`/`replace`) | detect improvement signals in the edit | `signals.ts` |
| `session_shutdown` (`reason:"quit"`) | classify the git diff once, append one outcome | `record.ts` |

- `paths.ts` — forge-resistant `.evolver/workspace-id` (32-hex, `O_EXCL|O_NOFOLLOW`, mode 0600) + memory-graph path resolution.
- `memory.ts` / `filter.ts` — JSONL graph I/O, workspace scoping, recall filter (success ∧ score ≥ 0.5 ∧ < 7 days ∧ latest 3).
- `skills/capability-evolver/` — the recall → work → record skill, shipped via `resources_discover`.

**Local-only edition** — the network layer (`proxy.ts` / `tools.ts` / `commands.ts`)
was removed. The 7 `evolver_*` mailbox tools and `/evolver:*` commands no longer
exist. If network features are needed later, port them back from
`evolver-claude-code-plugin`; the adapter library (`@evomap/evolver-adapter-public`)
already supports an OAuth `authMode` the Proxy CLI has not wired up yet.

## Conventions & gotchas

- **The `memory_graph.jsonl` record shape is a hard external contract** — the `@evomap/evolver` engine and the Claude/Cursor siblings read it. Do not rename fields (see `record.ts` / `filter.ts`).
- **No runtime dependencies** — `typebox` was removed when the network tools were; do not re-add it unless a new module actually imports it.
- **No compile step** — TS is loaded by jiti; keep imports extensionless and node built-ins via `node:*`.
- Signal keywords, the recall filter, and the workspace-id forging are ported **verbatim** from the reference — prefer matching it over "improving" it.

## References

- `README.md` — user-facing overview, install, environment variables.
- `docs/agents/` — agent-workflow conventions (issue tracker, triage, domain).
- `research/*` branches — port research (reference internals, pi API mapping, network protocol).

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, each mapped to a same-name label. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — root `CONTEXT.md` plus `docs/adr/`, read before exploring. See `docs/agents/domain.md`.
