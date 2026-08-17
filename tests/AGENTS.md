# Tests

Default `npm test` uses a fake Cursor backend. It does not need `CURSOR_API_KEY`.

## Layout

| File | What it covers |
|---|---|
| `auth.test.ts`, `chat.test.ts`, `models.test.ts`, `responses.test.ts`, `tools.test.ts`, `schema.property.test.ts` | In-process `app.request()` against `FakeCursorBackend` |
| `config.test.ts` | CLI parsing, including `--port 0` |
| `e2e.test.ts` | Real HTTP `fetch` against a listening proxy |
| `helpers/` | Shared app factory and fake backend |

## Live e2e (`tests/e2e.test.ts`)

Gated on **both** `LIVE_SMOKE=1` and a non-empty `CURSOR_API_KEY`. Skipped otherwise.

Client auth is still `Bearer ollama` (hosted-key mode). Do not print `CURSOR_API_KEY`.

```bash
LIVE_SMOKE=1 CURSOR_API_KEY=crsr_... npm test -- tests/e2e.test.ts
```

`LIVE_SMOKE_MODEL` overrides the model (default `auto`).

### In-process (default)

`serve({ port: 0 })` inside the Vitest process. Same code path as unit tests (`createApp` + `SdkCursorBackend`) but over TCP.

### Spawn mode (`E2E_SPAWN=1`)

Starts the real CLI as a child:

`tsx src/index.ts --port 0 --host 127.0.0.1`

`--port 0` is an OS-assigned port. The test reads `listening on http://127.0.0.1:<port>` from stdout, then `fetch`es that base URL. The child is SIGTERM'd in `afterAll`.

```bash
LIVE_SMOKE=1 E2E_SPAWN=1 CURSOR_API_KEY=crsr_... npm test -- tests/e2e.test.ts
```

Use spawn when checking CLI startup, listen logging, or process-level behavior. Use in-process for faster iteration on HTTP mapping.

## Always-on spawn smoke

`e2e.test.ts` also has an ungated case: spawn the CLI, `GET /health`, kill the child. No Cursor key. This runs on every `npm test`.
