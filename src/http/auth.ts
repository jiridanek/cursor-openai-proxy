import { createHash } from "node:crypto";
import type { AuthConfig } from "../config.ts";
import { HttpError } from "./errors.ts";

const DUMMY_KEYS = new Set(["ollama", "sk-dummy"]);

export type RequestAuth = {
  callerKeyHash: string;
  cursorApiKey: string;
};

export function hashCallerKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isDummyKey(token: string): boolean {
  return DUMMY_KEYS.has(token.trim().toLowerCase());
}

export function authenticate(
  authorization: string | undefined,
  auth: AuthConfig,
): RequestAuth {
  if (!authorization || !authorization.toLowerCase().startsWith("bearer ")) {
    throw new HttpError(401, "Missing API key", {
      type: "invalid_request_error",
      code: "invalid_api_key",
    });
  }
  const token = authorization.slice("bearer ".length).trim();
  if (!token) {
    throw new HttpError(401, "Missing API key", {
      type: "invalid_request_error",
      code: "invalid_api_key",
    });
  }
  if (auth.mode === "passthrough" && isDummyKey(token)) {
    throw new HttpError(401, "Invalid API key", {
      type: "invalid_request_error",
      code: "invalid_api_key",
    });
  }
  return {
    callerKeyHash: hashCallerKey(token),
    cursorApiKey: auth.mode === "hosted" ? auth.cursorApiKey : token,
  };
}
