import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/config.ts";

describe("parseArgs", () => {
  it("accepts --port 0 for an ephemeral listen port", () => {
    expect(parseArgs(["--port", "0"]).port).toBe(0);
  });

  it("rejects a negative --port", () => {
    expect(() => parseArgs(["--port", "-1"])).toThrow(/Invalid --port/);
  });
});
