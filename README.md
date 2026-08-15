# Cursor OpenAI-compat proxy

Local Node server that speaks Ollama-style OpenAI `/v1` (models, chat completions) plus stateful Responses, backed by `@cursor/sdk` local agents.

Each request is a Cursor **agent run**, not a raw completions model. Default conversation mode is `ask` so clients do not edit the workspace. OpenAI function tools are passed through via `local.customTools` (the Cursor run stays alive until the client posts the tool result). Behavioral contract: [SPEC.md](SPEC.md).

## Setup

Requires Node.js 22.13+.

```bash
cd tools/cursor-openai-proxy
npm install
```

## Auth modes

Every request must send `Authorization: Bearer …` (the OpenAI `api_key`). That value is always the session-isolation namespace.

**Hosted-key mode** — pass `--cursor-api-key` and/or set `CURSOR_API_KEY` at startup. All `Agent.create` / `Cursor.models.list` calls use that Cursor key. The request Bearer is an arbitrary tenant id (`ollama` is fine).

**Passthrough mode** — start with no startup key. The request Bearer **is** the Cursor key (`crsr_…`). Dummy values such as `ollama` and `sk-dummy` are rejected with 401.

## Run

```bash
# Hosted-key (Ollama-style dummy api_key on the client)
CURSOR_API_KEY=crsr_... npx tsx src/index.ts --port 11434 --workspace .

# Passthrough (client sends the real Cursor key)
npx tsx src/index.ts --port 11434 --workspace .
```

```python
from openai import OpenAI

# Hosted-key
client = OpenAI(base_url="http://127.0.0.1:11434/v1", api_key="ollama")
# Passthrough
client = OpenAI(base_url="http://127.0.0.1:11434/v1", api_key="crsr_...")

print(client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "What is 3+4?"}],
).choices[0].message.content)

r1 = client.responses.create(model="auto", input="What is 3+4?")
r2 = client.responses.create(
    model="auto",
    input="Why?",
    previous_response_id=r1.id,
)
```

Binds `127.0.0.1` by default.

### Tools and YOLO

Local SDK agents already run offered tools without a human approval prompt. This proxy keeps that: it does **not** set `autoReview` and does **not** enable sandbox as a safety substitute.

What the model can call is the SDK **allowlist** on `Agent.create`:

- `--agent-mode ask` with no OpenAI `tools`: `read`, `grep`, `glob`, `ls` (no shell/edit)
- A non-empty OpenAI `tools` array: `["mcp"]` plus in-process `local.customTools` from that request. Cursor built-ins (including shell) are not offered.
- `--agent-mode plan` / `agent` with no OpenAI `tools`: the SDK default set (including shell)

The proxy caller decides what may run. Do not “turn on safety” by adding `autoReview`; custom tools would stall or still run, and built-ins would still be in the toolset.

Ambient Cursor MCP (`~/.cursor/mcp.json`, project `.cursor/mcp.json`, plugins) is never loaded: every agent uses `settingSources: []` and no `mcpServers`. Only tools supplied on the HTTP request are available.

Chat tool loops need **sticky** sessions (`X-Cursor-Session-Id`). Prefix session mode rejects `tools`. Responses tool loops use `previous_response_id` plus `function_call_output` items; `store: false` cannot be combined with tools.

### CLI flags

| Flag | Default | Meaning |
|---|---|---|
| `--port` | `11434` | Listen port |
| `--host` | `127.0.0.1` | Bind address |
| `--workspace` | cwd | Local agent `cwd` |
| `--cursor-api-key` | `$CURSOR_API_KEY` | Hosted Cursor key; omit for passthrough |
| `--session-mode` | `sticky` | Chat Completions sessions: `sticky` or `prefix` |
| `--agent-mode` | `ask` | Cursor conversation mode: `ask` (read-only tool allowlist), `plan`, or `agent` |

## HTTP surface

| Endpoint | Behavior |
|---|---|
| `GET /v1/models` | Cursor catalog ids **and** aliases |
| `GET /v1/models/{id}` | Same lookup; 404 if unknown |
| `POST /v1/chat/completions` | Ollama drop-in; `stream` true/false; sticky session via header / body; function tools park as `tool_calls` |
| `POST /v1/responses` | Stateful via `previous_response_id`; function tools park as `requires_action` |
| `GET /v1/responses/{response_id}` | Stored response object |
| `POST /v1/responses/{response_id}/cancel` | Cancel an in-flight run (rejects parked tools) |
| `GET /health` | Process liveness |

Not implemented (501): embeddings, vision, `/v1/completions`, non-function tool types, `n != 1`, `logprobs`.

### Chat session modes

`--session-mode sticky` (default): reuse `extra_body.session_id` / `cursor_session_id` or headers `X-Cursor-Session-Id` / `X-Session-Id`. If absent, create an agent and return the id in `X-Cursor-Session-Id`. Follow-ups `send()` only the latest user turn. Tool-result follow-ups must send that id and `role: "tool"` messages.

`--session-mode prefix`: hash `messages[:-1]` + model + workspace. Same prefix reuses the agent; a history change starts a new one. Cannot be combined with OpenAI `tools`.

### Responses

`previous_response_id` looks up the stored Cursor `Agent` and `send()`s only the new `input`. When the prior response is `requires_action`, submit `{ type: "function_call_output", call_id, output }` instead — that resumes the live run without `send()`. `store: false` is ephemeral (no chaining, no tools). Streaming uses Responses SSE event names (`response.created`, `response.output_text.delta`, `response.completed` or `response.requires_action`).

## Tests

```bash
npm test
```

Default tests mock the SDK (no live key). Optional live smoke:

```bash
LIVE_SMOKE=1 CURSOR_API_KEY=crsr_... npm test -- tests/live.smoke.test.ts
```
