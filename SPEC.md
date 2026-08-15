# Cursor OpenAI-compat proxy — specification

This document is the behavioral contract for `tools/cursor-openai-proxy`. It describes what clients can rely on. Implementation lives next to this file; [README.md](README.md) covers how to run it.

The proxy is an **Ollama-style OpenAI `/v1` server** plus **stateful Responses**. It is **not** a raw completions model. Every generation request becomes one Cursor **local agent run**. Inference still uses Cursor-hosted models; “local” means the agent loop and workspace files stay on this machine.

Default model id: `auto`. Default bind: `127.0.0.1:11434`.

---

## 1. Non-goals

This version does **not**:

- Run cloud agents (`bc-` ids)
- Expose Cursor as a public multi-tenant completions product
- Implement OpenAI embeddings, vision, function-calling / tools, Assistants, Realtime, or the Conversations resource
- Honor sampling knobs (`temperature`, `top_p`, `seed`, `max_tokens`, `max_completion_tokens`) — they are accepted and ignored (logged when `DEBUG` is set)
- Persist sessions across process restarts (in-memory only)

---

## 2. Process model

- Runtime: Node.js 22.13+
- One process, one Hono app, one in-memory `SessionRegistry`
- Cursor SDK default import (`@cursor/sdk`), local runtime only: `local: { cwd: --workspace }`
- Chat Completions and Responses share the same registry and agents. They must not each own a separate agent pool.

CLI:

| Flag | Default | Meaning |
|---|---|---|
| `--port` | `11434` | Listen port (positive integer) |
| `--host` | `127.0.0.1` | Bind address |
| `--workspace` | process cwd | Local agent working directory |
| `--cursor-api-key` | `$CURSOR_API_KEY` | Hosted Cursor key; omit (and unset env) for passthrough |
| `--session-mode` | `sticky` | Chat session resolution: `sticky` \| `prefix` |
| `--agent-mode` | `ask` | `ask` \| `plan` \| `agent` |

`--cursor-api-key` wins over `$CURSOR_API_KEY`. Empty/whitespace keys are treated as absent.

### Agent mode mapping

The SDK `mode` field is only `"agent" | "plan"`.

| `--agent-mode` | SDK `mode` | Tools |
|---|---|---|
| `ask` | omitted | allowlist `read`, `grep`, `glob`, `ls` (read-only; no workspace edits) |
| `plan` | `"plan"` | SDK default toolset |
| `agent` | `"agent"` | SDK default toolset |

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
- Record fields: `{ agent, activeRun?, outputText, status, model, createdAt, previousResponseId, stored, usage? }`
- Per-agent mutex: overlapping `send()`s on the same agent **queue** (serialize). Cancel does not take that lock.
- Unknown id, or id that exists only under a **different** caller hash:
  - `GET` / `POST …/cancel` → **404** (not 403)
  - `POST /v1/responses` with `previous_response_id` that exists under another caller → **404**
  - `POST /v1/responses` with a `previous_response_id` that exists under **no** caller → **400**

Status values: `in_progress` | `completed` | `cancelled` | `failed`.

`store: false` (Responses): agent is not registered; after the run it is disposed; `previous_response_id` cannot chain to it.

---

## 5. HTTP surface

OpenAI-shaped JSON errors:

```json
{ "error": { "message": "…", "type": "invalid_request_error", "code": "…" } }
```

Unhandled exceptions → **500** `{ type: "internal_error", code: "internal" }`. Invalid JSON / schema → **400**.

Unimplemented features use **501** `{ code: "unsupported" }` unless noted.

Default `model` when omitted or blank: `auto`. A model id that appears in `GET /v1/models` can still fail at run time (for example team admin blocks). Chat Completions and Completions then return **500** `{ error: { type: "internal_error", code: "run_failed", message } }` with the Cursor `wait()` error. Responses stay **200** with `status: "failed"` and `error: { message }`.

`reasoning_effort` (chat) and `reasoning_effort` / `reasoning.effort` (responses) are mapped onto `model.params` **only** when `Cursor.models.list()` reports a parameter id `effort` or `reasoning_effort` that includes the requested value. Otherwise they are ignored. Applied at **agent create**, not on follow-up `send()`.

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
| `messages` | yes | array of `{ role, content?, name? }` |
| `model` | no | default `auto` |
| `stream` | no | SSE if true |
| `n` | no | only `1` or omitted; else **400** |
| `tools` | no | if present → **501** |
| `logprobs` | no | if truthy → **501** |
| `session_id` / `cursor_session_id` | no | sticky session id (also `X-Cursor-Session-Id` / `X-Session-Id`) |
| `reasoning_effort` | no | optional `model.params` mapping |
| `temperature`, `top_p`, `seed`, `max_tokens`, `max_completion_tokens` | no | ignored |

`content` may be a string, `null`, or an array of parts. Parts with `image_url` or `type` `image_url` / `input_image` → **501**. Text parts are concatenated.

Response header: `X-Cursor-Session-Id` = the resolved session id.

Non-stream **200**:

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

`usage` is copied from the Cursor run when the runtime reports it; otherwise zeros.

Stream: `text/event-stream`. Frames are `data: <json>\n\n` (no `event:` name), then `data: [DONE]\n\n`:

1. role chunk: `delta: { role: "assistant" }`, `finish_reason: null`
2. one or more content chunks: `delta: { content }`
3. stop chunk: `delta: {}`, `finish_reason: "stop"`
4. `[DONE]`

If `wait()` returns `error`, skip the stop chunk and emit `data: { error: { message, type: "internal_error", code: "run_failed" } }` then `[DONE]`. Non-stream failed runs are **500** instead.

Only assistant **text** deltas are forwarded. Cursor tool-call internals are not emitted as content.

#### Chat session modes

**`sticky` (default)**

Resolve id in order: `cursor_session_id` → `session_id` → header `X-Cursor-Session-Id` → `X-Session-Id`.

- Id present and known for this caller → reuse agent; `send()` **only the last user message text**.
- Id present but unknown → create agent with that id; `send()` flattened full `messages`.
- Id absent → create agent (`sess_` + random); return that id in the header; `send()` flattened full `messages`.

**`prefix`**

- If `messages[:-1]` is non-empty, lookup `sess_` + first 24 hex chars of SHA-256(`JSON.stringify({ prefix: messages[:-1], model, workspace })`). Hit → reuse; `send()` last user text.
- Miss or empty prefix → new agent; `send()` flattened full `messages`.
- After the run, alias the same agent under the hash of `messages + assistant reply`, so the next client request’s `messages[:-1]` matches.

Flattened new-agent prompt is lines of `"{role}: {content}"`.

### `POST /v1/completions`

Thin wrapper: `prompt` (string or string array joined) is sent as the user text to a **new** chat session (not sticky/prefix reuse). `n`, `tools`, `logprobs` rules match chat.

Non-stream **200**: `{ id: "cmpl_…", object: "text_completion", choices: [{ text, index: 0, finish_reason: "stop" }], usage, model, created }`.

Stream: `text_completion` chunks with `choices[0].text` deltas, then a stop chunk, then `[DONE]`.

### `POST /v1/responses`

| Field | Required | Notes |
|---|---|---|
| `input` | yes | string, or array of text items |
| `model` | no | default `auto` |
| `instructions` | no | prepended as `system: …\n` on **first** create only |
| `previous_response_id` | no | follow-up: `send()` only new `input` |
| `store` | no | default `true`; `false` = ephemeral |
| `stream` | no | Responses SSE if true |
| `tools` | no | if present → **501** |
| `reasoning` / `reasoning_effort` | no | optional effort mapping |

`input` array items: strings; `{ type: "input_text", text }`; `{ type: "message", … }` / objects with `role` (content flattened like chat); objects with `text`. `input_image` / `image_url` / other types → **501**.

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

`status` may be `completed`, `cancelled`, or `failed` after the run. Failed runs include `error: { message }` from Cursor `wait()`.

Stream (`event:` + `data:`):

1. `response.created` — skeleton object, `status: "in_progress"`, empty text
2. `response.output_text.delta` — `{ type, item_id, output_index: 0, delta }` for each assistant text delta
3. `response.completed` — full object with final text and status

Do not leak Cursor tool-call payloads as `output_text`.

### `GET /v1/responses/{response_id}`

Auth + ownership. **200** stored object (status, output text, usage). Unknown / wrong caller → **404**.

### `POST /v1/responses/{response_id}/cancel`

- No in-flight run → **409** `{ code: "already_terminal" }`
- Run does not `supports("cancel")` → **400** `{ code: "unsupported" }`
- Else `run.cancel()`, clear `activeRun`, set `status: "cancelled"`, return the response object (**200**)

---

## 6. Identifiers

| Prefix | Used for |
|---|---|
| `chatcmpl_` | Chat completion id (UUID, no hyphens) |
| `cmpl_` | Legacy completions id |
| `resp_` | Responses id (also the registry key when `store: true`) |
| `msg_` | Output message id inside a response object |
| `sess_` | Chat session id (random, client-supplied sticky id, or prefix hash) |

---

## 7. Client mapping (Ollama drop-in)

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:11434/v1", api_key="ollama")  # hosted-key
# client = OpenAI(base_url="http://127.0.0.1:11434/v1", api_key="crsr_...")  # passthrough
```

- Chat Completions: set `extra_body={"session_id": …}` or read `X-Cursor-Session-Id` from the first response to continue a sticky session.
- Responses: pass `previous_response_id` from the prior `id`. That is the native session handle.

Each turn is an agent run against `--workspace`. It can read the tree (and, unless `ask`, edit it). It is not a token-for-token chat model.
