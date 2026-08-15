# Cursor OpenAI-compat proxy

Local Node server that speaks Ollama-style OpenAI `/v1` (models, chat completions, completions) plus stateful Responses, backed by `@cursor/sdk` local agents.

Each request is a Cursor **agent run**, not a raw completions model. Default conversation mode is `ask` so clients do not edit the workspace. Behavioral contract: [SPEC.md](SPEC.md).

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
    model="composer-2.5",
    messages=[{"role": "user", "content": "What is 3+4?"}],
).choices[0].message.content)

r1 = client.responses.create(model="composer-2.5", input="What is 3+4?")
r2 = client.responses.create(
    model="composer-2.5",
    input="Why?",
    previous_response_id=r1.id,
)
```

Binds `127.0.0.1` by default.

The SDK's `mode` field is `agent` or `plan`. `--agent-mode ask` omits that field and allowlists read-only tools (`read`, `grep`, `glob`, `ls`) so a completions client does not edit the workspace.

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
| `POST /v1/chat/completions` | Ollama drop-in; `stream` true/false; sticky session via header / body |
| `POST /v1/completions` | `prompt` → one user message |
| `POST /v1/responses` | Stateful via `previous_response_id` |
| `GET /v1/responses/{response_id}` | Stored response object |
| `POST /v1/responses/{response_id}/cancel` | Cancel an in-flight run |
| `GET /health` | Process liveness |

Not implemented (501): embeddings, vision, OpenAI tools, `n != 1`, `logprobs`.

### Chat session modes

`--session-mode sticky` (default): reuse `extra_body.session_id` / `cursor_session_id` or headers `X-Cursor-Session-Id` / `X-Session-Id`. If absent, create an agent and return the id in `X-Cursor-Session-Id`. Follow-ups `send()` only the latest user turn.

`--session-mode prefix`: hash `messages[:-1]` + model + workspace. Same prefix reuses the agent; a history change starts a new one.

### Responses

`previous_response_id` looks up the stored Cursor `Agent` and `send()`s only the new `input`. `store: false` is ephemeral (no chaining). Streaming uses Responses SSE event names (`response.created`, `response.output_text.delta`, `response.completed`).

## Tests

```bash
npm test
```

Default tests mock the SDK (no live key). Optional live smoke:

```bash
LIVE_SMOKE=1 CURSOR_API_KEY=crsr_... npm test -- tests/live.smoke.test.ts
```
