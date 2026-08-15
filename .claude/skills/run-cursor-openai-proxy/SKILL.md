---
name: run-cursor-openai-proxy
description: Build, launch, and drive tools/cursor-openai-proxy — an OpenAI-compatible Chat Completions + Responses HTTP proxy in front of the Cursor Agent SDK. Use when asked to run, start, smoke-test, or verify this proxy, or check whether it's healthy.
---

Paths below are relative to `tools/cursor-openai-proxy/` (this skill's unit root), not to this skill directory.

This is a stateless Node/Hono HTTP server, not a GUI. The driver
(`smoke.sh`) is deliberately thin: it does not reimplement request/response
checks — it delegates entirely to the project's own `tests/e2e.test.ts`,
which already spawns the real CLI (`node_modules/tsx/dist/cli.mjs
src/index.ts`), waits for its "listening on ..." line, and drives it over
real HTTP.

## Run (agent path) — the driver

```bash
# No Cursor credentials needed. Spawns the real CLI on an ephemeral port
# and checks /health -- this is all tests/e2e.test.ts's spawned-CLI test
# does without CURSOR_API_KEY (its full live suite is skipped).
.claude/skills/run-cursor-openai-proxy/smoke.sh
```

```bash
# Full live suite: model listing, a real chat completion, Responses-API
# chaining, and a full tool-call park/resume round trip -- against a
# freshly spawned instance using a real Cursor account. Spends real
# Cursor agent-run time/cost. Fails fast with a clear message if
# CURSOR_API_KEY isn't set.
CURSOR_API_KEY=<real-key> .claude/skills/run-cursor-openai-proxy/smoke.sh --live
```

Both invocations are just `npm run test:e2e` / `npm run test:e2e:live`
under the hood (see `package.json`) — `smoke.sh` only picks which one to
run and checks `CURSOR_API_KEY` is present before the live path.

**Verified this session:** the no-credentials path (`smoke.sh` with no
args) ran successfully in this container, which has no `CURSOR_API_KEY`.
The `--live` path's fail-fast guard (missing `CURSOR_API_KEY` aborts before
touching the network) was verified; the successful end of that path
(`CURSOR_API_KEY=<real> smoke.sh --live`) was **not** re-verified after this
delegation refactor, since this environment holds no real Cursor
credentials of its own. Earlier in this same working session, real chat
completions (non-stream and streaming, including the
`stream_options.include_usage` usage chunk) were confirmed working against
a separately-running hosted-mode instance via plain `curl` — the proxy's
live behavior is solid; only this exact npm-script wiring is unverified
end-to-end. If you hold the key, run it yourself with `!
CURSOR_API_KEY=... npm run test:e2e:live` to confirm.

## Prerequisites / Build

```bash
npm install     # only needed once; node_modules is already present after this
npm run typecheck
```

Verified on Node v26.7.0. No OS packages, no browser, no display server —
this is a plain Node HTTP server.

## Direct invocation (covers most PRs in this repo)

Most changes here touch request mapping / session orchestration, not the
process lifecycle — `tests/tools.test.ts`, `tests/chat.test.ts`,
`tests/responses.test.ts` etc. drive `createApp()` in-process against a
`FakeCursorBackend` (`tests/helpers/fakeBackend.ts`), with **no server
process and no real Cursor credentials at all**:

```bash
npx vitest run                      # full suite, ~2s, no credentials needed
npx vitest run tests/chat.test.ts   # one file
```

This is the fastest way to verify a mapping/session change — reach for
`smoke.sh` only when the change is about process startup, real transport,
or you need to confirm behavior against the real `@cursor/sdk`.

## Run (human path)

```bash
npm start -- --port 11434                       # passthrough auth (any bearer token)
CURSOR_API_KEY=<key> npm start -- --port 11434   # hosted auth (real Cursor account)
```

Blocks in the foreground; `Ctrl-C` to stop. `--help` lists all flags
(`--session-mode sticky|prefix`, `--agent-mode ask|plan|agent`, `--workspace`).

## Gotchas

- **Auth mode is inferred from `$CURSOR_API_KEY`, not an explicit flag:**
  omit `--cursor-api-key` and unset `$CURSOR_API_KEY` to get `passthrough`
  mode, where the client's own bearer token is forwarded to Cursor as-is.
  There's no `--auth-mode` flag.
- **`passthrough` mode rejects certain "obviously fake" tokens outright**
  (`ollama`, `sk-dummy` — see `isDummyKey()` in `src/http/auth.ts`) with a
  401 before ever reaching the SDK. Use a different placeholder (e.g.
  `test-token-123`) to see a request actually reach the `@cursor/sdk`
  boundary and fail there instead — a clean `500 Invalid User API Key`, not
  a proxy crash, which is itself a useful manual check without real
  credentials.
- **`tests/e2e.test.ts`'s live suite needs both `CURSOR_API_KEY` *and*
  `LIVE_SMOKE=1`** — `describe.skipIf(!live)` checks both. Setting only
  `CURSOR_API_KEY` silently skips the whole suite; `npm run test:e2e:live`
  already sets `LIVE_SMOKE=1` (and `E2E_SPAWN=1`) for you.
- **The always-on "e2e spawned CLI" test at the bottom of `tests/e2e.test.ts`**
  (no env-var gate) is what makes `smoke.sh`'s no-credentials mode
  meaningful at all — without it, running `tests/e2e.test.ts` with no
  `CURSOR_API_KEY` would skip every test and prove nothing actually
  spawned.
- **Streaming `usage` is opt-in per OpenAI's own contract**: a plain
  `stream: true` request never includes a `usage` field on any chunk; add
  `stream_options: {"include_usage": true}` to get a trailing
  `{"choices": [], "usage": {...}}` chunk before `[DONE]`. Confirmed live
  against a real hosted instance in this session.
- **`usage.total_tokens` is not `prompt_tokens + completion_tokens`** in
  the live backend as of this writing — see
  `docs/dev/usage-total-tokens-mismatch.md`. Not a smoke-script bug.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `smoke.sh` hangs or fails during collection | Check for a leftover process bound to a port from a previous unclean run, or run `npm install` if `node_modules` is missing/stale. |
| `smoke.sh --live` exits immediately with `CURSOR_API_KEY: --live requires CURSOR_API_KEY...` | Expected — pass a real key: `CURSOR_API_KEY=<key> smoke.sh --live`. |
| `test:e2e:live` reports `"Invalid User API Key"` | The key isn't a valid, active Cursor account key. Use the no-`--live` path instead, which needs no real credentials. |
