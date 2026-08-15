import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { hostedConfig, jsonOf, postJson } from "./helpers/app.ts";
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

  it("answers 3+4 over chat completions", async () => {
    const res = await postJson(app, "/v1/chat/completions", {
      model: process.env.LIVE_SMOKE_MODEL ?? "auto",
      messages: [
        { role: "user", content: "What is 3+4? Reply with just the number." },
      ],
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<{
      choices: Array<{ message: { content: string } }>;
    }>(res);
    expect(body.choices[0]?.message.content).toMatch(/7/);
  });

  it("chains Responses 3+4 then why", async () => {
    const first = await postJson(app, "/v1/responses", {
      model: process.env.LIVE_SMOKE_MODEL ?? "auto",
      input: "What is 3+4? Reply with just the number.",
    });
    expect(first.status).toBe(200);
    const created = await jsonOf<{
      id: string;
      output: Array<{ content: Array<{ text: string }> }>;
    }>(first);
    expect(created.output[0]?.content[0]?.text).toMatch(/7/);

    const second = await postJson(app, "/v1/responses", {
      input: "Why?",
      previous_response_id: created.id,
    });
    expect(second.status).toBe(200);
    const follow = await jsonOf<{
      output: Array<{ content: Array<{ text: string }> }>;
    }>(second);
    expect(follow.output[0]?.content[0]?.text.length).toBeGreaterThan(0);
  });
});
