import { existsSync } from "node:fs";
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

describe("SdkCursorBackend model catalog mapping", () => {
  it("keeps displayName, description, and variants instead of dropping them", async () => {
    // The cache used to narrow each SDK model down to {id, aliases,
    // parameters} only, silently dropping displayName/description/variants
    // even though Cursor.models.list() returns them -- so no endpoint could
    // ever surface this data, regardless of what the HTTP layer wanted to do
    // with it.
    vi.mocked(Cursor.models.list).mockResolvedValueOnce([
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
            description: "More thorough reasoning.",
            isDefault: true,
          },
        ],
      },
    ]);
    const backend = new SdkCursorBackend();

    const models = await backend.listModels("key");

    expect(models).toEqual([
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
            description: "More thorough reasoning.",
            isDefault: true,
          },
        ],
      },
    ]);
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

describe("SdkCursorBackend workspace isolation", () => {
  // The proxy must never let a local agent see the operator's real cwd or
  // an operator-supplied path -- every agent gets its own fresh, empty temp
  // directory, unconditionally (not an opt-in flag). These tests exercise
  // that directly against the mocked `Agent.create` call.
  //
  // `Agent.create` is one `vi.fn()` shared across every test in this file
  // (declared once in the top-level `vi.mock("@cursor/sdk", ...)`), so its
  // `.mock.calls` history accumulates across describe blocks -- reading
  // `.mock.calls[0]` here would pick up a call (and since-deleted temp dir)
  // from an earlier test, not this one. Capture each call's `cwd` directly
  // in the mock's own implementation closure instead of indexing history.
  function mockAgent(): { dispose: ReturnType<typeof vi.fn>; getCwd: () => string | undefined } {
    const dispose = vi.fn().mockResolvedValue(undefined);
    let cwd: string | undefined;
    vi.mocked(Agent.create).mockImplementationOnce(
      async (opts) =>
        {
          cwd = opts.local?.cwd;
          return {
            agentId: "agent-under-test",
            [Symbol.asyncDispose]: dispose,
          } as unknown as Awaited<ReturnType<typeof Agent.create>>;
        },
    );
    return { dispose, getCwd: () => cwd };
  }

  it("gives the agent a fresh temp dir, never process.cwd(), and removes it on close", async () => {
    const { getCwd } = mockAgent();
    const backend = new SdkCursorBackend();
    const handle = await backend.createAgent(AGENT_OPTIONS);

    const cwd = getCwd();
    expect(cwd).toBeDefined();
    expect(cwd).not.toBe(process.cwd());
    expect(existsSync(cwd!)).toBe(true);

    await handle.close();
    expect(existsSync(cwd!)).toBe(false);
  });

  it("gives two agents two different temp dirs", async () => {
    const first = mockAgent();
    const second = mockAgent();
    const backend = new SdkCursorBackend();
    await backend.createAgent(AGENT_OPTIONS);
    await backend.createAgent(AGENT_OPTIONS);

    expect(first.getCwd()).toBeDefined();
    expect(second.getCwd()).toBeDefined();
    expect(first.getCwd()).not.toBe(second.getCwd());
  });

  it("removes the temp dir if Agent.create itself fails", async () => {
    let capturedCwd: string | undefined;
    vi.mocked(Agent.create).mockImplementationOnce(async (opts) => {
      capturedCwd = opts.local?.cwd;
      throw new Error("boom");
    });
    const backend = new SdkCursorBackend();
    await expect(backend.createAgent(AGENT_OPTIONS)).rejects.toThrow("boom");

    expect(capturedCwd).toBeDefined();
    expect(existsSync(capturedCwd!)).toBe(false);
  });
});
