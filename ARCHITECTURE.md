# Architecture

Why this codebase is structured the way it is — module boundaries and the
reasoning behind them, not the wire contract (`SPEC.md`), the setup/usage
overview (`README.md`), or agent-process guidance (`AGENTS.md`).

**These are decisions made deliberately at a point in time, not immutable
laws.** Each section below explains the reasoning so a future change has it
available to reconsider, rather than needing to be re-derived from scratch —
the same spirit as `docs/dev/park-idle-heuristic.md`. Nothing here should be
read as "this must never change"; it should be read as "here's why it's this
way today, and what would have to be true for that to change."

## Layering

```
HTTP entry (app.ts, Hono)
  -> request mapping (mapping.ts)
  -> session orchestration (session/{orchestrate,registry,supervisor}.ts)
  -> backend abstraction (cursor/{backend,sdkBackend}.ts)
  -> SSE encoding (codec/*.ts)
```

`app.ts` owns HTTP routing, auth, and streaming wire-up; it has no session or
SDK logic of its own. `mapping.ts` translates between OpenAI JSON shapes and
this proxy's internal types in both directions, with no HTTP or SDK
awareness. `session/*` owns the stateful orchestration (which agent, which
run, what's parked) entirely in terms of the abstract `CursorBackend`
interface (`cursor/backend.ts`) — it never imports the concrete
`cursor/sdkBackend.ts` adapter. That boundary is load-bearing, not
cosmetic: a `/simplify` review this session proposed reusing a stringify
helper across `session/supervisor.ts` and `cursor/sdkBackend.ts`, and it was
rejected specifically because it would have added a value-level dependency
from the backend-agnostic session layer onto one concrete backend
implementation — exactly the kind of coupling this layering exists to
prevent. `codec/*.ts` only knows how to shape SSE frames; it has no opinion
on session state or the SDK.

## Why an in-memory `SessionRegistry`, not a store

This is a single-process local agent gateway (`README.md`'s "Is / Is not"):
one proxy process, one workspace, agents that must stay in the loop for ToS
reasons. There's no multi-process or multi-host deployment target that would
need shared, persisted session state, so `SessionRegistry` is a plain
in-memory map. If that deployment shape ever changes (e.g. running multiple
proxy replicas behind a load balancer), this is the component that would
need to move to a shared store — and every `Agent`/`Run` handle it holds
would need to become externally resumable, which the current Cursor SDK
usage doesn't attempt.

## Why a `Mutex` per session

A Cursor `Agent`/`Run` doesn't support overlapping `send()` calls against
the same agent. Each `SessionRecord` holds its own `Mutex` (`session/registry.ts`)
so a second request against the same session (a race between two client
retries, for instance) queues behind the first instead of corrupting shared
run state.

## The tool-call parking mechanism

OpenAI's tool-calling protocol is turn-based and synchronous from the
client's point of view: the server responds once with `tool_calls`/
`requires_action`, the client executes the tool itself, and posts the result
back. The Cursor SDK's custom-tool mechanism is the opposite shape: a
client-declared tool's `execute()` callback is invoked *by the SDK, inside
the live run*, and that call expects an eventual return value — there's no
"pause the run and hand control back to the caller" primitive.

`RunSupervisor` (`session/supervisor.ts`) bridges these: `wrapCustomTools()`'s
`execute()` doesn't compute a result — it parks a promise (keyed by the
SDK's tool-call id) and returns that promise to the SDK, which the SDK
happily awaits indefinitely. The HTTP layer detects "the model has stopped
issuing new tool calls for now" via a short idle heuristic
(`PARK_IDLE_MS`, detailed in `docs/dev/park-idle-heuristic.md` — including
why it's a fixed constant, not a CLI flag) and responds to the client with
whatever's parked. The next client request resolves those parked promises
directly, without a new `agent.send()`, letting the still-live SDK run
continue from exactly where it paused.

This mechanism has already been revisited once mid-project: adding
"forward Cursor's reasoning summaries" support required threading a new
`"thinking"` event type through the same stream-draining loop that captures
tool calls and text, and a later live-only bug (the `chains Responses 3+4
then why` e2e failure) surfaced because a test's assumption about `output`
item ordering predated that change. Treat this section, and the code it
describes, as a living record that needs re-checking whenever a new SDK
event type or output shape is introduced — not a one-time design that stays
correct on its own.

## Two session models, one per API

Chat Completions sessions (`--session-mode sticky` / `prefix`) are a
**hint, not a requirement** — OpenAI's own convention is that a Chat client
resends full message history on every call, so this proxy can always
recover (recreate the agent and replay history) if a session id or prefix
hash doesn't match anything live. Responses' `previous_response_id` is
different: it's Responses API's *native* session handle, and it maps
directly onto Cursor's own stateful `Agent` — there's no equivalent
"resend everything" fallback convention for Responses, so the mapping is
more direct. This is why the two APIs aren't unified behind one internal
session-resolution path: they start from genuinely different client-side
statefulness assumptions.

## Client tools replace Cursor's built-ins

`README.md` states the policy (client-declared `tools` replace, not
supplement, Cursor's own `read`/`grep`/shell). The mechanism: every agent is
created with `settingSources: []` and no `mcpServers`, so no ambient Cursor
config is ever loaded; when the request has a non-empty `tools` array, the
SDK allowlist becomes `["mcp"]` plus in-process `local.customTools` built
from that request — Cursor's built-ins are never offered alongside them.
This is a deliberate minimize-the-agent choice, not an oversight: the
proxy's job is to be "as little agent as possible" while still satisfying
the ToS requirement that an agent stay in the loop at all.

**Deliberate exception**: `--agent-mode plan` / `agent` intentionally widens
this default, opting into the SDK's own built-in tool set (including
shell/edit) when the request has no client `tools`. This isn't an
inconsistency with the minimize-agent goal — it's an explicit opt-in for
operators who want a more capable local agent, layered on top of the same
mechanism rather than replacing it.

## Effect Schema only on the inbound side

`decodeJson()` (`http/validate.ts`) validates every request body against an
`effect/Schema` definition (`http/schemas.ts`) before any handler logic
runs — this is a real trust boundary: request bodies are untrusted external
input. Outbound response construction (`mapping.ts`'s `toChatCompletion()`/
`toResponseObject()`) deliberately does **not** route through Schema
encoding. This was raised directly by an external code review during this
project and rejected: the values going into those functions are entirely
our own code's output, already shape-checked at compile time by TypeScript;
routing them through Schema encoding would validate data that has no
untrusted origin, adding a heavier abstraction for no corresponding safety
gain. Schema's value here is specifically about the untrusted/trusted
boundary, not "validate everything everywhere."

## Small named functions over one generic dispatcher

Two places in this codebase share an internal shape across several small
functions, and both were deliberately *not* collapsed into one fully
generic function, for the same reason:

- `mapping.ts`'s `effortParams()`/`fastParam()`/`contextParam()`/
  `thinkingParam()` share an internal `catalogParam()` shell (find, validate,
  return), but stay separate exported functions because `effort`/`fast`/
  `context`/`thinking` are four distinct OpenAI-facing request concepts —
  merging them into one parameterized function would hide that distinction
  behind a config-flag-driven call site.
- `codec/chatSse.ts`'s `chatRoleChunk()`/`chatDeltaChunk()`/
  `chatReasoningChunk()`/`chatToolCallChunk()`/`chatFinishChunk()` share an
  internal `chatChunk()` envelope for the same reason — each name is a
  distinct SSE wire event, not an arbitrary variation.

The pattern in both cases: factor out the literally-identical *shell*
(lookup/validate, or envelope construction), but keep the semantically
distinct pieces (which param, which delta) as separate, named, injected
values rather than generalizing the dispatch itself. When a future addition
doesn't fit this shell cleanly (a fifth catalog param with genuinely
different validation logic, a chunk type that isn't a `{delta, finish_reason}`
pair), that's a signal to add a new sibling function, not to bend the shared
shell to fit it.

## Known open issue

`usage.total_tokens` doesn't equal `prompt_tokens + completion_tokens` in
the live backend for sticky/resumed sessions — see
`docs/dev/usage-total-tokens-mismatch.md` for the repro and proposed fix
(not yet implemented).
