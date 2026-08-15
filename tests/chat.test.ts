import { describe, expect, it } from "vitest";
import { FakeCursorBackend } from "./helpers/fakeBackend.ts";
import { authHeaders, hostedConfig, jsonOf, makeApp } from "./helpers/app.ts";

describe("POST /v1/chat/completions", () => {
  it("maps a non-stream completion", async () => {
    const backend = new FakeCursorBackend({ reply: "7" });
    const { app } = makeApp(backend);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "composer-2.5",
        messages: [{ role: "user", content: "What is 3+4?" }],
      }),
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
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "composer-2.5",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const normalized = raw
      .replaceAll(/chatcmpl_[a-f0-9-]+/g, "chatcmpl_ID")
      .replaceAll(/"created":\s*\d+/g, '"created": 0');
    expect(normalized).toMatchSnapshot();
  });

  it("sticky: second request with the same session id send()s only the new user text", async () => {
    const backend = new FakeCursorBackend();
    const { app } = makeApp(backend);
    const first = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const sessionId = first.headers.get("X-Cursor-Session-Id");
    expect(sessionId).toBeTruthy();
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders("ollama", { "X-Cursor-Session-Id": sessionId! }),
      body: JSON.stringify({
        session_id: sessionId,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "echo:user: hello" },
          { role: "user", content: "follow up" },
        ],
      }),
    });
    expect(backend.creates).toBe(1);
    expect(backend.sends).toHaveLength(2);
    expect(backend.sends[1]?.prompt).toBe("follow up");
  });

  it("creates a new agent when no chat session id is sent", async () => {
    const backend = new FakeCursorBackend();
    const { app } = makeApp(backend);
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        messages: [{ role: "user", content: "one" }],
      }),
    });
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        messages: [{ role: "user", content: "two" }],
      }),
    });
    expect(backend.creates).toBe(2);
  });

  it("prefix mode reuses an agent on identical history prefix", async () => {
    const backend = new FakeCursorBackend({ reply: "A1" });
    const { app } = makeApp(backend, hostedConfig({ sessionMode: "prefix" }));
    const first = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "composer-2.5",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const firstBody = await jsonOf<{
      choices: Array<{ message: { content: string } }>;
    }>(first);
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "composer-2.5",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: firstBody.choices[0]?.message.content },
          { role: "user", content: "again" },
        ],
      }),
    });
    expect(backend.creates).toBe(1);
    expect(backend.sends[1]?.prompt).toBe("again");
  });

  it("returns 400 for n>1", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        n: 2,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("wraps /v1/completions prompt as a user message", async () => {
    const backend = new FakeCursorBackend({ reply: "ok" });
    const { app } = makeApp(backend);
    const res = await app.request("/v1/completions", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "ping" }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<{ object: string; choices: Array<{ text: string }> }>(
      res,
    );
    expect(body.object).toBe("text_completion");
    expect(body.choices[0]?.text).toBe("ok");
    expect(backend.sends[0]?.prompt).toBe("ping");
  });
});
