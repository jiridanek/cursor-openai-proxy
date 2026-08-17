# Related Projects and Prior Art

The ecosystem of tools attempting to bridge Cursor with standard OpenAI clients has evolved significantly.
Projects generally fall into four categories: compliant SDK wrappers (like this one), compliant IDE-level base-URL tools, non-compliant SDK interceptors, and legacy reverse-engineered proxies.

## 1. Compliant SDK Wrappers (The Current Era)

These projects, like this one, sit cleanly on top of the official `@cursor/sdk` and translate OpenAI-formatted REST requests into official SDK calls.

* [**anyrobert/cursor-api-proxy**](https://github.com/anyrobert/cursor-api-proxy): A highly capable proxy exposing Cursor models to clients like LiteLLM and LangChain.
    * *Notable features:* Support for account rotation/load balancing across multiple Cursor keys, and a "strict isolation" chat-only mode that scrubs environment variables and overrides `cwd` to prevent accidental host mutations.

## 2. Compliant IDE-Level Custom Base URL

The Cursor *IDE* itself explicitly supports pointing its chat feature at a custom OpenAI-compatible base URL to use external models — this is a documented, sanctioned IDE setting, distinct from the programmatic Agent SDK covered by this project and by category 3 below.

* [**punnerud/cursor_ollama_proxy**](https://github.com/punnerud/cursor_ollama_proxy): A standalone Flask proxy that translates OpenAI-shaped API calls into Ollama API calls. It's designed to be pasted directly into Cursor IDE's own "OpenAI API" base-URL setting (Preferences → Cursor Settings → Models) — it never imports or talks to `@cursor/sdk`, and needs no Cursor account, cookie, or API key of any kind.
    * *Compliance Note:* This exercises the IDE's own supported customization path (see the note in `COMPLIANCE.md`), not the SDK's hosted-inference-only constraint — it doesn't touch `@cursor/sdk` at all, so the "SDK Interceptors" concerns in category 3 don't apply to it.

## 3. SDK Interceptors (Non-Compliant)

While the Cursor *IDE* allows users to configure a custom OpenAI base URL (category 2 above), the programmatic **Agent SDK does not** — see [Cursor's SDK docs](https://cursor.com/docs/sdk/typescript).

* [**cursor-sdk-gateway**](https://github.com/divyaran7an/cursor-sdk-gateway): Intercepts `@cursor/sdk`'s own model calls and reroutes them to Vercel AI Gateway or any OpenAI-compatible endpoint (OpenRouter, LiteLLM, vLLM, LocalAI, etc.), while — per its own README — "the local executor still runs all the tools the same way" (Cursor's local file/shell tools, MCP servers, hooks, subagents).
    * *Compliance Note:* Doing this programmatic interception violates Cursor's ToS by circumventing protective measures and using their proprietary execution engine to avoid inference fees.

## 4. Legacy Web Scrapers (Non-Compliant)

Before the release of the official SDK, developers resorted to reverse-engineering Cursor's web APIs.

* [**JiuZX/Cursor-To-OpenAI**](https://github.com/JiuZX/Cursor-To-OpenAI): A legacy approach that requires extracting a `WorkosCursorSessionToken` or JWT from a browser session. It translates OpenAI calls into Cursor's internal web API format. Its own README documents resetting the free premium-request allowance by deleting and re-registering an account.
    * *Compliance Note:* Bypassing the local IDE/SDK context entirely, scraping tokens, and creating burner accounts to farm premium requests are clear violations of the Acceptable Use Policy.

## Sources

Every project listed above was checked directly against its own README at the
time of writing (linked inline); the compliance/non-compliance framing itself
follows from `COMPLIANCE.md`, sourced from:

* [Cursor TypeScript SDK docs](https://cursor.com/docs/sdk/typescript) — hosted-inference-only constraint, no custom-base-URL support in the SDK.
* [Cursor Terms of Service](https://cursor.com/terms-of-service) — Acceptable Use Policy restrictions on reselling, competitive-model training, and circumventing protective measures.
