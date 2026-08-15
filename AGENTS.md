# Agent notes for `cursor-openai-proxy`

Guidance for coding agents working in this repo, distilled from prior
sessions. See `SPEC.md` for the behavioral contract and `README.md` for a
skimmable overview — this file is about *how to work here*, not *what the
proxy does*.

## What this is

An OpenAI-compatible HTTP proxy (Chat Completions + Responses) in front of
the Cursor Agent SDK — a "minimized agent gateway." Client-declared `tools`
replace Cursor's own built-ins on purpose: the design goal is to minimize
what the underlying agent can do on its own (see README.md's "Is / Is not").

`SPEC.md` is the authoritative, precise behavioral contract (exact
resolution orders, status codes, wire shapes). `README.md` is a terser
companion for skimming. **Any commit that changes session handling,
tool-calling, or a documented HTTP contract must update both docs in the
same commit** — stale SPEC.md wording (e.g. a "→ 400" that no longer
400s) is actively misleading, worse than no doc at all.

## Commit discipline

For a multi-part fix (several independent bugs, or a multi-step design
change): **one commit per logical fix, never bundled.** Each message should
explain, at length, standing alone without needing chat history: the exact
failure mechanism (what breaks and why, with `file:line`), a concrete repro,
the fix, and what the accompanying test asserts.

Run `npm test` and `npm run typecheck` after **every** commit, not just at
the end of a batch.

For every new regression test, verify it actually discriminates old vs. new
behavior: `git stash` just the source change (keep the test), confirm the
test fails on the pre-fix code, then restore and confirm it passes. Do this
before each commit and say so explicitly, rather than asserting a test
"should" catch the regression.

## Design: standards-compliant over proprietary

This proxy serves standards-compliant OpenAI clients. When a proprietary
extension mechanism (a custom header, a bespoke id field) has a
standards-compliant alternative that turns out to be sufficient (e.g.
`tool_call_id`-based correlation vs. `X-Cursor-Session-Id`), **replace, don't
just supplement.** Adding the standard mechanism as a fallback *after* an
existing proprietary lookup can leave a real bug in place — a
present-but-wrong proprietary value can still silently hijack or block the
correct resolution. Once the standard path is proven sufficient, do the
follow-up commit that removes the proprietary path entirely for that use
case. Keep proprietary mechanisms only where the standard alternative
genuinely can't cover a use case, and say so explicitly in the docs.

When a fix could go either way, mirror existing graceful-degradation
patterns in the codebase (e.g. "recreate + replay full history on a
correlation miss") rather than inventing a new failure mode like a hard
error.

## Test-double fidelity gap — read the real SDK, don't trust the fakes

`tests/helpers/fakeBackend.ts`'s `FakeCursorBackend`/`FakeRun` model
*intended* behavior, not the real `@cursor/sdk`'s actual wire quirks or
timing:

- Every client-declared custom tool call is routed through a generic
  `"mcp"` capability-group meta-tool at the real SDK's wire level — the
  `tool_call` stream event reports `name: "mcp"` with a wrapped
  `{providerIdentifier, toolName, args}` envelope, **not** the resolved
  tool. `wrapCustomTools()`'s `execute()` callback is the one place that
  gets the real, unwrapped name/args — never trust the raw stream event.
- Event *timing* between the SDK's stream events and `execute()` callbacks
  has no guaranteed order in the real SDK, even though `FakeRun` is
  synchronous by construction and will happily pass tests that depend on a
  specific order. Prefer designs with zero dependency on such ordering.

When a bug report involves real SDK behavior that seems surprising or
undocumented here, check `node_modules/@cursor/sdk/dist/esm/*.d.ts` — the
type files carry doc-comments that are often the only source of truth for
wire-level semantics. When adding a regression test for an SDK-wire-format
or timing bug, check whether the fakes need a new opt-in flag to reproduce
the real shape (see `FakeToolCall.wireWrap` / `skipStreamEvent` for
precedent) rather than assuming they already model it.

## Verify against the live process before designing a fix

For bugs involving real Cursor SDK runtime behavior (streaming semantics,
event timing, tool-call routing, token usage) that test doubles can't be
trusted to model faithfully: if a live instance is reachable, curl it
directly (or use the `.claude/skills/run-cursor-openai-proxy/` skill) to
confirm or refute a hypothesis **before** committing to a fix design — it's
faster and more authoritative than inferring from minified SDK internals,
and has repeatedly caught bugs the test suite missed entirely.

Only do this for read-only or clearly-authorized checks. Hosted-mode
requests spin up a real Cursor agent (real cost/side effects) — prefer the
user's own suggestion or explicit go-ahead before sending a real
tool-calling or chat-completion request to a live instance; a bare
`/health` GET is always safe.

## Known open issue

`usage.total_tokens` does not equal `prompt_tokens + completion_tokens` in
the live backend — the Cursor SDK's own reported `totalTokens` doesn't
follow that invariant in sticky/resumed sessions, and this proxy currently
forwards it verbatim. See `docs/dev/usage-total-tokens-mismatch.md` for the
repro, raw data, and proposed fix (not yet implemented).

## Running and testing

Use the `.claude/skills/run-cursor-openai-proxy/` skill (`smoke.sh`) to
build/launch/verify the proxy end-to-end — it delegates to
`npm run test:e2e` (no credentials needed) / `npm run test:e2e:live`
(requires a real `CURSOR_API_KEY`; spends real agent-run time). For most
mapping/session changes, `npx vitest run` against the in-process
`FakeCursorBackend` (no server, no credentials) is faster and sufficient —
reach for the live path only to confirm real-SDK behavior.
