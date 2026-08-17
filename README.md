# Cursor OpenAI-compat proxy

A **minimized agent gateway**: Cursor IDE models on an OpenAI-shaped HTTP endpoint (`base_url`).

Cursor’s models are only available through a local agent; ToS requires that agent to stay in the loop. This proxy keeps the agent because it must, then gives it as little work as possible — OpenAI JSON is the **wire**, the Cursor agent is a **required runtime**, not the product. Behavioral contract: [SPEC.md](SPEC.md).

## What this is / is not

**Is:** HTTP access to Cursor IDE models from existing OpenAI clients. Default `--agent-mode ask` is a narrow read-only allowlist because some agent toolset must exist. When the client sends function tools, those **replace** Cursor built-ins and park on the live run until the client posts the result.

**Is not:** LiteLLM, raw token completions, or an autonomous coding agent you point at a repo. `temperature`, `max_tokens`, and JSON mode (`response_format`) are ignored. Expect agent-loop latency, not a 30-token completion.

Client `tools` replace `read` / `grep` / `shell` on purpose (minimize the agent). Re-expose repo ops as client tools if you need both. Chat Completions is compatibility: tool follow-ups resolve by `tool_call_id` alone (standard OpenAI tool-calling protocol) — no need to capture `X-Cursor-Session-Id`, which is only useful for reusing the live agent across plain-text turns. **Responses** (`previous_response_id`) is the native session handle. `--agent-mode plan` / `agent` widens the agent (shell, edits); that is opt-in, against the default of minimizing it.

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
# Hosted-key (dummy api_key on the OpenAI client)
CURSOR_API_KEY=crsr_... npx tsx src/index.ts --port 11434

# Passthrough (client sends the real Cursor key)
npx tsx src/index.ts --port 11434
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

The agent stays in the loop for ToS. The allowlist is how this proxy **minimizes** it: do **not** set `autoReview` and do **not** enable sandbox as a safety substitute. Local SDK agents already run offered tools without a human approval prompt.

What the model can call is the SDK **allowlist** on `Agent.create`:

- `--agent-mode ask` with no OpenAI `tools`: `read`, `grep`, `glob`, `ls` (no shell/edit) — a narrow set because some toolset must exist
- A non-empty OpenAI `tools` array: `["mcp"]` plus in-process `local.customTools` from that request. Cursor built-ins (including `read` / `grep` / shell) are **not** offered, so Cursor is not the tool runner
- `--agent-mode plan` / `agent` with no OpenAI `tools`: the SDK default set (including shell) — opt-in; this widens the agent

The proxy caller decides what may run. Do not “turn on safety” by adding `autoReview`; custom tools would stall or still run, and built-ins would still be in the toolset.

Ambient Cursor MCP (`~/.cursor/mcp.json`, project `.cursor/mcp.json`, plugins) is never loaded: every agent uses `settingSources: []` and no `mcpServers`. Only tools supplied on the HTTP request are available.

**Every agent runs isolated, unconditionally — not an opt-in flag.** The allowlist above controls *which* tools are offered; isolation controls *what they can reach*. Every agent gets its own freshly created, empty temporary directory as `cwd` — never the operator's real project, never a configurable `--workspace`. On top of that, this process's `HOME` / `USERPROFILE` / `CURSOR_CONFIG_DIR` are overridden once at startup to another isolated directory, so nothing can load the operator's real Cursor config either. This applies to `ask` mode's read-only tools just as much as `plan`/`agent` mode's `shell`/`edit` — there is no mode or flag that points an agent at a real, meaningful filesystem. See [SPEC.md](SPEC.md) for the exact mechanism and a documented future direction (real OS-level sandboxing).

Chat tool follow-ups resolve by the `tool_call_id` the client already echoes back — no proxy-specific session id needed; that's what lets a plain OpenAI-compatible client complete a tool-calling round with zero awareness of this proxy's extensions. Creating a *new* tool-using conversation still needs **sticky** mode, since prefix mode rejects `tools` (an agent's tool permissions are fixed at creation time). Responses tool loops use `previous_response_id` plus `function_call_output` items; `store: false` cannot be combined with tools. Answering only some of the currently pending tool calls is fine — the response reports whatever's still outstanding instead of erroring. Full resolution order: [SPEC.md](SPEC.md).

### CLI flags

| Flag | Default | Meaning |
|---|---|---|
| `--port` | `11434` | Listen port (`0` = OS-assigned) |
| `--host` | `127.0.0.1` | Bind address |
| `--cursor-api-key` | `$CURSOR_API_KEY` | Hosted Cursor key; omit for passthrough |
| `--session-mode` | `sticky` | Chat Completions sessions: `sticky` or `prefix` |
| `--agent-mode` | `ask` | Cursor conversation mode: `ask` (narrow read-only allowlist), `plan`, or `agent` |

## HTTP surface

| Endpoint | Behavior |
|---|---|
| `GET /v1/models` | Cursor catalog ids **and** aliases |
| `GET /v1/models/{id}` | Same lookup; 404 if unknown |
| `GET /v1/model/info` | LiteLLM-shaped per-model info: id/provider/mode always; display name, description, aliases, params, and variants when the catalog has them; never cost or token-limit data |
| `POST /v1/chat/completions` | Chat Completions wire; each call is an agent turn; sticky session via header / body; function tools park as `tool_calls` |
| `POST /v1/responses` | Native session handle via `previous_response_id`; function tools park as `requires_action` |
| `GET /v1/responses/{response_id}` | Stored response object |
| `POST /v1/responses/{response_id}/cancel` | Cancel an in-flight run (rejects parked tools) |
| `GET /health` | Process liveness |

Not implemented (501): embeddings, vision, `/v1/completions`, non-function tool types, `n != 1`, `logprobs`. Sampling knobs and `response_format` are accepted and ignored.

Reasoning-model summaries (Cursor's own condensed reasoning text, not a raw trace) are forwarded as they arrive: Chat gets `reasoning_content` (streamed delta chunks and the final message), Responses gets `response.reasoning_summary_text.delta` events and a `reasoning` output item — omitted entirely when a run produced none. See [SPEC.md](SPEC.md) for the exact shapes.

### Chat session modes

`--session-mode sticky` (default): a tool-result follow-up (trailing `role: "tool"` message(s)) resolves by `tool_call_id` alone — no session id involved at all. Otherwise (plain-text turns): reuse `extra_body.session_id` / `cursor_session_id` or headers `X-Cursor-Session-Id` / `X-Session-Id`. If absent, create an agent and return the id in `X-Cursor-Session-Id`. Follow-ups `send()` only the latest user turn.

`--session-mode prefix`: hash `messages[:-1]` + model. Same prefix reuses the agent; a history change starts a new one. Cannot be combined with OpenAI `tools`.

### Responses

`previous_response_id` looks up the stored Cursor `Agent` and `send()`s only the new `input`. When the prior response is `requires_action`, submit `{ type: "function_call_output", call_id, output }` instead — that resumes the live run without `send()`. `store: false` is ephemeral (no chaining, no tools). Streaming uses Responses SSE event names (`response.created`, `response.output_text.delta`, `response.completed` or `response.requires_action`).

## Tests

```bash
npm test
```

Default tests mock the SDK (no live key). Optional live HTTP e2e (starts the proxy on an ephemeral port in-process):

```bash
LIVE_SMOKE=1 CURSOR_API_KEY=crsr_... npm test -- tests/e2e.test.ts
```

`E2E_SPAWN=1` starts the real CLI (`tsx src/index.ts --port 0`) as a subprocess instead:

```bash
LIVE_SMOKE=1 E2E_SPAWN=1 CURSOR_API_KEY=crsr_... npm test -- tests/e2e.test.ts
```
