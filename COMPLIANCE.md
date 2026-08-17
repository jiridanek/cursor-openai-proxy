# Terms of Service and Compliance

This project is designed from the ground up to be a **compliant wrapper** around the official `@cursor/sdk`.

When connecting external tools to Cursor, it is important to understand the boundaries of the Acceptable Use Policy (AUP) and the terms of service.
This document outlines my honest understanding of how this proxy adheres to those rules.

## Why this proxy is compliant

1. **Uses the Official SDK:** We do not reverse-engineer undocumented internal APIs, scrape session tokens, or spoof web clients. Everything routes through the officially supported `@cursor/sdk`.
2. **Maintains the Agent Loop:** Cursor's terms require that its models be accessed via its agent runtime. This proxy explicitly honors this by translating HTTP requests into valid local agent runs, acting strictly as a "minimized agent gateway".
3. **Uses Cursor's Inference (No Fee Evasion):** The [Cursor TypeScript SDK docs](https://cursor.com/docs/sdk/typescript) state directly: *"All inference goes through Cursor's hosted models in both modes"* — local vs. cloud only changes where the agent loop and filesystem access run, never where the model runs. This proxy respects that constraint, ensuring that all agent execution is properly billed against the provided Cursor API key.
4. **No Reselling:** This proxy is designed for single-tenant or personal tech stacks. Exposing Cursor as a public multi-tenant `completions` product is explicitly a non-goal (see [Sources](#sources) below).

## What to avoid (ToS Violations)

If you modify this proxy or integrate it into larger systems, be aware of the following activities that violate Cursor's ToS:

> [!NOTE]
> **Custom Models: IDE vs. SDK**
> While the Cursor *IDE* explicitly allows users to configure a custom OpenAI base URL to use external models (like local Ollama), the programmatic **Agent SDK does not**.
The [SDK documentation](https://cursor.com/docs/sdk/typescript) mandates that all inference must go through Cursor's hosted models; it makes no mention of a custom-base-URL or bring-your-own-model option anywhere in the API surface.

* **Intercepting Inference:** Do not attempt to intercept the SDK's network calls to route the underlying LLM prompts to external providers (e.g., local Ollama or OpenRouter). Using Cursor's proprietary agent engine without paying for their hosted inference is a violation.
* **Public Reselling:** You cannot use this proxy to resell Cursor's inference to third parties.
* **Competitive Training:** You cannot use the outputs generated through this proxy to train a competitive machine learning model.

## Sources

* [Cursor TypeScript SDK docs](https://cursor.com/docs/sdk/typescript) — "local vs. cloud" section, source for the hosted-inference-only claim above.
* [Cursor Terms of Service](https://cursor.com/terms-of-service) — Acceptable Use Policy: bars renting, leasing, lending, or selling the Service, and bars using the Service or its outputs to develop or train a competitive model or perform model-extraction attacks.
* [Cursor Pricing page](https://cursor.com/pricing) — "We do not authorize any resellers or third-party sellers. Subscriptions purchased from any other source are unauthorized and may be fraudulent, insecure, or obtained through abuse of our systems."
