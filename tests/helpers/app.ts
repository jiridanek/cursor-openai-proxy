import type { ProxyConfig } from "../../src/config.ts";
import { createApp } from "../../src/app.ts";
import type { CursorBackend } from "../../src/cursor/backend.ts";
import { FakeCursorBackend } from "./fakeBackend.ts";

export const HOSTED_KEY = "crsr_test_hosted_key";

const DEFAULTS = {
  host: "127.0.0.1",
  port: 0,
  sessionMode: "sticky",
  agentMode: "ask",
} as const;

export function hostedConfig(
  overrides: Partial<ProxyConfig> = {},
): ProxyConfig {
  return {
    ...DEFAULTS,
    auth: { mode: "hosted", cursorApiKey: HOSTED_KEY },
    ...overrides,
  };
}

export function passthroughConfig(
  overrides: Partial<ProxyConfig> = {},
): ProxyConfig {
  return hostedConfig({ auth: { mode: "passthrough" }, ...overrides });
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

export function postJson(
  app: ReturnType<typeof createApp>["app"],
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
  apiKey = "ollama",
) {
  return app.request(path, {
    method: "POST",
    headers: authHeaders(apiKey, extra),
    body: JSON.stringify(body),
  });
}

export function normalizeSse(
  raw: string,
  replacements: Array<readonly [RegExp, string]>,
): string {
  return replacements.reduce(
    (text, [pattern, value]) => text.replaceAll(pattern, value),
    raw,
  );
}

export async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
