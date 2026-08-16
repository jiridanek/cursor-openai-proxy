# The `PARK_IDLE_MS` heuristic: what it does, and why it's a fixed constant

**Status:** current design, documented as-is. No code change accompanies this
doc — written up so a future request to tune or replace this value has this
reasoning available instead of needing to be re-derived from scratch.

## What it does

`PARK_IDLE_MS = 50` (`src/session/supervisor.ts:16`) is the only signal this
proxy has for deciding "the model is done issuing tool calls for this turn,
send the HTTP response now." There is no authoritative "turn done" event from
the Cursor SDK — `wrapCustomTools().execute()` parks a promise the instant the
model calls a tool (`supervisor.ts:81-124`), and the SDK gives no separate
notification that a batch of such calls is complete.

`waitForParkIdle()` (`supervisor.ts:153-163`) approximates this: every time a
new call parks, it (re)arms a `PARK_IDLE_MS`-timeout. If no further park
arrives before the timeout fires, it resolves `"parked"`. `collectTurn()`
(`supervisor.ts:193-247`) races that against the run's own completion
(`supervisor.waitDone`) and, if `"parked"` wins, snapshots
`record.pendingToolCalls` from whatever is currently in `supervisor.parks` and
returns that as the HTTP response (`finish_reason: "tool_calls"` for Chat,
`status: "requires_action"` for Responses).

## Why 50ms specifically

This is an unverified heuristic, not a value derived from measuring real
Cursor backend or network latency. It was chosen as "clearly longer than one
synchronous JS turn, clearly shorter than a human would notice," not tuned
against production traffic. Treat it as a guess that happens to work for the
cases exercised in `tests/tools.test.ts`, not as a calibrated constant.

## The tradeoff against raising it

Every tool-calling turn pays this delay before the client gets a response —
not just turns with multiple, staggered tool calls. A single, immediately-
resolved tool call still waits out the full `PARK_IDLE_MS` window before
`collectTurn()` decides the turn is done, because the mechanism has no way to
distinguish "no more calls are coming" from "a call is coming any moment now."
Raising the constant to hedge against rare late-arriving parallel tool calls
would add that same latency to the much more common single-call case. There
is no way to have it both ways without an actual "turn done" signal from the
SDK, which does not exist today.

## Does this matter when streaming?

Yes, but its role is narrower than in the non-streaming case, because
streaming already decouples "deliver tool-call content" from "close the
turn":

- `wrapCustomTools().execute()` (`supervisor.ts:90-119`) calls
  `supervisor.listener(...)` **synchronously the instant a call parks** —
  completely independent of the idle timer. In `app.ts`'s stream handlers,
  that listener writes the `chatToolCallChunk` / Responses function-call-
  arguments SSE frame immediately. A streaming client sees each tool call as
  soon as it's parked, with no `PARK_IDLE_MS` delay on that content.
- `PARK_IDLE_MS` only gates when `collectTurn()` resolves, which is what lets
  the handler proceed to write the terminal frame (`chatFinishChunk(...,
  "tool_calls")` — just `delta: {}` plus `finish_reason`, no repeated content,
  `codec/chatSse.ts:70-83`) and `[DONE]`. So the idle window still adds up to
  `PARK_IDLE_MS` of tail latency after the last-seen park before the stream
  is allowed to close — on every tool-calling turn, same as the non-streaming
  case, just applied to when the connection ends rather than to the whole
  response.
- A call parking late enough to miss that window won't get a live delta on
  that connection either — `supervisor.listener` is cleared at the same
  moment `collectTurn()`'s idle branch fires (`supervisor.ts:241`) — but it's
  still tracked via the persistent `onPark` re-sync (`:238-240`) and surfaces
  on the client's next resume request, via the same non-fatal recovery path
  `883f1e6` added (see below). Streaming doesn't change what happens to a
  late park, only whether it happened to get a live delta before the cutoff.

Net effect: streaming makes the heuristic's cost much smaller (a short fixed
tail delay before stream closure, not a delay on all content delivery), not
zero.

## Why a late park is no longer a correctness problem

Before `883f1e6`, a tool call that parked more than `PARK_IDLE_MS` after the
first one — landing in `supervisor.parks` *after* `collectTurn()` had already
snapshotted and sent a response listing only the earlier call(s) — was a hard
failure: `resumeParked()` required every currently-parked `call_id` to be
covered by the client's next request, so a call the client was never told
about would trip `400 Missing tool output for call_id` forever, since the
throw happened before any state changed and every retry reproduced it
identically.

`883f1e6` removed that all-or-nothing requirement. `resumeParked()` now
resolves whatever outputs a client does submit and lets `collectTurn()`'s
existing re-snapshot logic (`supervisor.ts:238-240`, live-updating
`record.pendingToolCalls` for as long as the record sits in
`requires_action`) report anything still outstanding — including a late
park — as a normal follow-up response instead of an error. A late park now
costs one extra round-trip (the client answers what it knows, the server
reports the late call as still pending, the client answers that too) rather
than wedging the session.

This is *why* `PARK_IDLE_MS`'s exact value is now purely a latency/round-trip-
count tuning question, not a correctness one: get it "too low" and a busy
multi-tool turn costs an extra round-trip more often; get it "too high" and
every turn is slower. Neither failure mode is silent or unrecoverable
anymore.

## Why this isn't exposed as a CLI flag

No operator has reported needing to tune this in practice, and the "docs
first" instinct exists precisely to avoid adding a knob nobody asked for —
speculative configurability is its own maintenance cost (more surface to
document, test, and keep consistent) without a demonstrated need. If a real
case for tuning it shows up, threading `parkIdleMs` through `createApp()` →
`executeTurn()` → `runSession()`/`resumeParked()` → `collectTurn()` →
`waitForParkIdle()` is mechanical (each of those already receives or is
called from a scope that has the config in hand); this doc exists so that
work can start from "here's the tradeoff" instead of re-investigating it.

## See also

- `docs/dev/model-availability-map.md`'s "Follow-up" sections — the
  investigation that first surfaced the late-park visibility gap this doc's
  history section describes.
- Commit `883f1e6` — the fix that made a late park non-fatal, which is what
  changed this heuristic from a correctness knob into a pure latency knob.
