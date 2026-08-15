import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { hostedConfig } from "./helpers/app.ts";
import { SdkCursorBackend } from "../src/cursor/sdkBackend.ts";

const live =
  Boolean(process.env.CURSOR_API_KEY) && process.env.LIVE_SMOKE === "1";

describe.skipIf(!live)("live smoke", () => {
  const apiKey = process.env.CURSOR_API_KEY!;
  const { app } = createApp(
    hostedConfig({
      workspace: process.cwd(),
      auth: { mode: "hosted", cursorApiKey: apiKey },
    }),
    new SdkCursorBackend(),
  );

  const headers = {
    Authorization: "Bearer ollama",
    "Content-Type": "application/json",
  };

  it("answers 3+4 over chat completions", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "composer-2.5",
        messages: [{ role: "user", content: "What is 3+4? Reply with just the number." }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0]?.message.content).toMatch(/7/);
  });

  it("chains Responses 3+4 then why", async () => {
    const first = await app.request("/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "composer-2.5",
        input: "What is 3+4? Reply with just the number.",
      }),
    });
    expect(first.status).toBe(200);
    const created = (await first.json()) as {
      id: string;
      output: Array<{ content: Array<{ text: string }> }>;
    };
    expect(created.output[0]?.content[0]?.text).toMatch(/7/);

    const second = await app.request("/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: "Why?",
        previous_response_id: created.id,
      }),
    });
    expect(second.status).toBe(200);
    const follow = (await second.json()) as {
      output: Array<{ content: Array<{ text: string }> }>;
    };
    expect(follow.output[0]?.content[0]?.text.length).toBeGreaterThan(0);
  });
});
