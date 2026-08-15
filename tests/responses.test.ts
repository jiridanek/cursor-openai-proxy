import { describe, expect, it } from "vitest";
import { FakeCursorBackend } from "./helpers/fakeBackend.ts";
import {
  authHeaders,
  jsonOf,
  makeApp,
  normalizeSse,
  postJson,
} from "./helpers/app.ts";

describe("POST /v1/responses", () => {
  it("creates an agent on first call and send()s only new input on follow-up", async () => {
    const backend = new FakeCursorBackend({ reply: "7" });
    const { app } = makeApp(backend);
    const first = await postJson(app, "/v1/responses", {
      input: "What is 3+4?",
    });
    expect(first.status).toBe(200);
    const created = await jsonOf<{
      id: string;
      object: string;
      status: string;
      output: Array<{ content: Array<{ text: string }> }>;
    }>(first);
    expect(created.object).toBe("response");
    expect(created.status).toBe("completed");
    expect(created.output[0]?.content[0]?.text).toBe("7");
    expect(backend.creates).toBe(1);

    const second = await postJson(app, "/v1/responses", {
      input: "Why?",
      previous_response_id: created.id,
    });
    expect(second.status).toBe(200);
    expect(backend.creates).toBe(1);
    expect(backend.sends).toHaveLength(2);
    expect(backend.sends[1]?.prompt).toBe("Why?");
    expect(backend.sends[1]?.agentId).toBe(backend.sends[0]?.agentId);
  });

  it("returns 400 for an unknown previous_response_id", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/v1/responses", {
      input: "hi",
      previous_response_id: "resp_missing",
    });
    expect(res.status).toBe(400);
  });

  it("store:false does not chain", async () => {
    const backend = new FakeCursorBackend();
    const { app } = makeApp(backend);
    const first = await postJson(app, "/v1/responses", {
      input: "ephemeral",
      store: false,
    });
    const created = await jsonOf<{ id: string }>(first);
    const follow = await postJson(app, "/v1/responses", {
      input: "again",
      previous_response_id: created.id,
    });
    expect(follow.status).toBe(400);
    expect(backend.closed).toHaveLength(1);
    const get = await app.request(`/v1/responses/${created.id}`, {
      headers: authHeaders(),
    });
    expect(get.status).toBe(404);
  });

  it("returns failed Responses with the Cursor error message", async () => {
    const backend = new FakeCursorBackend({
      runError: {
        message:
          "Model Blocked This model has been blocked by your team admin settings.",
      },
    });
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/responses", {
      input: "What is 3+4?",
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<{
      id: string;
      status: string;
      error: { message: string };
      output: Array<{ content: Array<{ text: string }> }>;
    }>(res);
    expect(body.status).toBe("failed");
    expect(body.error.message).toBe(
      "Model Blocked This model has been blocked by your team admin settings.",
    );
    expect(body.output[0]?.content[0]?.text).toBe("");

    const stored = await app.request(`/v1/responses/${body.id}`, {
      headers: authHeaders(),
    });
    expect(stored.status).toBe(200);
    expect(await jsonOf<{ status: string; error: { message: string } }>(stored)).toMatchObject({
      status: "failed",
      error: {
        message:
          "Model Blocked This model has been blocked by your team admin settings.",
      },
    });
  });

  it("forwards the SDK's own error code on a failed Response", async () => {
    const backend = new FakeCursorBackend({
      runError: { message: "Model Blocked", code: "model_blocked" },
    });
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/responses", {
      input: "What is 3+4?",
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<{
      status: string;
      error: { message: string; code?: string };
    }>(res);
    expect(body.status).toBe("failed");
    expect(body.error).toMatchObject({
      message: "Model Blocked",
      code: "model_blocked",
    });
  });

  it("GET /v1/responses/{id} returns stored output", async () => {
    const { app } = makeApp(new FakeCursorBackend({ reply: "stored" }));
    const createdRes = await postJson(app, "/v1/responses", {
      input: "remember",
    });
    const created = await jsonOf<{ id: string }>(createdRes);
    const get = await app.request(`/v1/responses/${created.id}`, {
      headers: authHeaders(),
    });
    expect(get.status).toBe(200);
    const body = await jsonOf<{
      output: Array<{ content: Array<{ text: string }> }>;
    }>(get);
    expect(body.output[0]?.content[0]?.text).toBe("stored");
  });

  it("snapshots Responses SSE frames", async () => {
    const backend = new FakeCursorBackend({
      reply: "Hello",
      deltas: ["Hel", "lo"],
    });
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/responses", {
      input: "hi",
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(
      normalizeSse(await res.text(), [
        [/resp_[a-f0-9-]+/g, "resp_ID"],
        [/msg_[a-f0-9-]+/g, "msg_ID"],
        [/"created_at":\s*\d+/g, '"created_at": 0'],
      ]),
    ).toMatchSnapshot();
  });

  it("cancels an in-flight run", async () => {
    const backend = new FakeCursorBackend({ hangUntilCancel: true });
    const { app, registry } = makeApp(backend);
    const pending = postJson(app, "/v1/responses", {
      input: "slow",
      stream: true,
    });

    let id: string | undefined;
    for (let i = 0; i < 50; i += 1) {
      id = registry.all().find((record) => record.activeRun)?.id;
      if (id) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(id).toBeTruthy();

    const cancel = await app.request(`/v1/responses/${id}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(cancel.status).toBe(200);
    expect(await jsonOf<{ status: string }>(cancel)).toMatchObject({
      status: "cancelled",
    });
    const streamed = await pending;
    expect(streamed.status).toBe(200);
    await streamed.text();

    const already = await app.request(`/v1/responses/${id}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(already.status).toBe(409);
  });
});
