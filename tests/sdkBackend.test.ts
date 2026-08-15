import { describe, expect, it, vi } from "vitest";

// SdkCursorBackend imports Agent + Cursor from @cursor/sdk at module load
// time; both must be stubbed. The real error classes (ConfigurationError,
// RateLimitError, ...) are kept as-is via importActual so sdkBackend.ts's
// `instanceof` checks against them still work against errors constructed in
// this test file.
vi.mock("@cursor/sdk", async () => {
  const actual = await vi.importActual<typeof import("@cursor/sdk")>(
    "@cursor/sdk",
  );
  return {
    ...actual,
    Agent: { create: vi.fn() },
    Cursor: { models: { list: vi.fn().mockResolvedValue([]) } },
  };
});

import { Agent, ConfigurationError, Cursor, RateLimitError } from "@cursor/sdk";
import { SdkCursorBackend } from "../src/cursor/sdkBackend.ts";

const AGENT_OPTIONS = {
  apiKey: "key",
  model: "baf",
  workspace: "/tmp",
  mode: "ask" as const,
};

describe("SdkCursorBackend model catalog cache", () => {
  it("caps the number of cached api keys instead of growing without bound", async () => {
    // In passthrough auth mode, listModels() is keyed on the caller-supplied
    // bearer token. Before this fix, #catalog only grew (entries were
    // overwritten on re-request, never evicted), so a long-running proxy
    // seeing many distinct valid keys would accumulate one permanent entry
    // per key for the life of the process.
    const backend = new SdkCursorBackend();
    const overflow = 50;
    const totalKeys = 1_000 + overflow; // matches MAX_CATALOG_ENTRIES in sdkBackend.ts

    for (let i = 0; i < totalKeys; i += 1) {
      await backend.listModels(`key-${i}`);
    }

    expect(vi.mocked(Cursor.models.list)).toHaveBeenCalledTimes(totalKeys);
    expect(backend.catalogSize).toBeLessThan(totalKeys);
    expect(backend.catalogSize).toBeLessThanOrEqual(1_000);
  });
});

describe("SdkCursorBackend SDK error mapping", () => {
  it("maps a thrown ConfigurationError to a 400 invalid_request_error", async () => {
    vi.mocked(Agent.create).mockRejectedValueOnce(
      new ConfigurationError("Cannot use this model: baf.", {
        isRetryable: false,
      }),
    );
    const backend = new SdkCursorBackend();
    await expect(backend.createAgent(AGENT_OPTIONS)).rejects.toMatchObject({
      status: 400,
      type: "invalid_request_error",
      message: "Cannot use this model: baf.",
    });
  });

  it("maps a thrown RateLimitError to a 429 invalid_request_error", async () => {
    vi.mocked(Agent.create).mockRejectedValueOnce(
      new RateLimitError("Too many requests", { isRetryable: true }),
    );
    const backend = new SdkCursorBackend();
    await expect(backend.createAgent(AGENT_OPTIONS)).rejects.toMatchObject({
      status: 429,
      type: "invalid_request_error",
      message: "Too many requests",
    });
  });

  it("passes through a non-SDK error unchanged", async () => {
    vi.mocked(Agent.create).mockRejectedValueOnce(new Error("boom"));
    const backend = new SdkCursorBackend();
    await expect(backend.createAgent(AGENT_OPTIONS)).rejects.toThrow("boom");
  });
});
