# Cursor OpenAI-compat proxy — specification

This document is the behavioral contract for `tools/cursor-openai-proxy`. It describes what clients can rely on. Implementation lives next to this file; [README.md](README.md) covers how to run it.

**Overarching goal: minimize the agent.** Cursor-hosted IDE models are only reachable through a local agent run; that agent must remain in the loop for ToS. This proxy exists to put those models on an OpenAI-shaped HTTP endpoint while giving the agent as little work as possible: OpenAI JSON transport, client-owned tools, no ambient MCP, no autoReview, ignore sampling rather than pretending to be a completions API.

OpenAI JSON is the **transport**. The agent loop is the **ToS-required runtime**, not the product. Every generation request still becomes one Cursor **local agent run**. Inference uses Cursor-hosted models; “local” means the agent loop and workspace files stay on this machine.

Default model id: `auto`. Default bind: `127.0.0.1:11434`.

---

## 1. Non-goals

This version does **not**:

- Present as an autonomous workspace agent (Open-Interpreter / Aider style). The agent is a ToS constraint to shrink, not a product to grow.
- Honor LiteLLM-style sampling (`temperature`, `top_p`, `seed`, `max_tokens`, `max_completion_tokens`) — they are accepted and ignored (logged when `DEBUG` is set)
- Emulate `response_format` / JSON mode
- Combine Cursor built-ins (`read`, `grep`, `shell`, …) with client function tools on the same agent. Client `tools` replace built-ins so Cursor is not the tool runner.
- Run cloud agents (`bc-` ids)
- Expose Cursor as a public multi-tenant completions product
- Implement OpenAI embeddings, vision, Assistants, Realtime, the Conversations resource, or `/v1/completions`
- Use Cursor hooks as the tool bridge (hooks cannot emit a Responses `function_call`; deny is not a tool result)
- Use `local.autoReview` or sandbox as the way to strip `shell` / `edit` (the SDK **allowlist** does that)
- Load the operator’s Cursor-app MCP config (`~/.cursor/mcp.json`, project `.cursor/mcp.json`, plugins, dashboard)
- Persist sessions across process restarts (in-memory only)

OpenAI **function tools** are in scope (Chat Completions and Responses). See §5.

---

## 2. Process model

- Runtime: Node.js 22.13+
- One process, one Hono app, one in-memory `SessionRegistry`
- Cursor SDK default import (`@cursor/sdk`), local runtime only
- Chat Completions and Responses share the same registry and agents. They must not each own a separate agent pool.

CLI:

| Flag | Default | Meaning |
|---|---|---|
| `--port` | `11434` | Listen port (`0` = OS-assigned) |
| `--host` | `127.0.0.1` | Bind address |
| `--workspace` | process cwd | Local agent working directory |
| `--cursor-api-key` | `$CURSOR_API_KEY` | Hosted Cursor key; omit (and unset env) for passthrough |
| `--session-mode` | `sticky` | Chat session resolution: `sticky` \| `prefix` |
| `--agent-mode` | `ask` | `ask` \| `plan` \| `agent` |

`--cursor-api-key` wins over `$CURSOR_API_KEY`. Empty/whitespace keys are treated as absent.

### Agent mode mapping

The SDK `mode` field is only `"agent" | "plan"`. Local runs stay **YOLO**: do **not** set `local.autoReview` and do **not** enable sandbox. Offered tools run without a human prompt. The proxy caller decides what may run by sending OpenAI `tools` and choosing `--agent-mode`.

Always `local: { cwd: --workspace, settingSources: [] }`. Never pass `mcpServers`. Never `agent.reload()` to pick up on-disk MCP. User/project/plugin Cursor MCP must not appear.

| Situation | SDK `mode` | `tools` on create |
|---|---|---|
| `--agent-mode ask`, no OpenAI `tools` | omitted | `["read", "grep", "glob", "ls"]` (narrow read-only set; some toolset must exist) |
| Client sent a non-empty OpenAI `tools` array | as below | `["mcp"]` only — exclusive so Cursor is not the tool runner; only `local.customTools` |
| `--agent-mode plan` / `agent`, no OpenAI `tools` | `"plan"` / `"agent"` | omit (SDK default set, including shell); opt-in, widens the agent |

`--agent-mode` still applies when OpenAI `tools` are present (`ask` omits SDK `mode`; `plan` / `agent` set it). Do **not** use `tools: []` for the client-tool bridge (that disables custom tools too). Do **not** `disallowedTools: ["mcp"]`. Empty OpenAI `tools: []` is text-only for that request (no customTools, no park); keep the ask/plan/agent mapping above.

`tools: ["mcp"]` grants the MCP **capability** needed for `custom-user-tools` and **drops Cursor built-ins** (`read` / `grep` / `shell`). That exclusivity is the minimize-agent goal, not a gap: the client owns execution. Combined with `settingSources: []` and no `mcpServers`, the only MCP tools the model can see are `local.customTools` built from **this HTTP request’s** OpenAI `tools` array.

---

## 3. Authentication

Every `/v1/*` request **must** send `Authorization: Bearer <token>`. Missing, non-Bearer, or empty token → **401** `{ error: { type: "invalid_request_error", code: "invalid_api_key" } }`.

`GET /health` does **not** require a token.

The Bearer token is **always** the session-isolation namespace (SHA-256 hex). Whether it is also the Cursor credential depends on startup:

### Hosted-key mode

Selected when `--cursor-api-key` or `$CURSOR_API_KEY` is a non-empty string at startup.

- All `Agent.create` / `Cursor.models.list` calls use the **startup** Cursor key.
- The request Bearer is an arbitrary tenant id. `ollama` is valid.
- Same Bearer → same session pool. Different Bearer → isolated pool, even though Cursor billing is one key.

### Passthrough mode

Selected when no startup key is set.

- The request Bearer **is** the Cursor API key, passed into `Agent.create({ apiKey })` / `models.list({ apiKey })`.
- Dummy keys `ollama` and `sk-dummy` (case-insensitive, trimmed) → **401** `invalid_api_key`.

Do not log `Authorization`, startup keys, or `crsr_` prefixes.

---

## 4. Session store

In-memory map. Lookup key is **`(callerKeyHash, id)`**, never `id` alone.

- `callerKeyHash` = SHA-256 hex of the raw Bearer token. The token is not stored next to the agent.
- `id` is a `response_id`, chat `session_id`, or prefix-derived `sess_…`.
- Record fields: `{ agent, activeRun?, supervisor?, pendingToolCalls?, outputText, status, model, createdAt, previousResponseId, stored, usage?, error? }`
- Per-agent mutex: overlapping `send()`s on the same agent **queue** (serialize). The mutex is **released while parked** (`requires_action`) so a tool-output POST can run (it does not `send()`). Cancel does not take that lock.
- Unknown id, or id that exists only under a **different** caller hash:
  - `GET` / `POST …/cancel` → **404** (not 403)
  - `POST /v1/responses` with `previous_response_id` that exists under another caller → **404**
  - `POST /v1/responses` with a `previous_response_id` that exists under **no** caller → **400**

Status values: `in_progress` | `requires_action` | `completed` | `cancelled` | `failed`.

`store: false` (Responses): agent is not registered; after the run it is disposed; `previous_response_id` cannot chain to it. `store: false` combined with a non-empty OpenAI `tools` array → **400** (cannot submit tool outputs).

While `requires_action`, `activeRun` stays set (the Cursor `Run` is alive). Parked `customTools.execute()` promises live on the supervisor until the client posts outputs, or cancel rejects them.

---

## 5. HTTP surface

OpenAI-shaped JSON errors:

```json
{ "error": { "message": "…", "type": "invalid_request_error", "code": "…" } }
```

Unhandled exceptions → **500** `{ type: "internal_error", code: "internal" }`. Invalid JSON / schema → **400**.

Unimplemented features use **501** `{ code: "unsupported" }` unless noted.

Default `model` when omitted or blank: `auto`. Two distinct model-failure shapes:
- **Rejected before any run starts** (e.g. an unknown model id) — the Cursor SDK throws a typed error out of agent creation. The proxy maps it by SDK error class to the matching HTTP status (`ConfigurationError` → 400, `AuthenticationError` → 401, `RateLimitError` → 429, `AgentBusyError` → 409, `NetworkError` → 503, any other `CursorSdkError` → 500), `type: "invalid_request_error"` for the 4xx classes / `"internal_error"` for 5xx, and `code` set to the SDK's own `err.code` when present, else `null`.
- **Fails at run time** despite a model id that appears in `GET /v1/models` (for example team admin blocks) — discovered only via `wait()`. Chat Completions return **500** `{ error: { type: "internal_error", code, message } }` where `code` is the Cursor `wait()` error's own `code` when the SDK supplied one, else `"run_failed"`. Responses stay **200** with `status: "failed"` and `error: { message, code? }`.

`reasoning_effort` (chat) and `reasoning_effort` / `reasoning.effort` (responses) are mapped onto `model.params` **only** when `Cursor.models.list()` reports a parameter id `effort` or `reasoning_effort` that includes the requested value. Otherwise they are ignored. Applied at **agent create**, not on follow-up `send()`.

`fast` (chat and responses, top-level string `"true"`/`"false"`) maps onto `model.params` the same way, but with a default: when a model's catalog entry exposes a `fast` parameter and the request didn't set `fast`, it's set to `"false"` rather than left unset. This exists because Cursor's backend resolves an unset `fast` param to `"true"` for some models (`composer-2`/`composer-2.5`/`grok-4.5`/`grok-4.6` at least), which team admin policy can block outright (`Model Blocked`) even though those same models' catalog `isDefault` variant advertises `fast: false` — see `docs/dev/model-availability-map.md`. The model catalog is now fetched on every agent creation (not only when `reasoning_effort` is set) so this default can be evaluated regardless of which params the request supplies.

`context` and `thinking` (chat and responses, top-level strings) map onto `model.params` the same way as `reasoning_effort` — only when the target model's catalog entry declares a parameter with that id and the requested value is one of its declared values, otherwise silently ignored. Unlike `fast`, neither has a default applied when unset: there's no known backend-side issue with leaving them unset (see `docs/dev/model-availability-map.md`), so they're opt-in only. `claude-sonnet-5` is the model observed to expose these today (`context`: `"300k"`/`"1m"`, `thinking`: `"false"`/`"true"`).

### Reasoning summaries

`run.stream()` emits a distinct `type: "thinking"` event (`SDKThinkingMessage`) carrying the provider's own summarized reasoning text — not a raw chain-of-thought trace, which Cursor doesn't expose. This proxy forwards that summary, since it's useful live feedback while a long turn is in progress:

- Chat: streamed as its own SSE chunk, `delta: { reasoning_content: "…" }` (never combined with `content` in the same chunk) — the de facto convention several OpenAI-compatible gateways (DeepSeek, OpenRouter) already use, since Chat Completions has no OpenAI-native reasoning concept. The non-stream/final object includes the same accumulated text as `message.reasoning_content`, omitted entirely (not `""`) when the run produced none.
- Responses: streamed as `response.reasoning_summary_text.delta` events (`{ item_id, output_index, summary_index, delta }`), matching OpenAI's own real Responses API event name for this. The stored/final object gets a `{ type: "reasoning", id: "rs_…", summary: [{ type: "summary_text", text }] }` item in `output`, ordered before the message/function_call items — omitted entirely when there was no thinking output.

Every other raw `SDKMessage` type from `run.stream()` — `"system"`, `"status"`, `"request"`, `"task"`, `"usage"` — has no branch anywhere in this proxy's stream translation (`wrapRun()`, `src/cursor/sdkBackend.ts`) and is silently dropped; only `"assistant"`, `"tool_call"`, and `"thinking"` are handled. None have an OpenAI wire equivalent worth inventing: `usage` duplicates what `wait()` already returns (see `record.usage` above), `system` duplicates what the proxy already knows synchronously from its own `createAgent()` call, and `request`/`task` carry either no content or free text with no matching field in either wire format.

`status` (`SDKStatusMessage.status`: `CREATING` / `RUNNING` / `FINISHED` / `ERROR` / `CANCELLED` / `EXPIRED`) is **edge-triggered, not periodic** — confirmed by direct instrumentation of a live 11.7s streaming run, which emitted exactly two `status` events total: one `RUNNING` at the very start (the `CREATING`→`RUNNING` transition) and one `FINISHED` at the very end, with zero events in between despite 425 `assistant` chunks and 11 `thinking` chunks arriving during that window. It never repeats as a heartbeat while a run is progressing, so it cannot serve as a liveness/keep-alive signal for the `PARK_IDLE_MS` heuristic (`docs/dev/park-idle-heuristic.md`) — a stalled run and a working run both look like silence on this event type; only content-bearing events (`assistant`/`thinking`/`tool_call`) distinguish them, which is what the existing heuristic already relies on via `outputText`/`reasoningText` growth.

### Tool pass-through

OpenAI `type: "function"` tools are registered as `local.customTools` on `agent.send()`. When the model calls one, `execute()` **parks** (promise keyed by SDK `toolCallId` = OpenAI `call_id`). The HTTP turn ends with Chat `finish_reason: "tool_calls"` or Responses `status: "requires_action"`. The Cursor `Run` stays alive. The next client POST supplies the tool result and **resolves** the parked promise; it is **not** `agent.send()`.

Accepted schema: `type: "function"` only.

- Chat: `{ type: "function", function: { name, description, parameters } }`
- Responses: the Chat shape, or `{ type: "function", name, description, parameters }`

Other tool types (`file_search`, `web_search`, `code_interpreter`, …) → **501**. `tool_choice` / `parallel_tool_calls` are accepted and ignored (DEBUG log). Empty `tools: []` means text-only for that request.

SDK `toolCallId` is OpenAI `call_id`. Responses item ids may be `fc_…`.

A new user turn while parked → **409** `{ code: "requires_action" }`.

### `GET /health`

No auth. **200**:

```json
{ "status": "ok", "runtime": "local", "session_mode": "sticky|prefix", "auth_mode": "hosted|passthrough" }
```

### `GET /v1/models`

Auth required. `Cursor.models.list()` flattened to OpenAI list format. Each catalog `id` **and** each alias becomes its own `{ id, object: "model", created: 0, owned_by: "cursor" }`. First occurrence wins if an alias collides with an id.

### `GET /v1/models/{id}`

Same flattening. Match on id or alias. Unknown → **404** `{ code: "model_not_found" }`.

### `GET /v1/model/info`

Auth required. Same catalog flattening as `/v1/models`, shaped like LiteLLM's proxy `/v1/model/info` for clients that expect that convention:

```json
{ "data": [{ "model_name": "auto", "litellm_params": { "model": "auto" }, "model_info": { "id": "auto", "db_model": false, "key": "auto", "litellm_provider": "cursor", "mode": "chat" } }] }
```

The Cursor SDK exposes no context-window, cost, or capability data per model, so `model_info` intentionally omits `max_tokens`/`max_input_tokens`/cost fields rather than fabricating them — only `id`/`db_model`/`key`/`litellm_provider`/`mode`, which LiteLLM's own schema treats as the guaranteed baseline.

When the catalog entry has them, `model_info` also carries through, verbatim and undoctored, whatever `Cursor.models.list()` actually reports: `display_name`, `description`, `aliases` (the entry's *other* names — the flattened entry for `sonnet` lists `["claude-sonnet-5", "sonnet-5"]`, not itself), `parameters` (named knobs like `effort`/`fast`/`context`/`thinking`, each with its valid `values`), and `variants` (named parameter presets, each with its own `displayName`/`description`/`isDefault`). All five are omitted entirely (not sent as `null`) for a catalog entry that doesn't have them. None of this is LiteLLM's own schema — it's this proxy's own honest extension of `model_info`'s free-form shape, added because the data exists and is real, not because LiteLLM expects these specific keys.

A `parameters[].id` here (e.g. `"effort"`) is Cursor's own internal catalog name, **not** necessarily the request field a client sends to set it. `effort`/`reasoning_effort` is the one case where these differ: the wire-facing, OpenAI-conventional field is `reasoning_effort` (see below), while the catalog id can be either `effort` or `reasoning_effort` depending on the model — `effortParams()` matches either. `fast`/`context`/`thinking` have no such split; their catalog id and request field are the same string.

### `POST /v1/embeddings`

**501** Embeddings.

### `POST /v1/chat/completions`

Request (Effect Schema; extra fields ignored):

| Field | Required | Notes |
|---|---|---|
| `messages` | yes | array of `{ role, content?, name?, tool_call_id?, tool_calls? }`; `role` may be `tool` |
| `model` | no | default `auto` |
| `stream` | no | SSE if true |
| `stream_options.include_usage` | no | if true, emit a final usage-only chunk before `[DONE]` when streaming |
| `n` | no | only `1` or omitted; else **400** |
| `tools` | no | function tools; other types → **501**; empty `[]` = text-only |
| `tool_choice` / `parallel_tool_calls` | no | ignored |
| `logprobs` | no | if truthy → **501** |
| `session_id` / `cursor_session_id` | no | sticky session id (also `X-Cursor-Session-Id` / `X-Session-Id`) |
| `reasoning_effort` | no | optional `model.params` mapping |
| `temperature`, `top_p`, `seed`, `max_tokens`, `max_completion_tokens` | no | ignored |

`content` may be a string, `null`, or an array of parts. Parts with `image_url` or `type` `image_url` / `input_image` → **501**. Text parts are concatenated.

The tool loop **requires sticky sessions** to *create* a new tool-using conversation: `--session-mode prefix` plus a non-empty `tools` array → **400** (an agent's tool permissions are fixed at creation time, so a content-hashed session can't be safely upgraded to support tools later). Return `X-Cursor-Session-Id` as a convenience, but resuming an already-parked tool call never consults it (or `session_id`/`cursor_session_id`) at all — only the `tool_call_id` echoed back on the `role: "tool"` message is used, which is base OpenAI tool-calling protocol, not a proxy extension. This proxy serves standards-compliant clients that have no reason to know about `X-Cursor-Session-Id`; see "Follow-up" below for the exact resolution.

Response header: `X-Cursor-Session-Id` = the resolved session id.

Non-stream **200** (text):

```json
{
  "id": "chatcmpl_…",
  "object": "chat.completion",
  "created": <unix seconds>,
  "model": "…",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "…" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

Non-stream **200** (parked tools): `finish_reason: "tool_calls"`, `message.tool_calls: [{ id, type: "function", function: { name, arguments } }]`, `message.content: null`. `arguments` is a JSON string.

`usage` is copied from the Cursor run when the runtime reports it; otherwise zeros.

Stream: `text/event-stream`. Frames are `data: <json>\n\n` (no `event:` name), then `data: [DONE]\n\n`:

1. role chunk: `delta: { role: "assistant" }`, `finish_reason: null`
2. content chunks (`delta: { content }`) and, if parked, `delta.tool_calls` chunks (id/name then argument string deltas) — these are **not ordered relative to each other**: a tool call is announced the instant it's known (parked), independent of any concurrent text streaming, so a `tool_calls` chunk may arrive before, after, or interleaved with content chunks in the same turn
3. if parked: `finish_reason: "tool_calls"` after the above — do **not** emit `finish_reason: "stop"`
4. else: stop chunk: `delta: {}`, `finish_reason: "stop"`
5. if `stream_options.include_usage` was true: one more chunk with `choices: []` and a populated `usage` (same values as the non-stream `usage` field) — sent after the finish chunk (step 3 or 4) regardless of `finish_reason`
6. `[DONE]`

If `wait()` returns `error`, skip the stop chunk and emit `data: { error: { message, type: "internal_error", code } }` then `[DONE]` (no usage chunk in this case) — `code` is the SDK's own `wait()` error code when present, else `"run_failed"`. Non-stream failed runs are **500** instead.

Follow-up: last messages with `role: "tool"` + `tool_call_id` **resolve** the parked `execute()`; they are **not** `agent.send()`. Resolution relies **exclusively** on `tool_call_id` — no session id field (`session_id` / `cursor_session_id` / `X-Cursor-Session-Id` / `X-Session-Id`) is read for this at all, not even as a first-choice fast path: a present-but-wrong/irrelevant session id on the same request is ignored rather than hijacking or blocking the resume. The caller's own sessions are searched for one parked on the given `tool_call_id`; no live match (evicted session, restarted proxy, or the id never existed) → a fresh agent is created and the full history — including the tool call and its result — is replayed as its prompt, instead of erroring. A `tool_call_id` the matched session doesn't recognize → **400** `Unknown call_id`. A new user turn while parked → **409** `{ code: "requires_action" }`.

Submitting outputs for only some of the currently parked `call_id`s does **not** error: those outputs resolve, and the turn is re-collected. Any `call_id` still outstanding — including one that parked after the previous response was already sent, past the idle-detection window used to decide a turn is done — comes back as the new `tool_calls` response instead of failing, so a caller converges by answering whatever it's currently told about.

#### Chat session modes

**`sticky` (default)**

If the request is a tool-call resume (trailing `role: "tool"` message(s) in `messages`): session id is **never consulted**, per "Follow-up" above — resolution is by `tool_call_id` alone.

Otherwise (a plain-text turn), resolve id in order: `cursor_session_id` → `session_id` → header `X-Cursor-Session-Id` → `X-Session-Id`.

- Id present and known for this caller → reuse agent; `send()` **only the last user message text**.
- Id present but unknown, or absent → create agent (given id if one was supplied, else `sess_` + random); return that id in the header; `send()` flattened full `messages`.

**`prefix`**

- If `messages[:-1]` is non-empty, lookup `sess_` + first 24 hex chars of SHA-256(`JSON.stringify({ prefix: messages[:-1], model, workspace })`). Hit → reuse; `send()` last user text.
- Miss or empty prefix → new agent; `send()` flattened full `messages`.
- After the run, alias the same agent under the hash of `messages + assistant reply`, so the next client request’s `messages[:-1]` matches.
- Non-empty `tools` → **400** (tool loop needs sticky ids).

Flattened new-agent prompt is lines of `"{role}: {content}"`, except: an
assistant message with `tool_calls` renders an extra
`"assistant: [called {name}({arguments}), ...]"` line (in addition to its
`content` line if non-empty), and a `role: "tool"` message renders as
`"tool [{tool_call_id}]: {content}"` so a replayed tool exchange still shows
which call was made and which result answers which call.

### `POST /v1/completions`

**501** Completions (`{ code: "unsupported" }`).

### `POST /v1/responses`

| Field | Required | Notes |
|---|---|---|
| `input` | yes | string, or array of text items / `function_call_output` |
| `model` | no | default `auto` |
| `instructions` | no | prepended as `system: …\n` on **first** create only |
| `previous_response_id` | no | follow-up: `send()` only new `input`, or resume parked tools |
| `store` | no | default `true`; `false` = ephemeral; `false` + tools → **400** |
| `stream` | no | Responses SSE if true |
| `tools` | no | function tools; other types → **501**; empty `[]` = text-only |
| `tool_choice` / `parallel_tool_calls` | no | ignored |
| `reasoning` / `reasoning_effort` | no | optional effort mapping |

`input` array items: strings; `{ type: "input_text", text }`; `{ type: "message", … }` / objects with `role` (content flattened like chat); objects with `text`; `{ type: "function_call_output", call_id, output }`. `input_image` / `image_url` / other types → **501**.

Unknown `previous_response_id`: **400** if the id is unknown globally; **404** if it exists only under another caller.

Non-stream **200** (enough for `client.responses.create()` / `.output_text`):

```json
{
  "id": "resp_…",
  "object": "response",
  "status": "completed",
  "model": "…",
  "created_at": <unix seconds>,
  "previous_response_id": null,
  "output": [{
    "type": "message",
    "id": "msg_…",
    "role": "assistant",
    "status": "completed",
    "content": [{ "type": "output_text", "text": "…" }]
  }],
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 }
}
```

`status` may be `completed`, `requires_action`, `cancelled`, or `failed` after the turn. Failed runs include `error: { message }` from Cursor `wait()`. Include `error` only on failed runs.

When parked: `status: "requires_action"`, `output` includes `{ type: "function_call", id, call_id, name, arguments, status: "completed" }` (and any `output_text` already produced).

Next POST: `previous_response_id` + `input` items `{ type: "function_call_output", call_id, output }`. New `resp_` id, **same** Cursor agent and **same** live `Run`. Do not `send()` a user message. Unknown `call_id` → **400**. Submitting outputs for only some of the currently parked `call_id`s does not error — see the equivalent Chat "Follow-up" note above; the remaining `function_call` output item(s) simply come back on the new `requires_action` response.

Stream (`event:` + `data:`):

1. `response.created` — skeleton object, `status: "in_progress"`, empty text
2. `response.output_text.delta` — `{ type, item_id, output_index: 0, delta }` for each assistant text delta
3. function-call argument deltas (from SDK `tool_call` / `onDelta` tool updates)
4. terminal: `response.completed` with the full object, **or** `response.requires_action` with the full parked object — **not** `response.completed` until `wait()` finishes

`onDelta` / `run.stream()` are observe-only; they do not replace `execute()`.

### `GET /v1/responses/{response_id}`

Auth + ownership. **200** stored object (status, output text, pending function calls, usage). Unknown / wrong caller → **404**. While parked, `status` is `requires_action`.

### `POST /v1/responses/{response_id}/cancel`

- No in-flight run → **409** `{ code: "already_terminal" }`
- Run does not `supports("cancel")` → **400** `{ code: "unsupported" }`
- Else reject every parked `execute()` promise, `run.cancel()`, clear `activeRun`, set `status: "cancelled"`, return the response object (**200**)

---

## 6. Identifiers

| Prefix | Used for |
|---|---|
| `chatcmpl_` | Chat completion id (UUID, no hyphens) |
| `resp_` | Responses id (also the registry key when `store: true`) |
| `msg_` | Output message id inside a response object |
| `fc_` | Responses `function_call` item id |
| `sess_` | Chat session id (random, client-supplied sticky id, or prefix hash) |

SDK `toolCallId` is reused as OpenAI `call_id` / Chat `tool_calls[].id`.

---

## 7. Client mapping (wire-compatible)

The OpenAI client is wire-compatible (`base_url`). Each turn is still a **minimized agent** run, not a token-for-token completion.

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:11434/v1", api_key="ollama")  # hosted-key
# client = OpenAI(base_url="http://127.0.0.1:11434/v1", api_key="crsr_...")  # passthrough
```

- Chat Completions: compatibility layer. Set `extra_body={"session_id": …}` or read `X-Cursor-Session-Id` from the first response to continue a sticky session. Tool follow-ups **must** send that id (same live `Run`).
- Responses: pass `previous_response_id` from the prior `id`. That is the native session handle. Submit tool results as `function_call_output` items on the next create.

Default `ask` can read `--workspace` with the narrow allowlist. Client `tools` replace those built-ins. `plan` / `agent` can edit the tree; that widens the agent and is opt-in.
