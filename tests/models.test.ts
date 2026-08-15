import { describe, expect, it } from "vitest";
import { FakeCursorBackend } from "./helpers/fakeBackend.ts";
import { authHeaders, jsonOf, makeApp, postJson } from "./helpers/app.ts";

describe("GET /v1/models", () => {
  it("lists catalog ids and aliases", async () => {
    const { app } = makeApp(new FakeCursorBackend());
    const res = await app.request("/v1/models", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await jsonOf<{
      object: string;
      data: Array<{ id: string; object: string; owned_by: string }>;
    }>(res);
    expect(body.object).toBe("list");
    expect(body.data.map((row) => row.id)).toEqual([
      "composer-2.5",
      "composer",
      "auto",
    ]);
    expect(body.data.every((row) => row.object === "model")).toBe(true);
    expect(body.data.every((row) => row.owned_by === "cursor")).toBe(true);
  });

  it("returns a single model by id or alias", async () => {
    const { app } = makeApp();
    const byAlias = await app.request("/v1/models/auto", {
      headers: authHeaders(),
    });
    expect(byAlias.status).toBe(200);
    expect(await jsonOf<{ id: string }>(byAlias)).toMatchObject({
      id: "auto",
      object: "model",
      owned_by: "cursor",
    });
  });

  it("404s unknown models", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/models/nope", { headers: authHeaders() });
    expect(res.status).toBe(404);
  });
});

describe("unsupported routes", () => {
  it("returns 501 for embeddings", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/v1/embeddings", {
      model: "text-embedding-3-small",
      input: "hi",
    });
    expect(res.status).toBe(501);
  });
});

describe("GET /health", () => {
  it("does not require a bearer token", async () => {
    const { app } = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await jsonOf<{ status: string; runtime: string }>(res)).toMatchObject({
      status: "ok",
      runtime: "local",
    });
  });
});
