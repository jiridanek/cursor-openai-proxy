# Which catalog models actually work through the SDK (hosted auth)

**Status:** resolved and implemented. Observed via live probe against the
running proxy, then root-caused with scratch scripts calling `@cursor/sdk`
directly. The `composer-*`/`grok-*` "admin block" turned out to be a blocked
`fast=true` param, not the models themselves — fixed in `7391f45` (default
`fast` to `"false"` for any model whose catalog exposes it, per "Follow-up"
below). `claude-sonnet-5` turned out to expose `context`/`thinking` params
this proxy never plumbed through at all — researched how OpenAI and Anthropic
expose the same concepts natively, and how `goose` could actually send them,
to arrive at a generalized fix, implemented in `129d951` (plain top-level
`context`/`thinking` request fields, validated against the live catalog the
same way `effort`/`fast` already are). One unrelated anomaly also found
(`gpt-5.4-nano`), not explained by admin policy and not fixed here — see
"Why this matters" below; it needs a report to Cursor, not a proxy change.

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

**Implemented in `7391f45`**: the proxy defaults `fast` to `"false"` for any
model whose catalog `parameters` include a `fast` entry, whenever the client
hasn't specified one (`fastParam()`, `src/mapping.ts`) — mirroring how
`effortParams()` already opts in to a param only when the catalog supports
it. This unblocks `composer-2`, `composer-2.5`, `grok-4.5`, and `grok-4.6`
under this account without waiting on any Cursor SDK change, and — since the
conditional is generic (any catalog entry exposing `fast`, not a hardcoded
model list) — the same fix covers any other model with the same
blocked-by-default `fast` behavior without needing to survey them first (see
"Open questions" below). A client can still explicitly opt into `fast=true`
if it wants to (and accept that it'll be blocked here).

## Follow-up: `claude-sonnet-5` exposes `context` (300k/1m) and `thinking`, and this proxy can't set either

Prompted by a report that the Cursor IDE UI offers a 300k/1m context-size
choice for Sonnet 5 — which seemed to contradict this doc's original "no
model exposes context window as a param" read. It didn't: that read was
based only on inspecting `composer-*`/`grok-*`'s catalog parameters (`fast`,
`effort`); `claude-sonnet-5` itself was never checked. Correcting it here.

Querying `Cursor.models.list()` directly (same throwaway-key technique as
above) for `claude-sonnet-5` shows **three** independent params, not one:

```
thinking: false | true
context:  300k  | 1m
effort:   low | medium | high | xhigh
```

The catalog's default variant (`isDefault: true`) is
`thinking=true, context=1m, effort=high`. Unlike the `fast` case above, this
one isn't blocked: probing all of `no-params`, `context=300k` (+
`thinking=false`, `effort=medium`), the catalog-declared default explicitly,
and `context=1m` alone — every combination returned `status=finished` with
no error. So `context`/`thinking` are freely selectable on Cursor's side;
this isn't an admin-policy question at all.

**The actual gap is entirely on this proxy's side.** `effortParams()`
(`src/mapping.ts:451-470`) only ever recognizes a catalog parameter literally
named `effort` or `reasoning_effort`, and only ever reads it from the single
OpenAI-standard `reasoning_effort` request field (`src/http/schemas.ts:37`,
`:61-62`). It has no concept of `context` or `thinking` — nothing in this
proxy reads, validates, or forwards them to `Agent.create()`, regardless of
what a given model's catalog entry supports. A client (e.g. `goose`, or any
other OpenAI-compatible chat client sitting in front of this proxy) has no
way to pick 300k vs 1m context, or toggle extended thinking, for
`claude-sonnet-5` today. Every call silently gets whatever Cursor's backend
resolves as the no-params default — believed to be the catalog's `isDefault`
variant here (unlike the `composer`/`grok` `fast` case, where no-params
demonstrably did *not* match the catalog's stated default), but that belief
isn't independently confirmed — there's no response field that reports back
which variant actually served the request.

**Two separate problems, since they needed different fixes:**
1. Known-blocked param defaulted wrong (`fast` on `composer-*`/`grok-*`) —
   fix was a smarter *default*, per the earlier section. Implemented in
   `7391f45`.
2. Missing plumbing entirely (`context`/`thinking` on `claude-sonnet-5`, and
   possibly other params on other models not yet surveyed) — fix was a
   *generalized* param-passthrough mechanism, since `effortParams()` was
   hardcoded to one param name and one request field. Implemented in
   `129d951` (`contextParam()`/`thinkingParam()`, same shape as
   `effortParams()`/`fastParam()`).

**Design question for a generalized fix — resolved below** by researching
how the underlying model providers themselves expose these same knobs, and
how `goose` (the target OpenAI-compatible client) can be made to send them.

## Follow-up: how OpenAI and Anthropic expose the same knobs, and what that means for a fix

Cursor's `model.params` bundles `effort`/`fast`/`thinking`/`context` into one
array. The two underlying frontier-model APIs don't do it that way — useful
context for designing a generalized version of `effortParams()`.

**OpenAI (GPT-5 family, incl. the newest "Luna"/Sol/Terra tier split)**
splits these into three independent, orthogonal request fields rather than
one bundle:
- `reasoning_effort` (Chat Completions, top-level string) / `reasoning.effort`
  (Responses API, nested) — values from `none`/`minimal`/`low`/`medium`/`high`
  up to `xhigh`/`max` depending on model, same shape as the OpenAI-standard
  field this proxy already reads.
- `verbosity` (Chat Completions, top-level) / `text.verbosity` (Responses,
  nested) — `low`/`medium`/`high`, controls response length/detail, no Cursor
  analogue seen so far.
- `service_tier: "fast"` (both APIs) — a latency/priority knob, separate from
  reasoning depth entirely. Notably **not** the same concept as Cursor's
  `fast` param (which affects quality/model routing, not queue priority).
- Context window: fixed per model id, no runtime toggle at all — OpenAI has
  nothing resembling Cursor's `context: 300k/1m` choice.

**Anthropic (Claude Sonnet 5 / Opus 5)** maps onto Cursor's shape almost
exactly, closer than OpenAI does:
- `output_config: {"effort": "low"|"medium"|"high"|"xhigh"|"max"}` — the
  same 5-level scale as Cursor's `effort` param, verbatim.
- `thinking: {"type": "adaptive"}` (or omitted) — boolean-ish on/off, matching
  Cursor's `thinking` param. (The older raw `budget_tokens` mechanism is
  fully removed / 400s on Opus 5 and Sonnet 5 — adaptive + `effort` replaced
  it.)
- 1M context is now just the **default** window on Sonnet 5/Opus 5 — no beta
  header or param needed, no opt-in. This suggests Cursor's `context:
  300k/1m` choice on `claude-sonnet-5` is Cursor's own product decision
  (probably a cost/speed trade-off they expose), not a pass-through of an
  Anthropic-side flag — Anthropic itself doesn't gate 1M behind a param here
  anymore.
- `speed: "fast"` exists as a distinct knob too, but is restricted to the
  direct Claude API only (not Vertex/Bedrock) — an access-tier restriction
  that structurally resembles Cursor's own blocked `fast=true` on
  composer/grok (see above): a "fast" knob that exists in the API surface but
  is gated off for some accounts/routes.
- Vertex AI: same Messages API semantics for all of the above, just
  different transport (`model` in the URL, `anthropic_version` in the body
  instead of a header) — no functional difference for this comparison.

**Net read:** Cursor's `effort`/`thinking` are basically Anthropic's own
`output_config.effort`/`thinking` params relayed through, largely unmodified
in shape. `fast` and `context` look more like Cursor-specific product
decisions layered on top (matching neither provider's API 1:1), which is
also consistent with `fast` being something Cursor's own admin policy
chooses to block — it's not a provider-level restriction being relayed.

## Follow-up: goose *can* send these — via config file, not the UI

Researched goose's (`block/goose`) source and docs directly. The crux
question — can a goose user get non-standard fields into the outgoing
request body at all — is a **partial yes**:

- Every model entry in a goose custom-provider config has a real
  `request_params: Option<HashMap<String, serde_json::Value>>` field
  (`crates/goose-provider-types/src/base.rs:267-291`) that gets merged
  verbatim into the outgoing JSON body (`formats/openai.rs`, `create_request`)
  — a genuine `extra_body` equivalent. Shipped proof it works: goose's
  bundled Cerebras provider definition sets
  `"request_params": {"reasoning_format": "parsed"}` per model
  ([cerebras.json](https://github.com/block/goose/blob/main/crates/goose-providers/src/declarative/definitions/cerebras.json)).
- **Not exposed in the CLI wizard or Desktop UI** — a goose user has to
  hand-edit the custom provider's JSON config
  (`~/.config/goose/custom_providers/*.json`) to set it. `goose configure`
  only prompts for base URL / API key / model list / headers.
- Goose's own model-name-suffix parsing (`gpt-5.4-high` → strips suffix, sets
  `reasoning_effort`) is regex-gated to names matching `o\d+` or `gpt-5` —
  it will **not** fire for a custom model id like `claude-sonnet-5` or
  `composer-2`, so this proxy is free to invent its own model-id-suffix
  convention (option (b) from the original design question) without
  colliding with goose's built-in behavior, if that ends up being preferred
  over `request_params`.

**Recommendation for this proxy's design, given all three findings:** don't
invent a model-id-suffix scheme — add plain top-level request fields
(`fast`, `context`, `thinking`, mirroring the existing top-level
`reasoning_effort` convention rather than nesting them), validated against
each model's live catalog the same way `effortParams()` already validates
`effort` (only apply a param the target model's catalog actually declares,
silently ignore otherwise). **Followed as-is in `129d951`.** A goose user
reaches these today by adding a `request_params` block to their custom
provider's JSON config file — no goose code change needed, just
documentation on this proxy's side (`SPEC.md`) of what fields it accepts.
The UI gap is goose's, not something this proxy can paper over.

## Open questions

- (Resolved) Is the `fast=true` admin block specific to this account/team,
  or a Cursor-wide policy for these models? Confirmed: it's team policy.
- (Resolved — doesn't matter) Do other models besides these four expose a
  `fast` param with the same blocked-by-default behavior? Not worth
  surveying: `fastParam()`'s conditional (`src/mapping.ts`) already applies
  the `fast=false` default to *any* catalog entry that declares a `fast`
  parameter, not a hardcoded model list, so any other model with the same
  behavior is already covered by the implemented fix without needing to be
  identified first.
- Is `gpt-5.4-nano`'s default reasoning-effort resolution broken for every
  account, or specific to this one? Not reproducible from this proxy alone —
  would need testing directly against `@cursor/sdk` or Cursor's own tooling.
- What does the no-params default actually resolve to for `claude-sonnet-5`
  — the catalog's stated `isDefault` variant, or something else (as was the
  case for `composer`/`grok`'s `fast`)? No response field surfaces this;
  would need Cursor's own tooling/support to confirm.
- Which other models expose `context`, `thinking`, or params not yet seen in
  this survey (only `composer-*`/`grok-*`/`claude-sonnet-5` have been
  inspected in detail)? A full sweep of `Cursor.models.list()`'s
  `parameters` across all 56 catalog ids hasn't been done.
- (Resolved — see "goose *can* send these" above) whether goose can send
  arbitrary custom fields: yes, via a custom provider's `request_params`
  config, not via any UI.
