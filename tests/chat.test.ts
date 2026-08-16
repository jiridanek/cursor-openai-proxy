import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http/errors.ts";
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
    expect(backend.createOptions[0]?.tools).toEqual([
      "read",
      "grep",
      "glob",
      "ls",
    ]);
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

  it("omits usage from streaming chunks by default, but emits a final usage chunk when stream_options.include_usage is set", async () => {
    const backend = new FakeCursorBackend({ reply: "Hello", deltas: ["Hel", "lo"] });
    const { app } = makeApp(backend);

    const withoutUsage = await postJson(app, "/v1/chat/completions", {
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const framesWithoutUsage = (await withoutUsage.text())
      .split("\n\n")
      .map((line) => line.replace(/^data: /, "").trim())
      .filter((line) => line && line !== "[DONE]")
      .map((line) => JSON.parse(line));
    expect(framesWithoutUsage.every((frame) => frame.usage === undefined)).toBe(true);

    const withUsage = await postJson(app, "/v1/chat/completions", {
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hi" }],
    });
    const framesWithUsage = (await withUsage.text())
      .split("\n\n")
      .map((line) => line.replace(/^data: /, "").trim())
      .filter((line) => line && line !== "[DONE]")
      .map((line) => JSON.parse(line));

    const last = framesWithUsage[framesWithUsage.length - 1];
    expect(last.choices).toEqual([]);
    expect(last.usage).toEqual({
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    });
    // the finish chunk (finish_reason: "stop") must still precede the usage
    // chunk, matching OpenAI's own ordering
    const finishIndex = framesWithUsage.findIndex(
      (frame) => frame.choices?.[0]?.finish_reason === "stop",
    );
    expect(finishIndex).toBe(framesWithUsage.length - 2);
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

  it("always fetches the model catalog, so the fast-param default can be evaluated regardless of reasoning_effort", async () => {
    const backend = new FakeCursorBackend();
    const { app } = makeApp(backend);
    await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(backend.apiKeys).toHaveLength(2); // listModels + createAgent

    await postJson(app, "/v1/chat/completions", {
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(backend.apiKeys).toHaveLength(4);
    expect(backend.createOptions[1]?.params).toEqual([
      { id: "effort", value: "high" },
    ]);
  });

  it("defaults fast to false for a model whose catalog exposes it, unless the client asks for fast=true", async () => {
    const backend = new FakeCursorBackend();
    backend.models = [
      {
        id: "composer-2",
        parameters: [
          { id: "fast", values: [{ value: "false" }, { value: "true" }] },
        ],
      },
    ];
    const { app } = makeApp(backend);

    await postJson(app, "/v1/chat/completions", {
      model: "composer-2",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(backend.createOptions[0]?.params).toEqual([
      { id: "fast", value: "false" },
    ]);

    await postJson(app, "/v1/chat/completions", {
      model: "composer-2",
      fast: "true",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(backend.createOptions[1]?.params).toEqual([
      { id: "fast", value: "true" },
    ]);
  });

  it("maps context/thinking onto model.params when the catalog declares them", async () => {
    const backend = new FakeCursorBackend();
    backend.models = [
      {
        id: "claude-sonnet-5",
        parameters: [
          { id: "context", values: [{ value: "300k" }, { value: "1m" }] },
          { id: "thinking", values: [{ value: "false" }, { value: "true" }] },
        ],
      },
    ];
    const { app } = makeApp(backend);

    await postJson(app, "/v1/chat/completions", {
      model: "claude-sonnet-5",
      context: "1m",
      thinking: "true",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(backend.createOptions[0]?.params).toEqual([
      { id: "context", value: "1m" },
      { id: "thinking", value: "true" },
    ]);
  });

  it("ignores context/thinking values or params the catalog doesn't declare", async () => {
    const backend = new FakeCursorBackend();
    backend.models = [
      {
        id: "claude-sonnet-5",
        parameters: [
          { id: "context", values: [{ value: "300k" }, { value: "1m" }] },
        ],
      },
    ];
    const { app } = makeApp(backend);

    // "512k" isn't a value the catalog declares for context, and the
    // catalog has no "thinking" parameter at all -- both should be
    // silently dropped rather than forwarded or erroring.
    await postJson(app, "/v1/chat/completions", {
      model: "claude-sonnet-5",
      context: "512k",
      thinking: "true",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(backend.createOptions[0]?.params).toBeUndefined();
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

  it("returns 500 when the Cursor run fails", async () => {
    const backend = new FakeCursorBackend({
      runError: {
        message:
          "Model Blocked This model has been blocked by your team admin settings.",
      },
    });
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "What is 3+4?" }],
    });
    expect(res.status).toBe(500);
    expect(await jsonOf<{ error: { message: string; code: string } }>(res)).toMatchObject({
      error: {
        code: "run_failed",
        message:
          "Model Blocked This model has been blocked by your team admin settings.",
      },
    });
  });

  it("forwards the SDK's own error code instead of the generic run_failed fallback", async () => {
    const backend = new FakeCursorBackend({
      runError: { message: "Model Blocked", code: "model_blocked" },
    });
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "What is 3+4?" }],
    });
    expect(res.status).toBe(500);
    expect(await jsonOf<{ error: { message: string; code: string } }>(res)).toMatchObject({
      error: { code: "model_blocked", message: "Model Blocked" },
    });
  });

  it("returns the SDK-class-implied status for a rejected model instead of blanket 500", async () => {
    const backend = new FakeCursorBackend();
    backend.createAgent = async () => {
      throw new HttpError(400, "Cannot use this model: baf.", {
        type: "invalid_request_error",
        code: null,
      });
    };
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/chat/completions", {
      model: "baf",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(400);
    expect(await jsonOf<{ error: { message: string; type: string } }>(res)).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Cannot use this model: baf.",
      },
    });
  });

  it("includes the run error in streaming chat instead of an empty stop", async () => {
    const backend = new FakeCursorBackend({
      runError: { message: "Model Blocked" },
    });
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/chat/completions", {
      stream: true,
      messages: [{ role: "user", content: "What is 3+4?" }],
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Model Blocked");
    expect(body).toContain("run_failed");
    expect(body).not.toContain('"finish_reason":"stop"');
  });

  it("defaults model to auto when omitted", async () => {
    const { app } = makeApp(new FakeCursorBackend({ reply: "7" }));
    const res = await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "What is 3+4?" }],
    });
    expect(res.status).toBe(200);
    expect(await jsonOf<{ model: string }>(res)).toMatchObject({ model: "auto" });
  });

  it("returns 400 for n>1", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/v1/chat/completions", {
      n: 2,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 501 for /v1/completions", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/v1/completions", { prompt: "ping" });
    expect(res.status).toBe(501);
    expect(await jsonOf<{ error: { code: string } }>(res)).toMatchObject({
      error: { code: "unsupported" },
    });
  });
});
