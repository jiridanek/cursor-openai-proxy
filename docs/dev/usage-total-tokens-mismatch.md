# `usage.total_tokens` doesn't equal `prompt_tokens + completion_tokens`

**Status:** observed, not yet fixed. Root cause narrowed to the Cursor SDK's
own reported `totalTokens`; this proxy currently forwards it verbatim.

## Symptom

A user reported `goose`'s in-UI token counter growing in a way that looked
inconsistent turn to turn (small increases, occasional apparent decreases)
across a run of repeated, trivial `say gay` messages in one sticky session.

The counter itself was confirmed working (see the `stream_options.include_usage`
fix, `a3764ac`) — this is a separate, follow-up observation about the
*values* being reported, not whether they're reported at all.

## Test

Six sequential `POST /v1/chat/completions` requests against the live proxy
(`http://localhost:11434`, `session_mode: sticky`, `auth_mode: hosted`), same
`session_id` reused via the `X-Cursor-Session-Id` response header, each with
an identical trivial body:

```bash
curl -sS http://localhost:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-dummy" \
  -H "X-Cursor-Session-Id: $SID" \
  -H "Content-Type: application/json" \
  -d "{\"stream\":true,\"stream_options\":{\"include_usage\":true},\"session_id\":\"$SID\",\"messages\":[{\"role\":\"user\",\"content\":\"say gay\"}]}"
```

(the first request omits `X-Cursor-Session-Id` / `session_id` to create the
session and capture `$SID` from the response header). `stream_options:
{include_usage: true}` was used to get the raw, unrounded `usage` object
from the trailing SSE chunk.

## Observed data

| turn | `prompt_tokens` | `completion_tokens` | `prompt+completion` | `total_tokens` (as reported) |
|---|---|---|---|---|
| 1 | 4486 | 34 | 4520 | **4987** |
| 2 | 9118 | 37 | 9155 | **18198** |
| 3 | 4617 | 19 | 4636 | **9194** |
| 4 | 4675 | 15 | 4690 | **9306** |
| 5 | 4729 | 20 | 4749 | **9423** |
| 6 | 4788 | 18 | 4806 | **9534** |

`total_tokens` never equals `prompt_tokens + completion_tokens` — it is
consistently roughly **2×** that sum on every turn (including turn 1, the
very first call on a freshly created agent, so this isn't purely an artifact
of session resumption). `prompt_tokens` itself also spikes anomalously on
turn 2 (~2× turn 1's value) before settling into a small, steady, expected
per-turn growth from turn 3 onward (+55-60 tokens/turn, consistent with a
sticky session slowly accumulating conversation history).

## Why this matters

The OpenAI Chat Completions contract guarantees `total_tokens ==
prompt_tokens + completion_tokens` for a given response. Any client that
tracks context-window usage from `usage.total_tokens` (as a simple
"tokens used out of N" meter would) will see a number that's roughly double
what it should be, and — because the ratio isn't perfectly stable turn to
turn (see turn 1 vs turns 2-6) — the growth won't look cleanly linear either.
This is a strong candidate root cause for the original "is this rate of
growth expected?" question about goose's counter.

## Root cause

`toUsage()` / `toResponseUsage()` in `src/mapping.ts` forward the Cursor
SDK's own `TokenUsage.totalTokens` field verbatim:

```ts
export function toUsage(usage: TokenUsage | undefined) {
  return {
    prompt_tokens: usage?.inputTokens ?? 0,
    completion_tokens: usage?.outputTokens ?? 0,
    total_tokens: usage?.totalTokens ?? 0,
  };
}
```

which is itself a straight passthrough of `result.usage.totalTokens` from
the real `@cursor/sdk` run outcome (`src/cursor/sdkBackend.ts:74-78`). The
SDK's `totalTokens` does not appear to follow the `input + output` invariant
in sticky/resumed sessions — this proxy has never computed it independently.

## Proposed fix (not yet implemented)

Compute `total_tokens` as `prompt_tokens + completion_tokens` in
`toUsage`/`toResponseUsage` instead of trusting the backend's own
`totalTokens`, matching the OpenAI spec's own invariant regardless of what
the underlying agent SDK reports internally. Add a regression test that
feeds a fake backend usage where `totalTokens` deliberately disagrees with
`inputTokens + outputTokens` and asserts the wire response's `total_tokens`
is the sum, not the backend's raw field.

## Background research: where the fixed per-turn token floor comes from

A follow-up question ("is this rate of growth expected?") led to asking
whether the ~4.5-8k fixed overhead per turn is Cursor's own system prompt,
and whether it can be minimized or eliminated from this proxy.

**`@cursor/sdk`'s `AgentOptions` has no `systemPrompt` / `instructions` field
for the primary agent.** Checked
`node_modules/@cursor/sdk/dist/esm/agent/options.d.ts` in full: the only
prompt-like field anywhere in the options surface is `AgentDefinition.prompt`,
which configures a named *subagent* launched through the `task` tool, not the
main agent loop. There is no supported way, via this SDK version's public
API, to override, shrink, or remove Cursor's baked-in system prompt for the
primary agent.

**Live comparison: built-in tool choice barely moves the floor, so the floor
isn't tool-schema cost.** Two non-stream calls, same trivial `say gay`
message, no prior session:

| tools declared | built-ins granted (`sdkToolAllowlist()`) | `prompt_tokens` |
|---|---|---|
| none | `read`, `grep`, `glob`, `ls` (ask-mode default) | 4486 |
| 1 dummy client tool | `mcp` only (passthrough mode) | 5221 |

The passthrough case (fewer, different built-ins, but one client tool schema
plus the `mcp` capability group description) is *higher*, not lower. If the
floor were dominated by which/how-many tool schemas get loaded, restricting
built-ins to a single capability group should have reduced it noticeably. It
didn't — confirming the ~4.5-5k floor is Cursor's own fixed agent-runtime
system prompt, essentially independent of tool selection.

**Practical implication:** this proxy already minimizes what it controls —
`sdkToolAllowlist()` in `src/mapping.ts:64-71` restricts Cursor's built-in
toolset to just `"mcp"` whenever a client declares its own tools (the common
case for `goose`). The remaining gap between this floor (~4.5-5k) and what
`goose` showed in its own UI (~8k on turn 1) is `goose`'s *own* system prompt
plus its declared extension schemas (Slack, `execute_typescript`, etc.) —
controllable only client-side (disabling unused `goose` extensions), not from
this proxy or the Cursor SDK.
