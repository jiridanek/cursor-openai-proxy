import { describe, expect, it } from "vitest";
import { FakeCursorBackend } from "./helpers/fakeBackend.ts";
import {
  hostedConfig,
  jsonOf,
  makeApp,
  normalizeSse,
  postJson,
} from "./helpers/app.ts";

describe("POST /v1/chat/completions", () => {
  it("maps a non-stream completion", async () => {
    const backend = new FakeCursorBackend({ reply: "7" });
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/chat/completions", {
      model: "composer-2.5",
      messages: [{ role: "user", content: "What is 3+4?" }],
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<{
      object: string;
      model: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    }>(res);
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("composer-2.5");
    expect(body.choices[0]?.message.content).toBe("7");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(backend.creates).toBe(1);
    expect(backend.sends[0]?.prompt).toContain("What is 3+4?");
    expect(res.headers.get("X-Cursor-Session-Id")).toMatch(/^sess_/);
  });

  it("snapshots streaming SSE frames", async () => {
    const backend = new FakeCursorBackend({
      reply: "Hello",
      deltas: ["Hel", "lo"],
    });
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/chat/completions", {
      model: "composer-2.5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(
      normalizeSse(await res.text(), [
        [/chatcmpl_[a-f0-9-]+/g, "chatcmpl_ID"],
        [/"created":\s*\d+/g, '"created": 0'],
      ]),
    ).toMatchSnapshot();
  });

  it("sticky: second request with the same session id send()s only the new user text", async () => {
    const backend = new FakeCursorBackend();
    const { app } = makeApp(backend);
    const first = await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "hello" }],
    });
    const sessionId = first.headers.get("X-Cursor-Session-Id");
    expect(sessionId).toBeTruthy();
    await postJson(
      app,
      "/v1/chat/completions",
      {
        session_id: sessionId,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "echo:user: hello" },
          { role: "user", content: "follow up" },
        ],
      },
      { "X-Cursor-Session-Id": sessionId! },
    );
    expect(backend.creates).toBe(1);
    expect(backend.sends).toHaveLength(2);
    expect(backend.sends[1]?.prompt).toBe("follow up");
  });

  it("creates a new agent when no chat session id is sent", async () => {
    const backend = new FakeCursorBackend();
    const { app } = makeApp(backend);
    await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "one" }],
    });
    await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "two" }],
    });
    expect(backend.creates).toBe(2);
  });

  it("prefix mode reuses an agent on identical history prefix", async () => {
    const backend = new FakeCursorBackend({ reply: "A1" });
    const { app } = makeApp(backend, hostedConfig({ sessionMode: "prefix" }));
    const first = await postJson(app, "/v1/chat/completions", {
      model: "composer-2.5",
      messages: [{ role: "user", content: "hello" }],
    });
    const firstBody = await jsonOf<{
      choices: Array<{ message: { content: string } }>;
    }>(first);
    await postJson(app, "/v1/chat/completions", {
      model: "composer-2.5",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: firstBody.choices[0]?.message.content },
        { role: "user", content: "again" },
      ],
    });
    expect(backend.creates).toBe(1);
    expect(backend.sends[1]?.prompt).toBe("again");
  });

  it("does not fetch the model catalog unless reasoning_effort is set", async () => {
    const backend = new FakeCursorBackend();
    const { app } = makeApp(backend);
    await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(backend.apiKeys).toHaveLength(1);

    await postJson(app, "/v1/chat/completions", {
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(backend.apiKeys).toHaveLength(3);
    expect(backend.createOptions[1]?.params).toEqual([
      { id: "effort", value: "high" },
    ]);
  });

  it("returns 500 when the model catalog fails and reasoning_effort is set", async () => {
    const backend = new FakeCursorBackend();
    backend.listModels = async () => {
      throw new Error("catalog down");
    };
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/chat/completions", {
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(500);
    expect(await jsonOf<{ error: { message: string } }>(res)).toMatchObject({
      error: { message: "catalog down" },
    });
  });

  it("returns 400 for n>1", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/v1/chat/completions", {
      n: 2,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(400);
  });

  it("wraps /v1/completions prompt as a user message", async () => {
    const backend = new FakeCursorBackend({ reply: "ok" });
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/completions", { prompt: "ping" });
    expect(res.status).toBe(200);
    const body = await jsonOf<{
      object: string;
      choices: Array<{ text: string }>;
    }>(res);
    expect(body.object).toBe("text_completion");
    expect(body.choices[0]?.text).toBe("ok");
    expect(backend.sends[0]?.prompt).toBe("ping");
  });
});
