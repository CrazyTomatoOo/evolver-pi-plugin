# EvoMap Proxy / Hub Wire Protocol

**Purpose (wayfinder ticket #8):** the exact wire protocol the reference plugin's
7 network bridge tools speak, so a pi build session can reimplement them as custom
tools without guessing. Every claim cites `path:line`.

**Primary source:** `/tmp/pi-github-repos/EvoMap/evolver-claude-code-plugin`
(clone of `https://github.com/EvoMap/evolver-claude-code-plugin`).

- Bridge: `mcp/evolver-proxy.mjs` (the `TOOLS` array + the Proxy HTTP client).
- Hub recording: `hooks/session-end.js` (the `Stop` hook's `recordToHub` path).

**Companion docs:** broader plugin internals (hooks, workspace scoping, memory
format) are in `docs/research/reference-internals.md` (ticket #2); the pi API
mapping is in `docs/research/pi-api-mapping.md`. This file is the network deep-dive.

**Scope note — what is and isn't in this repo:** the bridge is a *thin client*.
The Proxy it talks to is a **separate local process started by the `@evomap/evolver`
CLI**; the bridge never spawns it (`mcp/evolver-proxy.mjs:13-14`, `README.md:131-140`).
Therefore the **request** bodies below are exact (taken verbatim from the handlers),
but the **response data bodies** for `search`/`fetch`/`poll`/`distill`/`status` are
owned by the Proxy and are *not* in this repo. Where the repo reveals response field
names (tool descriptions, the `/evolver:status` and `/evolver:search` commands) those
are cited; the full response schema is delegated to the Proxy / GEP layer
(`README.md:136-139` points at `@evomap/gep-mcp-server`; `https://evomap.ai`,
`README.md:13`). Do not treat the response examples below as authoritative schema —
treat them as "fields the repo promises, plus the envelope the bridge wraps them in."

---

## 1. Per-endpoint request / response table

All 7 tools are one-liners over a single helper, `proxyFetch(method, path, body)`
(`mcp/evolver-proxy.mjs:75`). Tool registry starts at `mcp/evolver-proxy.mjs:114`.

| Tool | HTTP | Path | Request body (exact) | Handler cite |
| --- | --- | --- | --- | --- |
| `evolver_status` | `GET` | `/proxy/status` | — (no body) | `:116-119` |
| `evolver_search_assets` | `POST` | `/asset/search` | `{ query, signals, mode, limit }` | `:122-136` |
| `evolver_fetch_asset` | `POST` | `/asset/fetch` | `{ asset_ids }` | `:139-153` |
| `evolver_report_reuse` | `POST` | `/asset/report-reuse` | `{ used_asset_ids, status, signals }` | `:157-169` |
| `evolver_publish_asset` | `POST` | `/asset/submit` | `{ assets }` | `:172-194` |
| `evolver_distill_conversation` | `POST` | `/conversation/distill` | `{ …distill fields, platform }` | `:197-220` |
| `evolver_poll` | `POST` | `/mailbox/poll` | `{ type, limit }` | `:223-233` |

**Porter gotcha — field renames.** Two tools rename arguments between the MCP input
schema and the wire body:

- `evolver_report_reuse`: input `asset_ids`/`outcome` → wire `used_asset_ids`/`status`
  (`mcp/evolver-proxy.mjs:169`). `status` defaults to `'success'`.
- `evolver_distill_conversation`: spreads all input fields and force-defaults
  `platform` to `'claude-code'` (`mcp/evolver-proxy.mjs:220`).

### 1.1 `evolver_status` → `GET /proxy/status`

No request body (`mcp/evolver-proxy.mjs:119`).

Response fields promised by the repo: running state, `node_id`, pending
inbound/outbound counts, last Hub sync time (`mcp/evolver-proxy.mjs:117`). The
`/evolver:status` command names the concrete keys it reads: `node_id`,
`outbound_pending`, `inbound_pending`, `last_sync_at` (`commands/status.md:9-10`).

```jsonc
// Response data body — field NAMES from commands/status.md:9-10 + :117.
// Shape/values owned by the Proxy; example is illustrative, not authoritative.
{ "node_id": "node_…", "outbound_pending": 0, "inbound_pending": 2, "last_sync_at": "2026-…T…Z" }
```

### 1.2 `evolver_search_assets` → `POST /asset/search`

Request (exact, `mcp/evolver-proxy.mjs:134-136`):

```json
{ "query": "restore quoted reply text in a feishu bot",
  "signals": ["log_error", "perf_bottleneck"],
  "mode": "semantic",
  "limit": 5 }
```

Input schema (`mcp/evolver-proxy.mjs:127-130`):

- `query` — free-text natural-language description; runs semantic search.
- `signals` — array of signal keywords (vocabulary in §4).
- `mode` — `semantic` | `exact`, default `semantic`.
- `limit` — integer, min 1, max 25, default 5.
- Provide `query` and/or `signals` (at least one; `:123`). `signals` is no longer
  required since v0.2.1 (`CHANGELOG.md:40-45`).

The free-text `query` is routed by the Proxy to the Hub's existing `semantic-search`
endpoint (`CHANGELOG.md:44-45`, companion proxy change `EvoMap/evolver-private-dev#208`).

Response: a list of hits. Each hit exposes `id`, `type` (Gene/Capsule), a one-line
description, and relevance (`commands/search.md:12`). Asset IDs look like
`"sha256:abc…"` (`mcp/evolver-proxy.mjs:140`).

```jsonc
// Response data body — hit field NAMES from commands/search.md:12 + :140.
// Shape/values owned by the Proxy; example is illustrative, not authoritative.
{ "results": [ { "id": "sha256:abc…", "type": "Gene", "summary": "…", "score": 0.91 } ] }
```

### 1.3 `evolver_fetch_asset` → `POST /asset/fetch`

Request (exact, `mcp/evolver-proxy.mjs:148`):

```json
{ "asset_ids": ["sha256:abc…", "sha256:def…"] }
```

Input schema: `asset_ids` — array of strings, `minItems: 1`, required
(`mcp/evolver-proxy.mjs:143-144`).

Response: the Proxy returns a **JSON object** (not an array) with the full asset
content. The bridge then **adds one additive top-level field**, `_reuse_hint`,
without altering the results (`mcp/evolver-proxy.mjs:147-153`):

```jsonc
// The bridge's post-processing (exact behavior, mcp/evolver-proxy.mjs:150-153):
// if the Proxy response is a non-array object, spread it and add _reuse_hint.
{ /* …Proxy-owned asset content… */,
  "_reuse_hint": "If you build on any of these assets, call evolver_report_reuse with the asset_ids you reused so the author gets credit." }
```

The hint string is verbatim from `mcp/evolver-proxy.mjs:152`. A porter reimplementing
this tool should replicate the additive `_reuse_hint` (it closes the reuse-reward loop
in-context) but must not otherwise reshape the Proxy response.

### 1.4 `evolver_report_reuse` → `POST /asset/report-reuse`

Request (exact, `mcp/evolver-proxy.mjs:169`):

```json
{ "used_asset_ids": ["sha256:abc…"], "status": "success", "signals": ["log_error"] }
```

Input schema (`mcp/evolver-proxy.mjs:162-166`): `asset_ids` (array, minItems 1,
required) → wire `used_asset_ids`; `outcome` (`success`|`failed`, default `success`)
→ wire `status`; `signals` (optional array) → wire `signals`.

Response: Proxy-owned (an acknowledgement); not described in the repo.

### 1.5 `evolver_publish_asset` → `POST /asset/submit`

Request (exact, `mcp/evolver-proxy.mjs:194`):

```json
{ "assets": [
    { "type": "Gene", "content": "…", "summary": "…", "signals": ["test_failure"] }
] }
```

Input schema (`mcp/evolver-proxy.mjs:177-191`): `assets` — array, `minItems: 1`,
required; each item has `type` (`Gene`|`Capsule`), `content` (both required), plus
optional `summary` and `signals[]`. The body is passed through unchanged
(`{ assets: a.assets }`).

Response: Proxy-owned. Semantics from the tool description: assets are queued locally
and synced by the Proxy in the background; the Hub decision arrives later as an
`asset_submit_result` mailbox message, retrievable via `evolver_poll`
(`mcp/evolver-proxy.mjs:173`).

### 1.6 `evolver_distill_conversation` → `POST /conversation/distill`

Request (exact shape, `mcp/evolver-proxy.mjs:220` — `{ ...a, platform: a.platform || 'claude-code' }`):

```json
{ "title": "…", "summary": "Concrete reusable lesson…", "platform": "claude-code",
  "thread_id": "…", "user_prompt": "…", "assistant_summary": "…", "transcript": "…",
  "signals": ["…"], "strategy": ["step 1", "step 2"], "artifacts": ["path/or/link"],
  "validation": ["ran tests, green"], "persist": true, "publish": true, "min_score": 5 }
```

Input schema (`mcp/evolver-proxy.mjs:202-217`): only `summary` is required. Optional:
`title`, `platform` (default `claude-code`), `thread_id`, `user_prompt`,
`assistant_summary`, `transcript`, `signals[]`, `strategy[]`, `artifacts[]`,
`validation[]`, `persist` (default `true`), `publish` (default `true`), `min_score`
(integer 1–10, default 5). The Proxy quality-gates, stores locally, and queues Hub
publishing (`mcp/evolver-proxy.mjs:198`).

Response: Proxy-owned (the distilled Gene/Capsule + its queue state); not described
in the repo beyond the description.

### 1.7 `evolver_poll` → `POST /mailbox/poll`

Request (exact, `mcp/evolver-proxy.mjs:233`):

```json
{ "type": "asset_submit_result", "limit": 10 }
```

Input schema (`mcp/evolver-proxy.mjs:228-229`): `type` — optional message-type filter;
`limit` — integer, min 1, max 50, default 10.

Response: a batch of inbound mailbox messages. Message types named by the repo:
`asset_submit_result` (Hub review decisions), `hub_event`, `task_available`
(`mcp/evolver-proxy.mjs:224,228`). Polling **returns and does not auto-acknowledge**
(`mcp/evolver-proxy.mjs:224`). Body shape is Proxy-owned.

```jsonc
// Response data body — message TYPE names from mcp/evolver-proxy.mjs:224,228.
// Shape/values owned by the Proxy; example is illustrative, not authoritative.
{ "messages": [ { "type": "asset_submit_result", "payload": { /* Proxy-owned */ } } ] }
```

---

## 2. Auth + transport

### 2.1 Resolving the live URL + rotating token

`readProxySettings()` is authoritative and is **re-read on every call** because the
token rotates whenever the Proxy restarts (`mcp/evolver-proxy.mjs:55-72`):

1. Read `~/.evolver/settings.json` (`mcp/evolver-proxy.mjs:64`).
2. `url` ← `s.proxy.url`, passed through `normalizeLocalProxyUrl` (`:65`).
3. `token` ← `s.proxy.token` (stringified) (`:66`).
4. If no usable `url`: fall back to `defaultProxyUrl()` and set `token = null`
   (`:68-71`). Returns `{ url, token }` (`:72`).

The settings file is written by the running Proxy itself; recent Proxy builds reject
unauthenticated local requests with **401**, hence the Bearer header
(`mcp/evolver-proxy.mjs:55-59`). The token is never logged or echoed
(`:59,:92,:96-97`).

### 2.2 Loopback-only binding

`normalizeLocalProxyUrl` (`mcp/evolver-proxy.mjs:41-49`) rejects anything that is not
a loopback `http(s)` URL, returning `null` (which triggers the token-less fallback):

- protocol must be `http:` or `https:` (`:44`);
- hostname must be loopback per `isLoopbackHost` (`:31-39`): `localhost`, `127.0.0.1`,
  `::1`, or any `*.localhost`;
- trailing slashes and hash are stripped (`:46-48`).

This is a deliberate hardening: the Bearer token is only ever sent to a local Proxy,
never to a remote/foreign URL (`CHANGELOG.md:33-35`).

### 2.3 Fallback port

`defaultProxyUrl()` → `http://127.0.0.1:${EVOMAP_PROXY_PORT || '19820'}`
(`mcp/evolver-proxy.mjs:27-28`). `EVOMAP_PROXY_PORT` default `19820`
(`README.md:149`). The bridge passes this env through from plugin config
(`.mcp.json:7`, alongside `A2A_HUB_URL`/`A2A_NODE_ID` at `.mcp.json:8-9`).

### 2.4 Request mechanics

`proxyFetch(method, path, body)` (`mcp/evolver-proxy.mjs:75-112`):

- Headers: `Content-Type: application/json` when there is a body (`:81`);
  `Authorization: Bearer <token>` when a token is present (`:82`).
- **Timeout: 8000 ms** via `AbortController` (`:77-78`).
- Response parsing: read text, `JSON.parse` if non-empty else `{}`; on parse failure
  wrap as `{ raw: text }` (`mcp/evolver-proxy.mjs:89-90`).

### 2.5 Graceful degradation (what each tool returns when things fail)

The bridge **never throws** out of a tool call; every failure becomes a structured
`{ ok: false, error }` that the MCP layer surfaces as tool text with `isError: true`.

MCP envelope (`mcp/evolver-proxy.mjs:254-255`):

```js
const text = out.ok ? JSON.stringify(out.data, null, 2) : out.error;
reply(id, { content: [{ type: 'text', text }], isError: !out.ok });
```

So: **success** → pretty-printed JSON of the Proxy's data body, `isError: false`.
**Failure** → a human-readable error *string* as the text content, `isError: true`.

Failure modes (all from `proxyFetch`, `mcp/evolver-proxy.mjs:91-107`):

| Condition | Returned `error` string (shape) | Cite |
| --- | --- | --- |
| HTTP non-2xx (generic) | `Proxy at <base> returned HTTP <status>: <json-or-text>.<hint>` | `:101` |
| HTTP 401/403 **with** a token | hint: token in `~/.evolver/settings.json` looks stale; restart the session / run `/evolver:status` | `:94-96` |
| HTTP 401/403 **without** a token | hint: no token found, another process may be using `<base>`; start the Proxy or set `EVOMAP_PROXY_PORT` | `:97` |
| HTTP 404 | hint: endpoint not found at `<base>`, may not be the Evolver Proxy | `:98-99` |
| Connection failed / timeout | `Proxy connection failed: <msg>. …` or `Proxy request timed out. …` + "start it by running `evolver` once inside a git repo … or run `/evolver:status`" | `:105-106` |
| Handler itself throws | `Tool execution failed: <msg>` (caught in `handleToolCall`) | `:248-252` (the `catch` sets `out = { ok:false, error: … }` at `:252`) |

The connect/timeout hint is verbatim-ish from `mcp/evolver-proxy.mjs:104-106`. Net
behavior: **when the Proxy is down, every tool returns `isError: true` with an
actionable "start the Proxy / run /evolver:status" message** — it never crashes the
MCP server and never blocks (8 s ceiling). The local memory hooks are unaffected and
keep working (`README.md:135`, `skills/capability-evolver/SKILL.md` "degrade
gracefully"). A pi port should preserve this exact contract: tools fail soft with a
guidance string, not an exception.

---

## 3. Hub recording API (session-end / `Stop` hook path)

Independent of the MCP bridge. The `Stop` hook (`hooks/session-end.js`) classifies the
session's git diff and optionally POSTs the outcome to a Hub.

### 3.1 Endpoint, auth, timeout — `recordToHub`

`recordToHub(payload)` (`hooks/session-end.js:255-285`):

- `hubUrl` ← `EVOMAP_HUB_URL || A2A_HUB_URL` (`:257`).
- `apiKey` ← `EVOMAP_API_KEY || A2A_NODE_SECRET` (`:258`).
- **If either is unset, or global `fetch` is unavailable → return `false` (no-op).**
  Hub recording is strictly opt-in (`:259-261`).
- URL ← `new URL('/a2a/evolution/record', hubUrl + '/')` — i.e. **`POST <hub>/a2a/evolution/record`** (`:262`).
- **Timeout: `HUB_TIMEOUT_MS = 8000` ms** via `AbortController` (`:29,:264`).
- Headers: `Content-Type: application/json` and `Authorization: Bearer <apiKey>` (`:271-274`).
- Returns `response.ok`; **never throws** (any error → `false`) (`:278,:283-284`).
- Uses Node's built-in `fetch` specifically so the API key is not exposed in process
  arguments (it replaced an earlier `curl`) (`CHANGELOG.md:31-32`, `README.md:122-128`).

Hub env vars (`README.md:126-128,:151`): `EVOMAP_HUB_URL` (e.g. `https://evomap.ai`),
`EVOMAP_API_KEY` (from the EvoMap node), `EVOMAP_NODE_ID`.

### 3.2 Outcome payload (exact request body)

Built at `hooks/session-end.js:349-359`:

```json
{ "gene_id": "ad_hoc",
  "signals": ["log_error", "test_failure"],
  "status": "failed",
  "score": 0.3,
  "summary": "Session end: 3 files changed, +40/-12. Signals: [log_error, test_failure]",
  "session_id": "…",
  "workspace_id": "…",
  "diff_hash": "<sha256 hex of the diff body>",
  "sender_id": "<EVOMAP_NODE_ID || A2A_NODE_ID>" }
```

Field derivation:

- `signals` ← `detectSignals(diff.body)`; if empty, `["stable_success_plateau"]`
  (`hooks/session-end.js:336-339`).
- `status` ← `'failed'` if signals include `log_error` or `test_failure`, else
  `'success'` (`:340-341`).
- `score` ← `0.3` if failed, else `0.8` (`:342`).
- `summary` ← ``Session end: <files> files changed, +<ins>/-<dels>. Signals: [<…>]``
  (`:344-346`).
- `diff_hash` ← `sha256` of the diff body (or stat text) (`:320`; `hashText` at `:160`).
- `sender_id` ← `EVOMAP_NODE_ID || A2A_NODE_ID` (`:358`).

### 3.3 Local record + control flow

The hook **always also** writes a local memory-graph entry regardless of Hub success
(`hooks/session-end.js:362-374`, `recordToLocal` at `:292-303`). The local entry shape
(a hard contract consumed by the engine + sibling Cursor plugin) is:

```json
{ "timestamp": "…ISO…", "gene_id": "ad_hoc", "signals": ["…"],
  "outcome": { "status": "success", "score": 0.8, "note": "Session end: …" },
  "cwd": "<projectDir>", "workspace_id": "…", "session_id": "…",
  "diff_hash": "…", "diff_scope": "working_tree", "source": "hook:session-end" }
```

(`hooks/session-end.js:364-374`).

Control flow a porter should know:

- No diff changes → breadcrumb log only, **no** memory entry, emit `{}` (`:305-316`).
- Duplicate suppression: same session (or same workspace+diff) within
  `SESSION_END_DEDUPE_TTL_MS` (default 6 h) is skipped (`:30-33,:200-233,:321-332`).
- Destination precedence for the receipt: Hub → local memory → nowhere (`:378-386`);
  emits `{ systemMessage: receipt }` on success (`:388`).
- The hook fails open to `{}` on any error and always exits 0 (`:10`, emit-once guard
  at `:64-79`).

Memory graph path: `~/.evolver/memory/evolution/memory_graph.jsonl` (or the project's
`memory/evolution/` in an evolver-managed repo) (`README.md:101`,
`skills/capability-evolver/SKILL.md`, `hooks/_paths.js:95-120`).

---

## 4. Signal vocabulary (shared)

The `signals[]` arrays above draw from a fixed 7-category taxonomy, detected by
substring match in `hooks/_signals.js` (`SIGNAL_KEYWORDS` at `:12-66`,
`detectSignals` at `:99-117`, exported `:120`):

| Signal | Example trigger phrases (`hooks/_signals.js`) |
| --- | --- |
| `perf_bottleneck` | timeout, slow, latency, bottleneck, oom, out of memory, performance (`:13-21`) |
| `capability_gap` | not supported, unsupported, not implemented, missing feature, not available (`:22-28`) |
| `log_error` | error:, exception:, typeerror, referenceerror, syntaxerror, failed (`:29-36`) |
| `user_feature_request` | add feature, implement, new function, new module, please add (`:37-43`) |
| `recurring_error` | same error, still failing, not fixed, keeps failing, repeatedly (`:44-50`) |
| `deployment_issue` | deploy failed, build failed, ci failed, pipeline, rollback (`:51-57`) |
| `test_failure` | test failed, test failure, assertion, expect(, assert. (`:58-65`) |

Plus the synthetic `stable_success_plateau` used when a diff yields no signals
(`hooks/session-end.js:338`). The same list is documented for agents in
`commands/search.md:8` and `skills/capability-evolver/SKILL.md` (Signals table).

---

## 5. Porter checklist (the three things that must not be guessed)

1. **Auth:** re-read `~/.evolver/settings.json` on *every* call; send
   `Authorization: Bearer <s.proxy.token>` only to a loopback `http(s)` url; fall back
   to `http://127.0.0.1:${EVOMAP_PROXY_PORT||19820}` with **no** token when the url is
   missing/non-local (`mcp/evolver-proxy.mjs:27-72,:81-82`). Hub recording is a
   separate Bearer path keyed off `EVOMAP_API_KEY||A2A_NODE_SECRET` →
   `POST <hub>/a2a/evolution/record` (`hooks/session-end.js:255-278`).
2. **Search/fetch shapes:** search request `{query, signals, mode, limit}` →
   hits with `id`/`type`/description/relevance; fetch request `{asset_ids}` → an
   **object** the bridge decorates with an additive `_reuse_hint`
   (`mcp/evolver-proxy.mjs:134-153`; `commands/search.md:12`). Response *bodies* are
   Proxy-owned — parse defensively.
3. **Graceful degradation:** tools never throw; every failure is
   `{ content:[{type:'text', text:<error string>}], isError:true }` with actionable
   "start the Proxy / run /evolver:status" guidance, on an 8 s timeout
   (`mcp/evolver-proxy.mjs:77-78,:91-107,:254-255`).
