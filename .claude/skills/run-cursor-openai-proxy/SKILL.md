---
name: run-cursor-openai-proxy
description: Build, launch, and drive tools/cursor-openai-proxy — an OpenAI-compatible Chat Completions + Responses HTTP proxy in front of the Cursor Agent SDK. Use when asked to run, start, smoke-test, or curl this proxy, verify a fix against a live instance, or check whether it's healthy.
---

Paths below are relative to `tools/cursor-openai-proxy/` (this skill's unit root), not to this skill directory.

This is a stateless Node/Hono HTTP server, not a GUI — the driver is `curl`
plus a spawn/wait wrapper (`smoke.sh`), not a browser or REPL. Two ways to
run it, both already verified working in this container:

1. **No Cursor credentials available** (the common case in a fresh
   container): spawn a throwaway instance in `passthrough` auth mode and
   run structural checks only — the server never needs a real Cursor
   account to start or to correctly reject bad requests.
2. **A real, already-running instance exists** (e.g. the one backing a
   user's `goose`/IDE session, typically `http://127.0.0.1:11434` in
   `hosted` mode): attach to it with real requests. This spends real Cursor
   agent-run time/cost — only do this when the user has pointed you at a
   specific running instance or explicitly authorized it.

## Run (agent path) — the driver

```bash
# No credentials needed. Spawns its own instance on an ephemeral port,
# checks health / auth / unsupported-endpoint / SDK-boundary error paths,
# tears the instance down on exit.
.claude/skills/run-cursor-openai-proxy/smoke.sh
```

```bash
# Attach to an already-running instance instead of spawning one. Sends two
# real chat-completion requests (non-stream + streaming) through it.
.claude/skills/run-cursor-openai-proxy/smoke.sh --live
# or against a different address:
BASE_URL=http://127.0.0.1:9000 .claude/skills/run-cursor-openai-proxy/smoke.sh --live
```

Both modes print `OK`/`FAIL` per check and a `N passed, M failed` summary,
exiting non-zero on any failure.

**For comprehensive authenticated coverage** (model listing, Responses-API
chaining, a full tool-call park/resume round trip) **don't reimplement it —
use the project's own live e2e suite**, which spawns its own throwaway
instance with a real key:

```bash
LIVE_SMOKE=1 E2E_SPAWN=1 CURSOR_API_KEY=<real-key> npm test -- tests/e2e.test.ts
```

`smoke.sh --live` is for a different, narrower purpose: a quick poke at a
*specific instance that's already running* (not one the harness spawns
itself) — e.g. confirming a fix landed after the user restarted their live
process.

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

- **Auth mode is inferred from `$CURSOR_API_KEY`, not a flag you set
  explicitly for "passthrough":** omit `--cursor-api-key` and unset
  `$CURSOR_API_KEY` to get `passthrough` mode, where the client's own
  bearer token is forwarded to Cursor as-is. There's no explicit
  `--auth-mode` flag.
- **`passthrough` mode rejects certain "obviously fake" tokens outright**
  (`ollama`, `sk-dummy` — see `isDummyKey()` in `src/http/auth.ts`) with a
  401 *before* ever reaching the SDK. Use a different placeholder (e.g.
  `test-token-123`) if you want to see the request actually reach the
  `@cursor/sdk` boundary and fail there instead (a clean `500 Invalid User
  API Key`, not a proxy crash — this is expected without a real account and
  is itself a useful smoke check).
- **`describe.skipIf(!live)` in `tests/e2e.test.ts` still runs its
  `mkdtempSync`/setup during Vitest's collection phase even when skipped** —
  this is already handled (temp dirs are created in `beforeAll`, not the
  `describe` body) but is a sharp edge if you add more tests to that file.
- **The always-on "e2e spawned CLI" test at the bottom of `tests/e2e.test.ts`**
  (no `LIVE_SMOKE`/`CURSOR_API_KEY` gate) already proves the exact
  spawn-and-wait-for-listen-line pattern `smoke.sh` uses; that test and this
  driver are deliberately the same shape.
- **Streaming `usage` is opt-in per OpenAI's own contract**: a plain
  `stream: true` request never includes a `usage` field on any chunk: add
  `stream_options: {"include_usage": true}` to get a trailing
  `{"choices": [], "usage": {...}}` chunk before `[DONE]`.
- **`usage.total_tokens` is not `prompt_tokens + completion_tokens`** in the
  live backend as of this writing — see
  `docs/dev/usage-total-tokens-mismatch.md`. Don't be surprised if smoke
  output shows this; it's a known, documented, not-yet-fixed discrepancy in
  the underlying Cursor SDK's reported usage, not a smoke-script bug.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `smoke.sh` (no `--live`) hangs then prints "server never logged a listen address" | Check `$WORKDIR/server.log` (path printed on failure) for a stack trace — usually a missing `node_modules` (`npm install`) or a port already in use from a previous unclean run. |
| `--live` mode's `/health` check fails | Nothing is listening at `$BASE_URL` (default `http://127.0.0.1:11434`). Start one first, or pass the right `BASE_URL`. |
| `--live` mode's chat-completion check gets a non-200 with `"Invalid User API Key"` | The instance you pointed at isn't actually `hosted` with a valid Cursor account (check its `/health` response's `auth_mode`). Use the no-`--live` mode instead, which doesn't need real credentials. |
