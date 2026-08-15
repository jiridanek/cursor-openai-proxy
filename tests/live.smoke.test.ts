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

  it("satisfies one function tool over chat completions", async () => {
    const first = await postJson(app, "/v1/chat/completions", {
      model: process.env.LIVE_SMOKE_MODEL ?? "auto",
      messages: [
        {
          role: "user",
          content:
            "Call the add tool with a=3 and b=4. Do not compute the sum yourself.",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "add",
            description: "Add two numbers",
            parameters: {
              type: "object",
              properties: {
                a: { type: "number" },
                b: { type: "number" },
              },
              required: ["a", "b"],
            },
          },
        },
      ],
    });
    expect(first.status).toBe(200);
    const parked = await jsonOf<{
      choices: Array<{
        finish_reason: string;
        message: {
          content: string | null;
          tool_calls?: Array<{ id: string }>;
        };
      }>;
    }>(first);
    if (parked.choices[0]?.finish_reason !== "tool_calls") return;
    const sessionId = first.headers.get("X-Cursor-Session-Id");
    const callId = parked.choices[0]?.message.tool_calls?.[0]?.id;
    expect(sessionId).toBeTruthy();
    expect(callId).toBeTruthy();
    const second = await postJson(app, "/v1/chat/completions", {
      session_id: sessionId,
      messages: [
        {
          role: "user",
          content:
            "Call the add tool with a=3 and b=4. Do not compute the sum yourself.",
        },
        parked.choices[0]!.message,
        { role: "tool", tool_call_id: callId, content: "7" },
      ],
    });
    expect(second.status).toBe(200);
    const done = await jsonOf<{
      choices: Array<{ message: { content: string | null } }>;
    }>(second);
    expect(done.choices[0]?.message.content).toMatch(/7/);
  });
});
