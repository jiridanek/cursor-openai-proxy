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

describe("GET /v1/model/info", () => {
  it("lists catalog ids and aliases in LiteLLM shape", async () => {
    const { app } = makeApp(new FakeCursorBackend());
    const res = await app.request("/v1/model/info", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await jsonOf<{
      data: Array<{
        model_name: string;
        litellm_params: { model: string };
        model_info: {
          id: string;
          db_model: boolean;
          litellm_provider: string;
          mode: string;
        };
      }>;
    }>(res);
    expect(body.data.map((row) => row.model_name)).toEqual([
      "composer-2.5",
      "composer",
      "auto",
    ]);
    for (const row of body.data) {
      expect(row.litellm_params.model).toBe(row.model_name);
      expect(row.model_info.id).toBe(row.model_name);
      expect(row.model_info.db_model).toBe(false);
      expect(row.model_info.litellm_provider).toBe("cursor");
      expect(row.model_info.mode).toBe("chat");
    }
  });

  it("requires auth", async () => {
    const { app } = makeApp(new FakeCursorBackend());
    const res = await app.request("/v1/model/info");
    expect(res.status).toBe(401);
  });

  it("surfaces displayName/description/parameters/variants when the catalog has them", async () => {
    const backend = new FakeCursorBackend();
    backend.models = [
      {
        id: "claude-sonnet-5",
        displayName: "Claude Sonnet 5",
        description: "Anthropic's Sonnet 5 model.",
        aliases: ["sonnet", "sonnet-5"],
        parameters: [
          { id: "effort", values: [{ value: "low" }, { value: "high" }] },
        ],
        variants: [
          {
            params: [{ id: "effort", value: "high" }],
            displayName: "High effort",
            isDefault: true,
          },
        ],
      },
    ];
    const { app } = makeApp(backend);

    const res = await app.request("/v1/model/info", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await jsonOf<{
      data: Array<{
        model_name: string;
        model_info: {
          display_name?: string;
          description?: string;
          aliases?: string[];
          parameters?: unknown;
          variants?: unknown;
        };
      }>;
    }>(res);

    const primary = body.data.find((row) => row.model_name === "claude-sonnet-5");
    expect(primary?.model_info.display_name).toBe("Claude Sonnet 5");
    expect(primary?.model_info.description).toBe("Anthropic's Sonnet 5 model.");
    expect(primary?.model_info.aliases).toEqual(["sonnet", "sonnet-5"]);
    expect(primary?.model_info.parameters).toEqual([
      { id: "effort", values: [{ value: "low" }, { value: "high" }] },
    ]);
    expect(primary?.model_info.variants).toEqual([
      {
        params: [{ id: "effort", value: "high" }],
        displayName: "High effort",
        isDefault: true,
      },
    ]);

    // An alias entry reports the *other* names, not itself.
    const alias = body.data.find((row) => row.model_name === "sonnet");
    expect(alias?.model_info.aliases).toEqual(["claude-sonnet-5", "sonnet-5"]);
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
