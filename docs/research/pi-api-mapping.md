# pi Extension API Mapping (wayfinder #3)

Maps each capability the evolver port needs (from the Claude Code reference
plugin) to the concrete pi mechanism, with citations, so a build session can
implement without re-reading the pi docs.

**Scope:** READ-ONLY research. No implementation here.

**Primary sources** (base path
`/Users/crazytomatooo/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/`):

- `docs/extensions.md` — the extension API reference (events, `ExtensionAPI`,
  `ExtensionContext`, custom tools). Cited below as `extensions.md § <heading>`.
- `docs/packages.md` — packaging & distribution (`packages.md § <heading>`).
- `docs/skills.md` — skill layout (`skills.md § <heading>`).
- `examples/extensions/*.ts` — real working extensions (`examples/<file>.ts`).

**Reference plugin capabilities being mapped:** a SessionStart hook injecting
recent-successful-outcome recall context; a PostToolUse(Write/Edit) hook
detecting improvement signals; a Stop hook classifying the session's git diff
into an outcome record; an MCP bridge exposing 6 network tools; a skill; slash
commands; workspace-scoped memory at `~/.evolver`. **pi has NO built-in MCP.**

---

## Mapping table

| Reference concept | pi mechanism | Gotcha |
| --- | --- | --- |
| SessionStart recall hook (inject recent successful outcomes) | `pi.on("session_start")` + `pi.sendMessage({customType, content, display:true})` (no `triggerTurn`) | `before_agent_start` fires **every user prompt**, not once per session — using it re-injects recall each turn and bloats context. `session_start` fires once per session load. |
| PostToolUse(Write/Edit) signal detection | `pi.on("tool_result")`, filter `event.toolName === "write" \|\| "edit"`; read `event.input` / `event.details` | `tool_call` is *pre*-execution (no result yet). Write tools are `write` and `edit`; `read` is not a write. Use `isToolCallEventType`/`isBashToolResult` guards for typed access. |
| Stop hook → classify git diff into outcome record | `pi.on("session_shutdown")` + `pi.exec("git", ["diff", ...])` | `agent_end`/`agent_settled` fire **per run** (many times per multi-prompt session). `session_shutdown` fires once on teardown; gate on `event.reason === "quit"` to skip reload/new/resume/fork. |
| MCP bridge exposing 6 network tools | Native `pi.registerTool({name, label, description, parameters, execute})` — **no MCP server** | pi tools are first-class LLM-callable; no bridge process. Runtime deps must be in `dependencies` (install is `npm install --omit=dev`); core pi pkgs go in `peerDependencies` `"*"`. |
| Skill | `pi.on("resources_discover")` → `{skillPaths:[...]}`, or conventional `skills/` dir; each skill is a dir with `SKILL.md` | Project skills load only after the project is trusted. `SKILL.md` needs `name` + `description` frontmatter. |
| Slash commands | `pi.registerCommand(name, {description, handler})` | Duplicate names across extensions get numeric suffixes (`/review:1`, `/review:2`). |
| Workspace memory `~/.evolver` + stable workspace id | `ctx.cwd` + `CONFIG_DIR_NAME` for project-local paths; `pi.appendEntry()` for session-persistent state; `node:fs`+`os.homedir()` for a home-dir store | `pi.appendEntry` data does **NOT** reach the LLM. pi gives no built-in workspace id — derive one (hash of `ctx.cwd` / git remote). |
| Distribution | `package.json` `pi` key (`{extensions, skills, ...}`) or conventional dirs; `pi install git:` / `npm:` | Include `pi-package` keyword. Pin git refs (tags/commits); updates don't move pinned refs. |

---

## 1. Inject recall context at session start

**Decision:** `session_start` + `pi.sendMessage(...)`. NOT `before_agent_start`.

`before_agent_start` "Fired after user submits prompt, before agent loop"
(`extensions.md § before_agent_start`) — i.e. **per turn**, inside the
user-prompt loop (`extensions.md § Lifecycle Overview`). It can return
`{ message: {customType, content, display}, systemPrompt }` where `message` is
"a persistent message (stored in session, sent to LLM)" and `systemPrompt`
"Replace the system prompt for this turn (chained across extensions)". That is
the right hook for *per-turn instructions* (e.g. `claude-rules.ts` appends a
rules list to `systemPrompt`), but it would re-inject recall context on every
prompt.

`session_start` "Fired when a session is started, loaded, or reloaded"
(`extensions.md § session_start`), once per session, with
`event.reason: "startup" | "reload" | "new" | "resume" | "fork"`. To put
context into the LLM from there, use `pi.sendMessage`: "Inject a custom message
into the session. Custom messages participate in LLM context."
(`extensions.md § pi.sendMessage`). Omit `triggerTurn` so the agent does not
respond immediately — the message just sits in context for the next turn.
(`examples/file-trigger.ts` uses `triggerTurn: true` precisely because it
*wants* an immediate response; recall does not.)

```typescript
// adapted from examples/file-trigger.ts (sendMessage shape) + claude-rules.ts (session_start setup)
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const outcomes = await loadRecentSuccessfulOutcomes(ctx.cwd); // your store
    if (outcomes.length === 0) return;

    pi.sendMessage({
      customType: "evolver-recall",
      content: `Recent successful outcomes in this workspace:\n${outcomes.join("\n")}`,
      display: true,          // show in transcript
      // no triggerTurn -> passive context, LLM sees it next turn without responding now
    });
  });
}
```

`pi.sendMessage` options (`extensions.md § pi.sendMessage`): `deliverAs`
`"steer"` (default) / `"followUp"` / `"nextTurn"`; `triggerTurn: true` only
applies to steer/followUp. For passive recall, defaults are fine.

> If you later want recall to also refresh on every prompt, switch to
> `before_agent_start` returning `{ message: {...} }` — but that is a different
> product decision and costs context each turn.

---

## 2. Detect edits (write/edit observation)

**Decision:** `pi.on("tool_result")`, filter on `event.toolName`.

Event ordering (`extensions.md § Lifecycle Overview`, `§ tool_result`,
`§ tool_execution_start / tool_execution_update / tool_execution_end`):

| Event | When | Payload | Can modify? |
| --- | --- | --- | --- |
| `tool_call` | after `tool_execution_start`, **before** the tool runs | `event.toolName`, `event.toolCallId`, `event.input` (mutable) | Can **block** / mutate input; no result yet |
| `tool_result` | **after** execution finishes, before `tool_execution_end` | `event.toolName`, `event.toolCallId`, `event.input`, `event.content`, `event.details`, `event.isError`, `event.usage` | **Yes** (return partial patch) |
| `tool_execution_end` | after each tool finalized (completion order) | `event.toolCallId`, `event.toolName`, `event.result`, `event.isError` | Observe only |

For a PostToolUse(Write/Edit) analog, **`tool_result`** is the fit: it runs
after the write/edit happened and exposes both the input (path + content/old-new)
and the result. `tool_call` is too early (pre-execution); `tool_execution_end`
works for pure observation but carries less than `tool_result`.

Built-in write tools: the overridable built-ins are
`read, bash, edit, write, grep, find, ls` (`extensions.md § Overriding Built-in
Tools`). Writes are **`write`** and **`edit`**; `read` is a read.

Type guards (`extensions.md § tool_call`, `§ tool_result`):

- `isToolCallEventType("bash", event)` narrows a `tool_call` event so
  `event.input` is typed (e.g. bash → `{command, timeout?}`). "Built-in tools:
  no type params needed."
- `isBashToolResult(event)` narrows a `tool_result` so `event.details` is typed
  as `BashToolDetails`.

```typescript
// adapted from extensions.md § tool_result + § tool_call
import { isToolCallEventType, isBashToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WRITE_TOOLS = new Set(["write", "edit"]);

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (!WRITE_TOOLS.has(event.toolName)) return;

    // event.input  = the tool params (path + content for write; path + edits for edit)
    // event.content / event.details = the result
    const path = (event.input as { path?: string }).path;
    if (!path) return;

    if (detectsImprovementSignal(event.content, event.details)) {
      recordSignal(ctx.cwd, path);
    }
    // return nothing -> result passes through unmodified
  });
}
```

> Confirm the exact `event.input` field names for `write`/`edit` at build time
> by narrowing with `isToolCallEventType("write", event)` (the docs guarantee
> `event.input` is the tool's parameters and is mutable, but do not enumerate
> write/edit field names in prose). Use `ctx.signal` for any nested async work
> so Esc cancels it (`extensions.md § tool_result`).

---

## 3. Record once per session at stop

**Decision:** `pi.on("session_shutdown")` + `pi.exec("git", [...])`.

- `agent_end` "fires when that run ends, but Pi may still auto-retry,
  auto-compact and retry, or continue with queued follow-up messages"
  (`extensions.md § agent_start / agent_end / agent_settled`) — per low-level
  run, NOT once per session.
- `agent_settled` fires when "Pi will not continue running automatically" — but
  still once per *settled run*, so multiple times across a multi-prompt session.
- `session_shutdown` "Fired before a started session runtime is torn down"
  (`extensions.md § session_shutdown`), once per session teardown, with
  `event.reason: "quit" | "reload" | "new" | "resume" | "fork"`. This is the
  Stop-hook analog. `examples/auto-commit-on-exit.ts` uses exactly this event to
  run git on exit.

**Bash API:** yes — `pi.exec(command, args, options?)`: "Execute a shell
command." `const result = await pi.exec("git", ["status"], { signal, timeout })`
→ `result.stdout, result.stderr, result.code, result.killed`
(`extensions.md § pi.exec`). No need for `node:child_process` (though node
built-ins are available, `extensions.md § Available Imports`).

```typescript
// adapted from examples/auto-commit-on-exit.ts (session_shutdown + pi.exec + getEntries)
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "quit") return; // skip reload/new/resume/fork if you only want true exits

    const { stdout: diff, code } = await pi.exec("git", ["diff", "HEAD"]);
    if (code !== 0 || diff.trim().length === 0) return; // not a repo / no changes

    const outcome = classifyDiff(diff);                 // your classifier
    await writeOutcomeRecord(ctx.cwd, outcome);         // your store

    // optional: read the last assistant message for context, as auto-commit-on-exit does
    // const entries = ctx.sessionManager.getEntries();
  });
}
```

> `session_shutdown` is teardown — keep work fast and abort-aware. If outcome
> recording should also survive `/new`, `/resume`, `/fork`, drop the `reason`
> gate (those flows emit `session_shutdown` for the old instance, then
> `session_start` for the new one — `extensions.md § session_before_fork`).

---

## 4. Contribute a skill

**Decision:** bundle a `skills/<name>/SKILL.md` dir and either rely on the
conventional `skills/` dir or return it from `resources_discover`.

`resources_discover` "Fired after `session_start` so extensions can contribute
additional skill, prompt, and theme paths" (`extensions.md § resources_discover`):

```typescript
// extensions.md § resources_discover
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", async (_event, _ctx) => ({
    skillPaths: [join(__dirname, "..", "skills")], // dir containing <name>/SKILL.md
  }));
}
```

Skill layout (`skills.md § Skill Structure`, `§ SKILL.md Format`): "A skill is a
directory with a `SKILL.md` file. Everything else is freeform."

```text
my-skill/
├── SKILL.md        # required: frontmatter + instructions
├── scripts/        # helper scripts
├── references/     # detailed docs loaded on-demand
└── assets/
```

```markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill
...
```

Discovery (`skills.md § Locations`): directories containing `SKILL.md` are found
recursively; packages contribute via `skills/` dirs or `pi.skills` in
`package.json`. **Project skills load only after the project is trusted.** For a
distributed package the conventional `skills/` dir is auto-discovered
(`packages.md § Convention Directories`), so `resources_discover` is only needed
if the skills live outside that dir.

---

## 5. Register commands

**Decision:** `pi.registerCommand(name, {description, handler})`.

`extensions.md § pi.registerCommand(name, options)`; handler context is
`ExtensionCommandContext` (`extensions.md § ExtensionCommandContext`). Handler
signature is `async (args, ctx)`. `ctx` exposes `ctx.sessionManager`,
`ctx.ui.notify/select/confirm/custom`, `ctx.mode` (`"tui"` etc.), and
`ctx.waitForIdle()` ("Wait for the agent to fully settle..."). Optional
`getArgumentCompletions(prefix)` returns `AutocompleteItem[] | null`.

```typescript
// adapted from examples/commands.ts + extensions.md § pi.registerCommand
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("evolver", {
    description: "Show evolver outcome history",
    handler: async (args, ctx) => {
      const rows = await listOutcomes(ctx.cwd, args.trim());
      ctx.ui.notify(rows.join("\n"), "info");
    },
  });
}
```

> Duplicate command names across extensions are all kept with numeric suffixes
> `/review:1`, `/review:2` (`extensions.md § pi.registerCommand`).

---

## 6. Register network tools (replaces the MCP bridge)

**Decision:** native `pi.registerTool(...)`. pi has no MCP; tools are
first-class and LLM-callable directly.

`extensions.md § pi.registerTool(definition)` and `§ Tool Definition`. Works at
load time and after startup (inside `session_start`, command handlers, etc.).
Schema via `typebox` (`Type`); use `StringEnum` from `@earendil-works/pi-ai` for
Google-compatible enums. `execute(toolCallId, params, signal, onUpdate, ctx)`
returns `{ content: [{type:"text", text}], details }`.

```typescript
// adapted from examples/hello.ts + examples/dynamic-tools.ts + extensions.md § Tool Definition
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const searchTool = defineTool({
  name: "evolver_search",
  label: "Evolver Search",
  description: "Search the evolver outcome index (shown to LLM)",
  promptSnippet: "Query past improvement outcomes for this workspace",
  promptGuidelines: ["Use evolver_search when the user asks what worked before here."],
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    limit: Type.Optional(Type.Number({ description: "Max results" })),
  }),
  async execute(_toolCallId, params, signal, onUpdate, _ctx) {
    if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
    onUpdate?.({ content: [{ type: "text", text: "Searching..." }], details: { progress: 50 } });

    const results = await fetchOutcomes(params.query, params.limit, { signal }); // your network call
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      details: { count: results.length },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(searchTool); // repeat for all 6 network tools
}
```

Notes:

- `promptGuidelines` must each name the tool ("Use evolver_search when...", not
  "Use this tool when...") — `extensions.md § pi.registerTool`.
- `pi.exec(cmd, args, {signal})` is available inside `execute` for shelling out
  (`extensions.md § Tool Definition`).
- `prepareArguments(args)` is an optional pre-validation shim for legacy shapes.

---

## 7. Workspace scoping + persistence

Three distinct stores; pick per use case:

**(a) Project-local files** — `ctx.cwd` + `CONFIG_DIR_NAME`.
`ctx.cwd` = "Current working directory" (`extensions.md § ctx.cwd`). "Use
`CONFIG_DIR_NAME` instead of hardcoding `.pi`... Rebranded distributions can use
a different config directory name."

```typescript
// extensions.md § ctx.cwd
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

pi.on("session_start", (_event, ctx) => {
  const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "evolver.json");
});
```

**(b) Session-persistent state** — `pi.appendEntry(customType, data?)`.
"Persist extension data. Custom entries do NOT participate in LLM context."
Restore on `session_start` by scanning `ctx.sessionManager.getEntries()` for
`entry.type === "custom" && entry.customType === ...` and reading `entry.data`
(`extensions.md § pi.appendEntry`; see `examples/tools.ts` which persists a
`tools-config` entry and restores it from `ctx.sessionManager.getBranch()`).

```typescript
// adapted from examples/tools.ts
pi.appendEntry("evolver-state", { lastOutcomeId: "abc" });

pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "evolver-state") {
      // reconstruct from entry.data
    }
  }
});
```

**(c) Cross-session workspace store (`~/.evolver` analog)** — plain node. Node
built-ins (`node:fs`, `node:path`, `node:os`) are available
(`extensions.md § Available Imports`). pi exposes **no built-in workspace id**,
so derive a stable one (e.g. hash of `ctx.cwd`, or the git remote URL) and key a
home-dir store under `os.homedir()`:

```typescript
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

function workspaceId(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}
const storeDir = join(homedir(), ".evolver", workspaceId(ctx.cwd));
```

> Gotcha: `pi.appendEntry` never reaches the LLM (good for internal state);
> `pi.sendMessage` does (good for recall). Don't confuse the two.

---

## 8. Package structure + distribution

**Decision:** a pi package with a `pi` manifest (or conventional dirs),
installed via `pi install git:` / `npm:`.

`packages.md` intro: "Pi packages bundle extensions, skills, prompt templates,
and themes... A package can declare resources in `package.json` under the `pi`
key, or use conventional directories."

**Manifest** (`packages.md § Creating a Pi Package`) — include the `pi-package`
keyword for discoverability; paths relative to package root; arrays support
globs + `!exclusions`:

```json
{
  "name": "evolver-pi-plugin",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

**Conventional dirs** (auto-discovered if no `pi` manifest,
`packages.md § Convention Directories`): `extensions/` (`.ts`/`.js`), `skills/`
(recursive `SKILL.md` folders + top-level `.md`), `prompts/` (`.md`), `themes/`
(`.json`). So a skill bundled alongside an extension is just `skills/<name>/SKILL.md`
next to `extensions/*.ts`.

**Dependencies** (`packages.md § Dependencies`, `extensions.md § Available Imports`):

- Third-party runtime deps → `dependencies`; pi runs `npm install` on install.
- Install is production: `npm install --omit=dev` by default, so **`devDependencies`
  are NOT available at runtime** — runtime deps must be in `dependencies`.
- Core pi packages you import (`@earendil-works/pi-ai`, `pi-agent-core`,
  `pi-coding-agent`, `pi-tui`, `typebox`) → `peerDependencies` with `"*"`; do NOT
  bundle them (pi bundles them).
- Other pi packages → `dependencies` + `bundledDependencies`, referenced via
  `node_modules/` paths.

**Install / distribute** (`packages.md § Install and Manage`, `§ Package Sources`):

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1     # refs are pinned tags/commits
pi install https://github.com/user/repo     # raw URLs work
pi install ./relative/path/to/package       # local dev
pi -e git:github.com/user/repo              # try without installing (temp, one run)
pi remove npm:@foo/bar
pi list
pi update --extensions                      # reconcile packages / pinned git refs
```

- `install`/`remove` write to user settings `~/.pi/agent/settings.json`;
  `-l` writes project settings `.pi/settings.json` (shared; pi auto-installs
  missing packages on startup once the project is trusted).
- npm installs land under `~/.pi/agent/npm/` (global) / `.pi/npm/` (project);
  git clones under `~/.pi/agent/git/<host>/<path>` / `.pi/git/<host>/<path>`.
- Pinned git refs are NOT moved by `pi update`; use
  `pi install git:host/user/repo@new-ref` to move a ref.

---

## Porter's cheat-sheet (the 3 decisions that matter most)

1. **Recall injection = `session_start` + `pi.sendMessage` (no `triggerTurn`).**
   Do not use `before_agent_start` — it fires every prompt and would re-inject
   recall each turn. (`§1`)
2. **Outcome record = `session_shutdown` (gate `reason === "quit"`) + `pi.exec("git", [...])`.**
   `agent_end`/`agent_settled` fire per run, not per session. (`§3`)
3. **No MCP — the 6 network tools are native `pi.registerTool` tools.** Runtime
   deps in `dependencies` (install is `--omit=dev`); core pi packages in
   `peerDependencies` `"*"`. (`§6`, `§8`)
