import type { ProxyConfig } from "../../src/config.ts";
import { createApp } from "../../src/app.ts";
import type { CursorBackend } from "../../src/cursor/backend.ts";
import { FakeCursorBackend } from "./fakeBackend.ts";

export const HOSTED_KEY = "crsr_test_hosted_key";

export function hostedConfig(
  overrides: Partial<ProxyConfig> = {},
): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    workspace: "/tmp/workspace",
    sessionMode: "sticky",
    agentMode: "ask",
    auth: { mode: "hosted", cursorApiKey: HOSTED_KEY },
    ...overrides,
  };
}

export function passthroughConfig(
  overrides: Partial<ProxyConfig> = {},
): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    workspace: "/tmp/workspace",
    sessionMode: "sticky",
    agentMode: "ask",
    auth: { mode: "passthrough" },
    ...overrides,
  };
}

export function makeApp(
  backend: CursorBackend = new FakeCursorBackend(),
  config: ProxyConfig = hostedConfig(),
) {
  return { ...createApp(config, backend), backend };
}

export function authHeaders(
  apiKey = "ollama",
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

export async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
