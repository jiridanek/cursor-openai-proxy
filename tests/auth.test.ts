import { describe, expect, it } from "vitest";
import { FakeCursorBackend } from "./helpers/fakeBackend.ts";
import {
  HOSTED_KEY,
  authHeaders,
  hostedConfig,
  jsonOf,
  makeApp,
  passthroughConfig,
  postJson,
} from "./helpers/app.ts";

describe("auth", () => {
  it("401s without Authorization", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/models");
    expect(res.status).toBe(401);
  });

  it("passthrough mode 401s dummy keys", async () => {
    const { app } = makeApp(new FakeCursorBackend(), passthroughConfig());
    const res = await app.request("/v1/models", {
      headers: authHeaders("ollama"),
    });
    expect(res.status).toBe(401);
  });

  it("hosted-key mode accepts dummy caller keys and uses the startup Cursor key", async () => {
    const backend = new FakeCursorBackend();
    const { app } = makeApp(backend, hostedConfig());
    const res = await app.request("/v1/models", {
      headers: authHeaders("ollama"),
    });
    expect(res.status).toBe(200);
    expect(backend.apiKeys[0]).toBe(HOSTED_KEY);
  });

  it("passthrough mode forwards the caller key to Cursor", async () => {
    const backend = new FakeCursorBackend();
    const { app } = makeApp(backend, passthroughConfig());
    const res = await app.request("/v1/models", {
      headers: authHeaders("crsr_caller"),
    });
    expect(res.status).toBe(200);
    expect(backend.apiKeys[0]).toBe("crsr_caller");
  });

  it("isolates sessions by caller key in hosted-key mode", async () => {
    const backend = new FakeCursorBackend();
    const { app } = makeApp(backend, hostedConfig());
    const first = await postJson(
      app,
      "/v1/responses",
      { input: "hello" },
      {},
      "tenant-a",
    );
    const created = await jsonOf<{ id: string }>(first);
    const other = await postJson(
      app,
      "/v1/responses",
      { input: "follow", previous_response_id: created.id },
      {},
      "tenant-b",
    );
    expect(other.status).toBe(404);
    const get = await app.request(`/v1/responses/${created.id}`, {
      headers: authHeaders("tenant-b"),
    });
    expect(get.status).toBe(404);
  });
});
