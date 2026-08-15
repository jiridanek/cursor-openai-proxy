# Which catalog models actually work through the SDK (hosted auth)

**Status:** observed via live probe against the running proxy, then root-caused
with scratch scripts calling `@cursor/sdk` directly. The `composer-*`/`grok-*`
"admin block" turned out to be a blocked `fast=true` param, not the models
themselves — see "Follow-up" below for a concrete, actionable proxy fix. One
unrelated anomaly also found (`gpt-5.4-nano`), not explained by admin policy.

## Symptom

`GET /v1/models` (hosted auth, real Cursor account) returns 56 ids, but a
model appearing there is no guarantee it will actually run — `composer-2` and
`composer-2.5` both 500 with `Model Blocked ... your team admin settings`
despite being listed. The user can use `composer-2.5` successfully in the
Cursor IDE app under the same account, which doesn't match what the SDK/API
key reports. This doc maps out, empirically, what does and doesn't work
through this proxy right now.

## Test

`GET /v1/models` against `http://127.0.0.1:11434` (hosted auth mode) returns
56 ids, most of which are aliases of a smaller set of underlying models (e.g.
`sonnet`, `sonnet-latest`, `sonnet-5`, `claude-sonnet-5` are one model). One
representative id per apparent family was probed with a minimal, non-stream
chat completion:

```bash
curl -m 40 http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer test" -H "Content-Type: application/json" \
  -d '{"model":"<id>","messages":[{"role":"user","content":"hi"}]}' \
  -w '\nHTTP_STATUS:%{http_code}\n'
```

19 of the 56 were probed directly this way, run 6-at-a-time in the
background; `default`, `claude-sonnet-5`/`auto` (already confirmed working
during an earlier investigation) and `composer-2`/`composer-2.5`/`baf`
(the models that originally prompted this whole investigation) round out the
picture. Aliases within an already-tested family (e.g. `composer-latest`,
`composer-2-5`, `composer`) were spot-checked to confirm they share their
family's fate rather than assumed.

## Results

| Family (representative id) | Result | Notes |
|---|---|---|
| `default` | ✅ works | |
| `auto` | ✅ works | |
| `claude-sonnet-5` | ✅ works | |
| `claude-sonnet-4-6` | ✅ works | |
| `claude-sonnet-4-5` | ✅ works | |
| `claude-sonnet-4` | ✅ works | |
| `claude-opus-4-6` | ✅ works | |
| `claude-opus-4-5` | ✅ works | |
| `claude-haiku-4-5` | ✅ works | |
| `gpt-5.4` | ✅ works | |
| `gpt-5.4-mini` | ✅ works | |
| `gpt-5.3-codex` | ✅ works | |
| `gpt-5.2` | ✅ works | |
| `gpt-5.1` | ✅ works | |
| `gpt-5-mini` | ✅ works | |
| `gemini-3.1-pro` | ✅ works | |
| `gemini-3-flash` | ✅ works | |
| `gemini-2.5-flash` | ✅ works | |
| `composer-2` | 🚫 blocked via proxy | `Model Blocked` (500) with the proxy's default params — works fine with `fast=false`, see "Follow-up" below |
| `composer-2.5` / `composer-2-5` | 🚫 blocked via proxy | same as above — confirmed on all 3 aliases (`composer`, `composer-latest`, `composer-2-5`); same `fast=false` fix applies |
| `grok-4.6` | 🚫 blocked via proxy | same shape as composer; `fast=false` fixes it too |
| `grok-4.5` | 🚫 blocked via proxy | same |
| `gpt-5.4-nano` | ❌ broken | `AI Model Not Found — Model name is not valid: "gpt-5.4-nano-medium"` (500) — see below, not an admin block |
| `baf` (not a real id) | ❌ n/a | `Cannot use this model: baf. Available models: ...` (500) — expected, not in the catalog at all |

Untested: the remaining ~35 ids are aliases of the families above (e.g.
`sonnet`, `sonnet-4.6`, `haiku-4.5`, `opus`, `codex`, `gemini-pro`,
`gpt-mini`, `gpt-nano`, `gemini-flash`, `...-latest` variants) and were not
probed individually — no reason to expect they'd behave differently from
their family's representative id, since `composer`/`composer-latest` did
match their family exactly when spot-checked.

## Why this matters

Two distinct, unrelated things are going on, and it's worth keeping them
separate:

1. **`composer-*` and `grok-*` aren't actually blocked models — a specific
   param (`fast=true`) is what the team admin policy blocks**, and this
   proxy's default request happens to resolve to that blocked path. See
   "Follow-up" below for the full story and a concrete fix; this is a proxy
   behavior gap (missing a sane default), not purely an external policy this
   proxy has no control over.
2. **`composer-2.5` works in the Cursor IDE app but not through this
   SDK/API key by default.** Now explained: the IDE most likely defaults to
   (or lets the user toggle to) `fast=false`, while this proxy never sets
   `fast` at all and silently inherits the backend's blocked no-params
   default.
3. **`gpt-5.4-nano` looks like a genuine backend inconsistency**, unrelated
   to admin blocking. The error name is a *different* error family entirely
   (`AI Model Not Found`, not `Model Blocked`), and it references a model id
   (`gpt-5.4-nano-medium`) that was never in the request — this proxy's own
   `effortParams()` (`src/mapping.ts:451-469`) only appends an
   effort/reasoning-effort suffix when the client explicitly requests one,
   and the probe request didn't. So Cursor's backend appears to resolve
   `gpt-5.4-nano` to a default reasoning-effort variant (`-medium`) on its
   own, and that specific variant doesn't exist server-side. Worth a
   standalone bug report to Cursor if `gpt-5.4-nano` is needed; nothing to
   fix on the proxy side since it never sent an effort parameter.

## Follow-up: it's not the model, it's the `fast` parameter

Point 2 above turned out to have a concrete answer. Using a throwaway API
key and small scratch scripts calling `@cursor/sdk` directly (`Agent.create`
+ `agent.send` + `run.wait()`, bypassing this proxy entirely), every
`composer-2` / `composer-2.5` / `grok-4.5` / `grok-4.6` variant was tried
across its full parameter matrix (`Cursor.models.list()` exposes `effort`
and/or `fast` as valid `params` for these models — not visible through this
proxy's `/v1/models`, which strips `parameters`/`variants` down to bare
OpenAI-shaped ids).

Result, 100% reproducible across repeated runs:

| `fast` param | Result |
|---|---|
| omitted entirely (no `params`) | 🚫 blocked — `Model Blocked` |
| `"true"` (explicit) | 🚫 blocked — `Model Blocked` |
| `"false"` (explicit) | ✅ works, every time |

This holds across **all four** models and, for `grok-4.5`/`grok-4.6`, across
every `effort` value (`low`/`medium`/`high`/`xhigh`) — `effort` has no
bearing on the block at all. Critically, **omitting `params` is not the same
as the catalog's stated default**: `composer-2.5`'s catalog entry marks
`fast=false` as `isDefault: true`, yet calling it with no `params` still
gets blocked exactly like explicit `fast=true` does. So the admin policy is
blocking Cursor's own "fast" mode for these models specifically, and the
backend's no-params default silently resolves to the blocked `fast=true`
path rather than the catalog's advertised default.

**This is why the Cursor IDE app works and this proxy doesn't**: the IDE
almost certainly sends `fast=false` (or exposes a toggle the user has left
off), while this proxy never sets `fast` at all — `effortParams()`
(`src/mapping.ts:451-469`) only ever populates an `effort`/`reasoning_effort`
param when a client explicitly asks for one; nothing here ever touches
`fast`, so every composer/grok call falls through to the blocked default.

**Actionable fix, separate from the HTTP-status-mapping plan**: have the
proxy default `fast` to `"false"` for any model whose catalog `parameters`
include a `fast` entry, whenever the client hasn't specified one — mirroring
how `effortParams()` already opts in to a param only when the catalog
supports it. That alone would unblock `composer-2`, `composer-2.5`,
`grok-4.5`, and `grok-4.6` under this account without waiting on any Cursor
SDK change. Not implemented yet — this doc is the research; a follow-up plan
should wire this into `src/mapping.ts` / wherever `params` gets built for
`Agent.create()`, plus a way for a client to still explicitly opt into
`fast=true` if they want it (and accept that it'll be blocked here).

## Open questions

- Is the `fast=true` admin block specific to this account/team, or a
  Cursor-wide policy for these models? Can't tell from here — would need
  comparing against an unrestricted account.
- Do other models besides these four expose a `fast` param with the same
  blocked-by-default behavior? Only `composer-*`/`grok-*` were checked here.
- Is `gpt-5.4-nano`'s default reasoning-effort resolution broken for every
  account, or specific to this one? Not reproducible from this proxy alone —
  would need testing directly against `@cursor/sdk` or Cursor's own tooling.
