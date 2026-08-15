import { describe, expect, it, vi } from "vitest";

// SdkCursorBackend imports Agent + Cursor from @cursor/sdk at module load
// time; both must be stubbed even though this suite only exercises
// Cursor.models.list.
vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn() },
  Cursor: { models: { list: vi.fn().mockResolvedValue([]) } },
}));

import { Cursor } from "@cursor/sdk";
import { SdkCursorBackend } from "../src/cursor/sdkBackend.ts";

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
