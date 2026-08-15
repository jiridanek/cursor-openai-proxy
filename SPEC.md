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

Default `model` when omitted or blank: `auto`. A model id that appears in `GET /v1/models` can still fail at run time (for example team admin blocks). Chat Completions then return **500** `{ error: { type: "internal_error", code: "run_failed", message } }` with the Cursor `wait()` error. Responses stay **200** with `status: "failed"` and `error: { message }`.

`reasoning_effort` (chat) and `reasoning_effort` / `reasoning.effort` (responses) are mapped onto `model.params` **only** when `Cursor.models.list()` reports a parameter id `effort` or `reasoning_effort` that includes the requested value. Otherwise they are ignored. Applied at **agent create**, not on follow-up `send()`.

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

### `POST /v1/embeddings`

**501** Embeddings.

### `POST /v1/chat/completions`

Request (Effect Schema; extra fields ignored):

| Field | Required | Notes |
|---|---|---|
| `messages` | yes | array of `{ role, content?, name?, tool_call_id?, tool_calls? }`; `role` may be `tool` |
| `model` | no | default `auto` |
| `stream` | no | SSE if true |
| `n` | no | only `1` or omitted; else **400** |
| `tools` | no | function tools; other types → **501**; empty `[]` = text-only |
| `tool_choice` / `parallel_tool_calls` | no | ignored |
| `logprobs` | no | if truthy → **501** |
| `session_id` / `cursor_session_id` | no | sticky session id (also `X-Cursor-Session-Id` / `X-Session-Id`) |
| `reasoning_effort` | no | optional `model.params` mapping |
| `temperature`, `top_p`, `seed`, `max_tokens`, `max_completion_tokens` | no | ignored |

`content` may be a string, `null`, or an array of parts. Parts with `image_url` or `type` `image_url` / `input_image` → **501**. Text parts are concatenated.

The tool loop **requires sticky sessions** to *create* a new tool-using conversation: `--session-mode prefix` plus a non-empty `tools` array → **400** (an agent's tool permissions are fixed at creation time, so a content-hashed session can't be safely upgraded to support tools later). Return `X-Cursor-Session-Id` as a convenience. Resuming an already-parked tool call does **not** require that id, though: if the follow-up's session id is absent or unknown, the caller's own sessions are searched for one whose parked call matches the `tool_call_id` being resolved (see "Follow-up" below); only if that also misses does resolution fall back to starting a fresh agent with the full history replayed.

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
2. zero or more content chunks: `delta: { content }`
3. if parked: `delta.tool_calls` (id/name then argument string deltas), then `finish_reason: "tool_calls"` — do **not** emit `finish_reason: "stop"`
4. else: stop chunk: `delta: {}`, `finish_reason: "stop"`
5. `[DONE]`

If `wait()` returns `error`, skip the stop chunk and emit `data: { error: { message, type: "internal_error", code: "run_failed" } }` then `[DONE]`. Non-stream failed runs are **500** instead.

Follow-up: last messages with `role: "tool"` + `tool_call_id` **resolve** the parked `execute()`; they are **not** `agent.send()`. Resolution order: (1) an explicit `session_id`/`cursor_session_id`/header, if it names a session waiting on this call; (2) otherwise, the caller's own sessions are searched for one parked on the given `tool_call_id`; (3) otherwise, a fresh agent is created and the full history (including the tool call and its result) is replayed as its prompt, instead of erroring. A `tool_call_id` the session found in (1)/(2) doesn't recognize → **400** `Unknown call_id`. A new user turn while parked → **409** `{ code: "requires_action" }`.

#### Chat session modes

**`sticky` (default)**

Resolve id in order: `cursor_session_id` → `session_id` → header `X-Cursor-Session-Id` → `X-Session-Id`.

- Id present and known for this caller → reuse agent; `send()` **only the last user message text** (unless the follow-up is a parked-tool resume).
- Id present but unknown, or absent, and the follow-up is a tool-call resume (trailing `role: "tool"` message(s)) → look up the caller's own sessions by `tool_call_id` instead; a match resumes that live agent's parked `execute()`, no session id required.
- No id, no id match, and no call_id match → create agent (given id if one was supplied, else `sess_` + random); return that id in the header; `send()` flattened full `messages`.

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

Next POST: `previous_response_id` + `input` items `{ type: "function_call_output", call_id, output }`. New `resp_` id, **same** Cursor agent and **same** live `Run`. Do not `send()` a user message. Unknown `call_id` → **400**.

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
