# Reference Plugin Internals — `EvoMap/evolver-claude-code-plugin`

**Purpose (wayfinder ticket #2):** everything a future build session needs to port this
Claude Code plugin to pi, without re-reading the source. Every claim cites `path:line`.

**Primary source:** `/tmp/pi-github-repos/EvoMap/evolver-claude-code-plugin`
(clone of `https://github.com/EvoMap/evolver-claude-code-plugin`).

**Scope note / correction:** the ticket lists 6 MCP tools; the code actually ships **7** —
`evolver_report_reuse` is the extra one (`mcp/evolver-proxy.mjs:157`). All 7 are documented below.

---

## 0. Orientation

File layout (non-`.git`):

```
.claude-plugin/plugin.json        plugin manifest + userConfig
.claude-plugin/marketplace.json   marketplace entry
.mcp.json                         MCP server declaration
hooks/hooks.json                  event → hook wiring
hooks/session-start.js            SessionStart hook
hooks/signal-detect.js            PostToolUse hook
hooks/session-end.js              Stop hook
hooks/_filter.js                  recall relevance filter (shared)
hooks/_paths.js                   path/workspace-id helpers (shared)
hooks/_signals.js                 signal taxonomy + detector (shared)
mcp/evolver-proxy.mjs             zero-dep stdio MCP bridge
skills/capability-evolver/SKILL.md
commands/{evolve,search,status,run,solidify,review,sync,distill}.md
```

Runtime model:

- Pure Node.js built-ins, **zero external dependencies** (`hooks/_paths.js:4`,
  `mcp/evolver-proxy.mjs:3`). Hooks `require()` only `fs/os/path/crypto/child_process`.
- Requires **Node ≥ 18** (the bridge uses global `fetch`) and **git** (outcomes are derived
  from git diffs) — `README.md` "Requirements".
- Every hook is a stdio script: reads a JSON object on stdin, writes one JSON object on
  stdout, exits 0, and **fails open to `{}`** on any error (e.g. `hooks/session-start.js:44-62`,
  `hooks/session-end.js:48-63`). Each drains stdin against a watchdog timer so it always exits
  promptly (`hooks/session-start.js:316-352`).
- Hooks never spawn the `@evomap/evolver` engine; they only record memory the engine later
  consumes (`README.md` "Full engine + Proxy", `skills/capability-evolver/SKILL.md:60-75`).

---

## 1. Hooks — exact logic

### 1.1 Event wiring — `hooks/hooks.json`

Claude Code plugin hook contract; three events, each a `command` hook running node against
`${CLAUDE_PLUGIN_ROOT}`:

| Event | Matcher | Command | Timeout |
| --- | --- | --- | --- |
| `SessionStart` | — | `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.js"` | 5s (`hooks/hooks.json:3,8,9`) |
| `PostToolUse` | `Write\|Edit\|MultiEdit` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/signal-detect.js"` | 3s (`hooks/hooks.json:14,16,20,21`) |
| `Stop` | — | `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-end.js"` | 10s (`hooks/hooks.json:26,31,32`) |

**Port note:** pi must re-express these three event bindings in its own hook format. The
`PostToolUse` matcher restricts firing to file-mutating tools only.

### 1.2 `hooks/session-start.js` (SessionStart) — recall + nudges

`main()` (`hooks/session-start.js:243`) assembles up to three text `parts`, joined with
`\n\n` (`:293`), and emits them as injected context. Output shape (`:296-301`):

```js
emit({
  additionalContext: joined,
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: joined },
});
```

**Part 1 — non-git notice (throttled).** If `!isGitWorkspace(currentDir)`, push `NONGIT_NOTICE`
(`:31-34`) unless `throttled('nongit:'+currentDir, NONGIT_TTL_MS)` (`:247-256`).
`NONGIT_TTL_MS = 30 min` (`:27`).

**Part 1b — one-time node-claim nudge (throttled).** `readPendingClaimUrl()` (`:115-127`) reads
`~/.evomap/claim_url` (`:117`), returns it only if it matches `/^https?:\/\//` (`:121`), else
`null` (fails closed). If a URL exists and `!throttled('claim:'+claimUrl, CLAIM_TTL_MS)`
(`:258-273`), push a nudge telling the user to open the link while signed in to evomap.ai
(`:261-268`). `CLAIM_TTL_MS = 12 h` (`:28`). This is the "throttled one-time node-claim nudge."

**Throttle mechanism** — `throttled(key, ttlMs)` (`:65-96`): a JSON map `key → last-fired epoch`
persisted at `<base>/session-start-state.json` (`:70`) where
`base = EVOLVER_SESSION_STATE_DIR || ~/.evolver` (`:67-69`). Returns `true` (suppress) if the key
fired within `ttlMs` (`:79-81`); otherwise records `now`, prunes entries older than
`THROTTLE_PRUNE_MS = 24 h` (`:29`, `:84-89`), and returns `false`. Fails open (`:94`).

**Part 2 — workspace-scoped evolution memory (the recall).**

1. `graphPath = findMemoryGraph(currentDir)` (`:276`; see §2).
2. `currentId = resolveWorkspaceId(currentDir)` (`:277`; see §2).
3. `candidates = gatherWorkspaceEntries(graphPath, currentId, currentDir)` (`:278`).
4. `relevant = filterRelevant(candidates)` (`:279`; the recall filter, §1.5).
5. If any, push `formatSummary(relevant)` (`:280-282`).

`gatherWorkspaceEntries` (`:166-197`) reads the JSONL, scans **newest→oldest** (from the end,
`:172`), keeps entries where `belongsToWorkspace(...)` is true, stops after
`MAX_SCAN_ENTRIES = 5` (`:25`, `:189`), then `reverse()`s to chronological order (`:195`).
Malformed lines are skipped (`:178-181`).

`belongsToWorkspace(entry, currentId, currentDir)` (`:140-159`) — the scoping rule that prevents
cross-project leakage:

- entry has `workspace_id` and our id is known → match iff equal (`:155`);
- entry has `workspace_id` but our id is UNKNOWN → fall back to cwd match (do **not**
  blanket-include) (`:144-153`);
- entry has `cwd` → match iff equal, lenient only when currentDir unknown (`:157-162`);
- untagged (legacy) → always include (`:163`).

`formatSummary(outcomes)` (`:202-241`): counts successes/failures, builds header
`[Evolution Memory] Recent N outcomes (S success, F failed):` (`:212-214`), one row per outcome
`[icon] YYYY-MM-DD score=X signals=[a, b, c] note` (`:216-235`, icon `+`/`-`/`?`), each row
truncated to `LINE_MAX = 200` (`:26`, `:234`), and appends the footer
`Use successful approaches. Avoid repeating failed patterns.` (`:239`).

### 1.3 `hooks/signal-detect.js` (PostToolUse on Write/Edit/MultiEdit)

`process_(raw)` (`hooks/signal-detect.js:75`):

1. `content = extractContent(input)` (`:84`).
2. `signals = detectSignals(content)` (`:86`; taxonomy in §1.5).
3. If no signals → `emit({})` (`:88-91`).
4. Else emit context (`:93-103`):

```js
const ctx = `[Evolution Signal] Detected: [${signals.join(', ')}] in ${where}. `
          + 'Consider recording this outcome.';
emit({ additionalContext: ctx,
       hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx } });
```

`extractContent(input)` (`:40-55`) pulls the edited text from any of Claude Code's shapes, in
order: `tool_input.content`, `tool_input.new_string`, `tool_input.file_text`,
`tool_input.file_content` (`:46-49`), then flat `input.content`, `input.file_content`,
`input.diff` (`:51-53`). **It scans the edited/new content itself, not a git diff** — this is a
substring scan over the just-written text.

`extractFilePath(input)` (`:60-73`) for the "in <where>" label: `tool_input.file_path`
(`:65-66`), `tool_response.filePath` (`:69-70`), `input.path`, `input.file_path`; falls back to
`'edited file'` (`:93`). Stdin watchdog is 1500 ms (`:16`).

### 1.4 `hooks/session-end.js` (Stop) — classify diff, append outcome

Entry `run()` (`hooks/session-end.js:391`): parse stdin, `projectDir = resolveProjectDir(input)`,
`diff = collectDiff(projectDir)`, then `finish(projectDir, diff, input)` (`:404-411`).

**`collectDiff(projectDir)`** (`:103-130`) — classifies the **working-tree + staged** diff once:

- `git rev-parse --is-inside-work-tree` → `isRepo` (`:104-105`); if not a repo returns empty
  (`:106-112`).
- stat: `git diff --stat --` (unstaged, `:115`) + `git diff --cached --stat --` (staged, `:119`),
  concatenated.
- body: `git diff --no-color --` (`:127`) + `git diff --cached --no-color --` (`:131`),
  concatenated.
- All git calls go through `git(args, cwd)` (`:79-101`) with `GIT_TIMEOUT_MS = 5000` (`:27`) and
  a 10 MB maxBuffer (`:28`).

**`finish(projectDir, diff, input)`** (`:303-389`):

1. `stats = parseStat(diff.statText)` (`:304`; `parseStat` at `:145-158` sums
   `N files changed`, `N insertions(+)`, `N deletions(-)` via regex).
2. **No changes** (`!hasChanges`) → append a breadcrumb to the evolution log and `emit({})`;
   **never** a memory-graph entry (`:308-318`).
3. Resolve `workspaceId` (`:320`), `sessionId = extractSessionId(input)` (`:321`, tries many
   field names `:173-198`), `diffHash = hashText(diff.body || diff.statText)` (`:322`, sha256 —
   `:160-162`).
4. **Once-per-session dedupe:** `claimSessionRecord({...})` (`:323-329`, impl `:200-249`) keys on
   `session:<id>` or `workspace:<id>:diff:<hash>` in `<base>/session-end-state.json` (`:205`,
   `base = EVOLVER_SESSION_STATE_DIR || ~/.evolver`); suppresses if seen within
   `SESSION_END_DEDUPE_TTL_MS` default **6 h** (`:30-33`, env-overridable). If not claimed →
   breadcrumb + `emit({})` (`:330-335`). Atomic write via tmp+rename, mode 0600 (`:243-245`).
5. **Derive signals/status/score** (`:337-342`):
   - `signals = detectSignals(diff.body)`; if empty → `['stable_success_plateau']` (`:338`).
   - `failed = signals.includes('log_error') || signals.includes('test_failure')` (`:340`).
   - `status = failed ? 'failed' : 'success'` (`:341`).
   - `score = failed ? 0.3 : 0.8` (`:342`).
   - `summary = "Session end: F files changed, +I/-D. Signals: [...]"` (`:344-347`).
6. **Hub path (optional):** `recordToHub(payload)` (`:349-359`, impl `:255-285`). Reads
   `hubUrl = EVOMAP_HUB_URL || A2A_HUB_URL` (`:257`) and
   `apiKey = EVOMAP_API_KEY || A2A_NODE_SECRET` (`:258`); if either missing or no `fetch`, returns
   false (no-op). POSTs to `<hub>/a2a/evolution/record` (`:262`) with
   `Authorization: Bearer <apiKey>` (`:273`), 8 s timeout (`HUB_TIMEOUT_MS`, `:29`, `:264-266`).
   Payload fields: `gene_id:'ad_hoc', signals, status, score, summary, session_id, workspace_id,
   diff_hash, sender_id` where `sender_id = EVOMAP_NODE_ID || A2A_NODE_ID` (`:350-358`).
7. **Local path (always attempted):** `recordToLocal(entry, projectDir)` (`:362-376`, impl
   `:292-301`) appends one JSON line to the memory graph (schema in §2). The field shape is a
   **hard contract** consumed by the engine and the sibling Cursor plugin — comment at
   `:286-290`.
8. Emit `{ systemMessage: receipt }` naming the destination (Hub / local memory / nowhere)
   (`:378-388`).

### 1.5 Shared helpers

**`hooks/_filter.js` — the recall filter.** Constants: `SEVEN_DAYS_MS` (`:9`),
`MIN_SCORE = 0.5` (`:10`), `MAX_RESULTS = 3` (`:11`). `filterRelevant(entries)` (`:34-63`) keeps an
entry iff **all** hold: `outcome.status === 'success'` (`:44`), `outcome.score >= 0.5` (`:47`),
timestamp within `[now-7d, now]` (`:54`, parsed by `timestampMs` `:16-22`). Input arrives
chronological; it keeps the **tail** (latest 3) via `relevant.slice(relevant.length - MAX_RESULTS)`
(`:60`). → This is exactly "successful outcomes: score ≥ 0.5, < 7 days old, max 3."

**`hooks/_signals.js` — signal taxonomy + detector.** `SIGNAL_KEYWORDS` (`:12-66`) maps **7
categories** to lowercase trigger phrases; a category fires if any phrase is a substring of the
lowercased text:

| Category (line) | Trigger phrases |
| --- | --- |
| `perf_bottleneck` (`:13`) | timeout, slow, latency, bottleneck, oom, out of memory, performance |
| `capability_gap` (`:22`) | not supported, unsupported, not implemented, missing feature, not available |
| `log_error` (`:29`) | error:, exception:, typeerror, referenceerror, syntaxerror, failed |
| `user_feature_request` (`:37`) | add feature, implement, new function, new module, please add |
| `recurring_error` (`:44`) | same error, still failing, not fixed, keeps failing, repeatedly |
| `deployment_issue` (`:51`) | deploy failed, build failed, ci failed, pipeline, rollback |
| `test_failure` (`:58`) | test failed, test failure, assertion, expect(, assert. |

`detectSignals(text)` (`:86-118`): builds a **prose-only corpus** by dropping lines that
`looksLikeCode` (`:71-81`) — i.e. trimmed lines starting with any of
`CODE_LINE_PREFIXES = ['//','#','*','{','[','}',']','/*']` (`:69`) — lowercases it (`:92-100`),
then substring-matches each category (`:105-114`) and returns a **sorted, de-duplicated** array
(`:117`). (The SKILL.md signal table lists only 6; the code's 7th is `recurring_error` — code is
authoritative.)

**`hooks/_paths.js` — path + workspace helpers** (all defensive, never throw; `:4-6`):

- `resolveProjectDir()` (`:44-54`): `CURSOR_PROJECT_DIR` → `CLAUDE_PROJECT_DIR` → `process.cwd()`,
  each env choice accepted only if it names an existing directory (`looksLikeDir`, `:25-38`).
- `isGitWorkspace(dir)` (`:61-84`): shells `git rev-parse --is-inside-work-tree`, 5 s timeout.
- `findMemoryGraph(projectDir)` (`:95-133`): `MEMORY_GRAPH_PATH` override (`:96`) →
  `<projectDir>/memory/evolution/memory_graph.jsonl` **only if it already exists** (`:100-114`) →
  user-level `~/.evolver/memory/evolution/memory_graph.jsonl` (parent best-effort created,
  `:115-132`). See §2.
- `resolveWorkspaceId(projectDir)` — see §2.

---

## 2. `memory_graph.jsonl` schema + `.evolver/workspace-id` forging

### 2.1 Outcome record schema

Written by `recordToLocal` (`hooks/session-end.js:292-301`) as one JSON object per line
(`JSON.stringify(entry) + '\n'`, `:298`). Field shape is a hard external contract
(`:286-290`). Fields (from the entry literal `:363-374`):

| Field | Type | Value / source |
| --- | --- | --- |
| `timestamp` | string (ISO 8601) | `new Date().toISOString()` (`:364`) |
| `gene_id` | string | always `'ad_hoc'` (`:365`) |
| `signals` | string[] | `detectSignals(diff.body)`, default `['stable_success_plateau']` (`:338`, `:366`) |
| `outcome` | object | `{ status, score, note }` (`:367`); `status` ∈ `success`/`failed` (`:341`), `score` ∈ `0.8`/`0.3` (`:342`), `note` = summary string (`:344-347`) |
| `cwd` | string | `projectDir` (`:368`) |
| `workspace_id` | string\|null | `resolveWorkspaceId(projectDir)` (`:369`; §2.2) |
| `session_id` | string\|null | `extractSessionId(input)` (`:370`) |
| `diff_hash` | string | sha256 hex of `diff.body | | diff.statText`(`:371`,`:160-162`,`:322`) |
| `diff_scope` | string | always `'working_tree'` (`:372`) |
| `source` | string | always `'hook:session-end'` (`:373`) |

**Example line (failed outcome):**

```json
{"timestamp":"2026-01-15T10:30:00.000Z","gene_id":"ad_hoc","signals":["log_error","test_failure"],"outcome":{"status":"failed","score":0.3,"note":"Session end: 3 files changed, +45/-12. Signals: [log_error, test_failure]"},"cwd":"/Volumes/work/Project/example","workspace_id":"3f8a1c9e7b2d4f6a0e5c8d1b9a7f3e2c","session_id":"01JSESSIONABC123","diff_hash":"9f2c1a4b7e8d3f60512abcde9876543210fedcba1234567890abcdef12345678","diff_scope":"working_tree","source":"hook:session-end"}
```

**Example line (success outcome, no detected signals):**

```json
{"timestamp":"2026-01-15T11:02:10.000Z","gene_id":"ad_hoc","signals":["stable_success_plateau"],"outcome":{"status":"success","score":0.8,"note":"Session end: 2 files changed, +30/-5. Signals: [stable_success_plateau]"},"cwd":"/Volumes/work/Project/example","workspace_id":"3f8a1c9e7b2d4f6a0e5c8d1b9a7f3e2c","session_id":"01JSESSIONDEF456","diff_hash":"1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809","diff_scope":"working_tree","source":"hook:session-end"}
```

(Example ids/hashes are illustrative; field names, types, and the `note` format are exact —
`note` format from `hooks/session-end.js:344-347`.)

**Graph file location** (`hooks/_paths.js:95-133`): `MEMORY_GRAPH_PATH` env override →
`<projectDir>/memory/evolution/memory_graph.jsonl` (only if it already exists; the plugin never
creates a project-local graph in an arbitrary folder) → `~/.evolver/memory/evolution/memory_graph.jsonl`.

### 2.2 `.evolver/workspace-id` forging (`hooks/_paths.js`)

`resolveWorkspaceId(projectDir)` (`:235-323`) resolves or lazily creates a **forge-resistant**
workspace identifier. Documented contract (`:227-231`): file path
`<workspaceRoot>/.evolver/workspace-id`, file mode `0600`, format a single 32+ char hex string.

Algorithm:

1. **Env override:** `EVOLVER_WORKSPACE_ID` wins if set (`:237-240`).
2. **Compute workspace root** — `computeWorkspaceRoot(projectDir)` (`:208-224`):
   `OPENCLAW_WORKSPACE` env if set (`:209-212`) → else the git repo root above `projectDir`
   (`findRepoRoot`, `:135-156`, walks up looking for a `.git` entry, 256-step guard); if that root
   has a `workspace/` subdir use it (`:217-220`), else the root itself; if no repo root, fall back
   to `projectDir` (`:213-215`).
3. **Read existing trusted file** — `readWorkspaceIdFile(dotEvolverDir, idFile)` (`:165-199`):
   - refuses if the `.evolver` **directory** is a symlink (`:171-176`);
   - refuses if the id file is a symlink or not a regular file (`:182-186`);
   - reads + trims, accepts only if it matches `WORKSPACE_ID_PATTERN = /^[a-f0-9]{32,}$/i`
     (`:19`, `:193-196`).
   - If present-but-invalid → return **null** ("unknown"), never clobber (`:255-259`).
4. **Create if genuinely missing** (`:262-318`): re-check the `.evolver` symlink guard (`:264-271`),
   `mkdirSync(.evolver, recursive)` (`:273`), then generate
   `crypto.randomBytes(16).toString('hex')` → 32 hex chars (`:274`), and open the file with
   `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` at mode `0600` (`:280-284`) — **O_EXCL** fails rather
   than overwrite a racing writer, **O_NOFOLLOW** fails rather than follow a symlink. On `EEXIST`
   race, re-read through the same guards (`:286-291`). Finally `chmodSync(idFile, 0600)` to defeat a
   loose umask (`:305-307`).
5. Any failure degrades to `null` ("unknown workspace") — never throws (`:319-322`).

**What makes it forge-resistant:** cryptographically random 128-bit id; symlink guards on both the
`.evolver` dir and the id file; `O_NOFOLLOW` + `O_EXCL` atomic create; `0600` permissions; strict
hex-pattern validation; and a refuse-don't-clobber policy for present-but-suspicious files.

---

## 3. MCP bridge — `mcp/evolver-proxy.mjs`

Zero-dependency **stdio** MCP server: newline-delimited JSON-RPC 2.0 over stdin/stdout, all
diagnostics to stderr (`:5-11`). `SERVER = { name:'evolver-proxy', version:'0.2.0' }` (`:22`).
It **never spawns** the Proxy; when the Proxy is down, tools return a helpful error (`:12-13`).

### 3.1 How it finds and talks to the local Proxy

- **Default URL:** `http://127.0.0.1:${EVOMAP_PROXY_PORT || '19820'}` (`defaultProxyUrl`, `:27-29`).
- **Live settings (authoritative):** `readProxySettings()` (`:61-73`) re-reads
  `~/.evolver/settings.json` **on every call** (`:64`): `url = s.proxy.url` (`:65`),
  `token = s.proxy.token` (`:66`). The running Proxy writes both there and rotates the token on
  restart (`:55-60`). If no url, fall back to the default URL with a **null** token (`:68-71`).
- **Loopback guard:** `normalizeLocalProxyUrl` (`:41-53`) only accepts `http:`/`https:` URLs whose
  host `isLoopbackHost` (`:31-39`: `localhost`, `127.0.0.1`, `::1`, `*.localhost`) — the bridge
  will only ever talk to a local Proxy.
- **Request:** `proxyFetch(method, path, body)` (`:75-113`): 8 s abort timeout (`:78`),
  `Content-Type: application/json` for bodies (`:80`), `Authorization: Bearer <token>` when a token
  exists (`:82`). Recent Proxy builds reject unauthenticated local requests with 401 (`:57-58`).
- **Graceful degradation:** non-OK responses return `{ ok:false, error }` with actionable hints —
  401/403 → stale/missing token advice (`:95-99`), 404 → "may not be the Evolver Proxy" (`:100-101`);
  network failure/timeout → "Proxy not reachable … run `evolver` once in a git repo" (`:114-117`).
  Tool results map to MCP content: `ok` → pretty JSON, else the error string, with `isError`
  (`:339-343`).

### 3.2 The 7 tools (`TOOLS` array, `:115-235`)

| Tool (line) | Params | Proxy endpoint | Returns / notes |
| --- | --- | --- | --- |
| `evolver_status` (`:116`) | none (`:118`) | `GET /proxy/status` (`:119`) | Running state, `node_id`, pending inbound/outbound counts, last Hub sync. "Use this first." |
| `evolver_search_assets` (`:122`) | `query` (string, semantic), `signals` (string[]), `mode` (`semantic`\|`exact`, default `semantic`), `limit` (1–25, default 5) (`:124-133`) | `POST /asset/search` (`:134-136`) | Genes/Capsules matching the task. "Call BEFORE substantive work." At least one of query/signals expected. |
| `evolver_fetch_asset` (`:139`) | `asset_ids` (string[], required, minItems 1) (`:141-145`) | `POST /asset/fetch` (`:148`) | Full asset content by id; **adds** a top-level `_reuse_hint` nudging `evolver_report_reuse` (`:150-154`). |
| `evolver_report_reuse` (`:157`) | `asset_ids` (required), `outcome` (`success`\|`failed`, default success), `signals` (optional) (`:159-168`) | `POST /asset/report-reuse` → body `{ used_asset_ids, status, signals }` (`:169`) | Credits original authors / feeds reuse-reward network. **(This is the 7th tool not in the ticket.)** |
| `evolver_publish_asset` (`:172`) | `assets` (array, minItems 1, of `{ type: Gene\|Capsule, content (req), summary, signals[] }`) (`:174-191`) | `POST /asset/submit` (`:194`) | Queues assets locally; Proxy syncs to Hub in background; poll via `evolver_poll` for `asset_submit_result`. |
| `evolver_distill_conversation` (`:197`) | `summary` (required) + `title, platform (default claude-code), thread_id, user_prompt, assistant_summary, transcript, signals[], strategy[], artifacts[], validation[], persist (default true), publish (default true), min_score (1–10, default 5)` (`:199-219`) | `POST /conversation/distill` (`:220`) | Proxy quality-gates, stores locally, queues Hub publishing. |
| `evolver_poll` (`:223`) | `type` (e.g. `asset_submit_result`), `limit` (1–50, default 10) (`:225-232`) | `POST /mailbox/poll` (`:233`) | Polls local mailbox by type; returns and does **not** auto-acknowledge. |

### 3.3 JSON-RPC plumbing

`dispatch(req)` (`:255-281`): `initialize` → protocol version (default `2025-06-18`, `:23`),
`capabilities:{tools:{}}`, `serverInfo`, `instructions` (`:263-272`); `notifications/initialized`,
`initialized` → no response (`:273-274`); `ping` → `{}` (`:275-276`); `tools/list` → the tool
metadata (`:275-276`); `tools/call` → `handleToolCall` (`:277-278`, impl `:331-344`); unknown →
`-32601` (`:280`). In-flight requests are counted so the process never exits on stdin close while a
reply is pending (`pending`/`maybeExit`, `:285-289`).

---

## 4. Skill — `skills/capability-evolver/SKILL.md`

Frontmatter: `name: capability-evolver` (`:2`), `description` triggers on non-trivial work or
"evolve"/"learn from this"/"remember how this went" (`:3`).

**The recall → work → record loop** ("What you (the agent) should do", `:31-44`), verbatim structure:

1. **Before starting** — check the injected evolution memory (arrives as session-start context);
   reuse a matching recent success, avoid a matching recent failure (`:35-37`).
2. **Do the work.** (`:38`)
3. **After finishing** — the `Stop` hook records the outcome automatically; the agent need not call
   anything, but should surface a one-line lesson in its final message so it lands in the diff the
   hook reads (`:39-43`). Trivial/conversational turns skip this (`:44`).

"How it works (automatic)" (`:13-29`) describes the three hooks: `SessionStart` injects recent
**successful** outcomes "filtered to score ≥ 0.5, < 7 days old, max 3" (`:17-18`); `PostToolUse`
scans edits for signals (`:20-22`); `Stop` collects the git diff, classifies, appends,
workspace-scoped (`:23-26`). Memory lands in `~/.evolver/memory/evolution/memory_graph.jsonl` or the
project's `memory/evolution/` (`:27-29`).

Signals table (`:46-58`) lists 6 (log_error, perf_bottleneck, capability_gap, user_feature_request,
test_failure, deployment_issue). "Full pipeline (optional)" (`:60-75`): `npm install -g @evomap/evolver`
(`:68`) unlocks the engine CLI; hooks do not auto-invoke it. "MCP tools" (`:77-92`): use
`evolver_search_assets` before substantive work (`:82-83`); tools **degrade gracefully** when the
Proxy is down (`:89-91`); the richer `gep_*` surface is the separate `@evomap/gep-mcp-server` (`:91-92`).

---

## 5. Commands — `commands/*.md`

All are Claude Code slash commands (frontmatter `description` + optional `argument-hint` +
`allowed-tools`). Five of them (`run`, `solidify`, `review`, `sync`, `distill`) shell out to the
**`@evomap/evolver`** CLI using the same resolver pattern
`EVOLVER="evolver"; command -v evolver >/dev/null 2>&1 || EVOLVER="npx -y @evomap/evolver"`
(e.g. `commands/run.md:14-15`). `evolve`, `search`, `status` do **not** require the CLI.

| Command | What it does | `@evomap/evolver`? | Key lines |
| --- | --- | --- | --- |
| `/evolve` | Deliberate checkpoint: **Recall** (read injected memory or tail the graph) → **Reflect** (one/two lines: what worked, didn't, the lesson) → **Record** (Stop hook does it; optionally `evolver run` if on PATH). Lightweight, not per-turn. | optional | `commands/evolve.md:2`, steps `:9-32` |
| `/search` | Search EvoMap for reusable genes/capsules. Treats `$ARGUMENTS` as signal keywords (infers 2–4 if empty), calls `evolver_search_assets` (mode semantic, limit 5), summarizes hits, offers `evolver_fetch_asset`. | no (MCP) | `commands/search.md:2-4` (`allowed-tools: mcp__evolver-proxy__evolver_search_assets, ..._fetch_asset`), steps `:8-14` |
| `/status` | Health checklist: (1) Proxy/MCP via `evolver_status` + plain-language "connected?" (checks `~/.evomap/claim_url`, HTTP 402 credits); (2) memory graph existence + outcome count; (3) workspace-id presence; (4) engine CLI installed?. | no (MCP + Bash) | `commands/status.md:2-3` (`allowed-tools: Bash, mcp__evolver-proxy__evolver_status`), steps `:7-40` |
| `/run` | Run one evolution cycle in the current git repo (collect signals → select/mutate genes → propose changes). Confirms git repo, runs `EVOLVE_STRATEGY="${EVOLVE_STRATEGY:-balanced}" $EVOLVER run $ARGUMENTS`, summarizes, never auto-approves. | **yes** | `commands/run.md:2-4`, `:14-15`, `:8-18` |
| `/solidify` | Solidify working-tree changes into a durable gene/capsule with rollback safety. Shows `git diff --stat`, runs `$EVOLVER solidify $ARGUMENTS`, infers `--summary` if absent. | **yes** | `commands/solidify.md:2-4`, `:14-15` |
| `/review` | Review pending evolved changes then approve (solidify) or reject (roll back). Shows `git status`/`git diff`, runs `$EVOLVER review --approve`/`--reject`; asks the user if no flag. | **yes** | `commands/review.md:2-4`, `:14-15` |
| `/sync` | Sync assets between local store and EvoMap Hub. Runs `$EVOLVER sync $ARGUMENTS` (scope/type/export/dry-run), summarizes pulled/unpublished/export path. | **yes** | `commands/sync.md:2-4`, `:8-10` |
| `/distill` | Distill a reusable skill/gene from run history. Prefers the `evolver_distill_conversation` MCP tool when the lesson came from this conversation, else `$EVOLVER distill $ARGUMENTS`. | **yes** (MCP preferred) | `commands/distill.md:2-4`, `:8-14` |

**Port note:** command names are surfaced as `/evolver:*` (`README.md` "What it does"). The
`allowed-tools` values use Claude Code's `mcp__<server>__<tool>` naming — pi will have its own
tool-permission syntax.

---

## 6. Plugin declaration — manifests to re-express in pi's package format

### 6.1 `.claude-plugin/plugin.json`

- `name: "evolver"` (`:2`), `displayName` (`:3`), `version: "0.2.2"` (`:5`), author EvoMap
  (`:6-9`), `homepage: "https://evomap.ai"` (`:10`), `repository` (`:11`), `license: MIT` (`:12`),
  `keywords` (`:13-21`).
- `userConfig` (`:22-46`) — four user-settable values, each wired to env vars consumed elsewhere:
  - `node_id` (string, default `""` — "leave blank for automatic setup") (`:23-28`).
  - `hub_url` (string, default `https://evomap.ai`, → `A2A_HUB_URL`) (`:29-34`).
  - `proxy_port` (string, default `19820`, → `EVOMAP_PROXY_PORT`) (`:35-40`).
  - `strategy` (string, default `balanced`; `balanced|innovate|harden|repair-only|early-stabilize|steady-state|auto`, → `EVOLVE_STRATEGY`) (`:41-45`).

### 6.2 `.claude-plugin/marketplace.json`

- Marketplace `name: "evolver"` (`:2`), `owner` EvoMap (`:3-7`), one `plugins[]` entry (`:9`):
  `name: "evolver"`, **`source: "./"`** (the repo root is the plugin, `:12`), description, author,
  homepage, repository, `license: MIT`, `category: "ai"` (`:18`), keywords (`:19`).

### 6.3 `.mcp.json`

- Declares one MCP server `evolver-proxy` (`:3`): `command: "node"`,
  `args: ["${CLAUDE_PLUGIN_ROOT}/mcp/evolver-proxy.mjs"]` (`:4-5`), and `env` mapping userConfig
  into the bridge's environment (`:6-10`):
  - `EVOMAP_PROXY_PORT = ${user_config.proxy_port}` (`:7`)
  - `A2A_HUB_URL = ${user_config.hub_url}` (`:8`)
  - `A2A_NODE_ID = ${user_config.node_id}` (`:9`)

**How the pieces wire together:** `plugin.json` defines `userConfig`; `.mcp.json` interpolates those
values into the MCP server's env via `${user_config.*}`; `hooks.json` binds the three hook scripts
via `${CLAUDE_PLUGIN_ROOT}`; `marketplace.json` points at the repo root as the plugin source. pi's
package format must re-express: (a) three hook event bindings, (b) one skill, (c) eight commands,
(d) one stdio MCP server with the three env mappings, and (e) the four user-config knobs.

---

## 7. Environment variables (consolidated, from `README.md` "Environment variables" + code)

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_GRAPH_PATH` | auto | Override memory graph file location (`hooks/_paths.js:96`). |
| `EVOMAP_PROXY_PORT` | `19820` | Proxy port fallback for the MCP bridge (`mcp/evolver-proxy.mjs:28`). |
| `A2A_HUB_URL` / `A2A_NODE_ID` | config | Passed to the bridge from plugin config (`.mcp.json:8-9`). |
| `EVOMAP_HUB_URL` / `EVOMAP_API_KEY` / `EVOMAP_NODE_ID` | unset | Enable Hub recording from the Stop hook (`hooks/session-end.js:257-258,358`). |
| `A2A_NODE_SECRET` | unset | Fallback Hub API key (`hooks/session-end.js:258`). |
| `EVOLVER_WORKSPACE_ID` | auto | Override the workspace scoping id (`hooks/_paths.js:237`). |
| `OPENCLAW_WORKSPACE` | auto | Override the workspace root for the id file (`hooks/_paths.js:209`). |
| `CURSOR_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` | cwd | Project dir resolution order (`hooks/_paths.js:45-53`). |
| `EVOLVER_SESSION_STATE_DIR` | `~/.evolver` | Throttle/dedupe state dir (`hooks/session-start.js:67`, `hooks/session-end.js:202`). |
| `EVOLVER_SESSION_END_STDIN_WATCHDOG_MS` | `7000` | Stop-hook stdin watchdog (`hooks/session-end.js:24-26`). |
| `EVOLVER_SESSION_END_DEDUPE_TTL_MS` | 6 h | Once-per-session dedupe window (`hooks/session-end.js:30-33`). |
| `EVOLVER_HOOK_LOG_DIR` | `~/.evolver/logs` | Evolution breadcrumb log dir (`hooks/session-end.js:71-72`). |

---

## 8. Port-critical facts (the 3 a porter must internalize)

1. **Hooks are pure-data + stdio JSON.** All three hooks are dependency-free Node scripts that read
   stdin and emit one JSON object (`additionalContext` / `hookSpecificOutput` for SessionStart &
   PostToolUse; `systemMessage` for Stop), failing open to `{}`. The recall filter
   (`score ≥ 0.5`, `< 7 days`, `max 3` — `hooks/_filter.js:9-11,44-60`) and the 7-category signal
   taxonomy (`hooks/_signals.js:12-66`) are pure constants — port them verbatim. pi only needs to
   re-map the three event bindings (`SessionStart` / `PostToolUse[Write|Edit|MultiEdit]` / `Stop`,
   `hooks/hooks.json`) and reproduce the JSON output contract.

2. **All state is the filesystem, and two formats are hard contracts.** The `memory_graph.jsonl`
   outcome record (§2.1) is consumed by external tooling — keep field names exact. The
   `.evolver/workspace-id` (§2.2) is a forge-resistant 32-hex random id (symlink guards,
   `O_EXCL|O_NOFOLLOW`, mode 0600) that scopes memory per project; the recall side
   (`belongsToWorkspace`, `hooks/session-start.js:140-159`) depends on it to avoid cross-project
   leakage. Live Proxy url + rotating Bearer token live in `~/.evolver/settings.json`.

3. **The MCP bridge is a thin loopback-only proxy client, not the engine.** `mcp/evolver-proxy.mjs`
   is zero-dep stdio JSON-RPC that talks only to a **local** Proxy (loopback guard,
   `:31-53`), reads url+token from `~/.evolver/settings.json` on every call (`:61-73`), and
   degrades gracefully when the Proxy is down. It exposes **7** tools (the ticket's 6 plus
   `evolver_report_reuse`, `:157`). The `@evomap/evolver` engine (GPL) is a separate optional
   install that only the `run/solidify/review/sync/distill` commands shell out to; the hooks and the
   bridge never spawn it.
