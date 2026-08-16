import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { SdkCursorBackend } from "../src/cursor/sdkBackend.ts";
import { hostedConfig } from "./helpers/app.ts";

const live =
  Boolean(process.env.CURSOR_API_KEY) && process.env.LIVE_SMOKE === "1";
const spawnCli = process.env.E2E_SPAWN === "1";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LISTEN_RE = /listening on (http:\/\/\S+)/;

const ADD_TOOL = {
  type: "function",
  function: {
    name: "add",
    description: "Add two numbers",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
  },
};

const MODEL = process.env.LIVE_SMOKE_MODEL ?? "auto";

describe.skipIf(!live)(
  `e2e HTTP proxy (${spawnCli ? "spawned" : "in-process"})`,
  { timeout: 120_000 },
  () => {
  let workspace: string;
  let base = "";
  let server: ServerType | undefined;
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    // Created here, not at describe-body scope: `describe.skipIf` still
    // runs this callback body during Vitest's collection phase even when
    // the suite ends up skipped, so a call here would leak a tmp dir on
    // every `npm test` run regardless of LIVE_SMOKE. beforeAll only runs
    // when the suite's tests actually execute.
    workspace = mkdtempSync(join(tmpdir(), "cursor-proxy-e2e-"));
    if (spawnCli) {
      const started = await startSpawnedProxy(workspace);
      child = started.child;
      base = started.base;
      return;
    }
    const { app } = createApp(
      hostedConfig({
        workspace,
        auth: {
          mode: "hosted",
          cursorApiKey: process.env.CURSOR_API_KEY!,
        },
      }),
      new SdkCursorBackend(),
    );
    await new Promise<void>((resolve, reject) => {
      server = serve(
        { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
        (info) => {
          base = `http://127.0.0.1:${info.port}`;
          resolve();
        },
      );
      server.once("error", reject);
    });
  });

  afterAll(async () => {
    if (child) {
      await stopChild(child);
    } else {
      await new Promise<void>((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  async function get(path: string, auth = true): Promise<Response> {
    return fetch(`${base}${path}`, {
      headers: auth ? { Authorization: "Bearer ollama" } : undefined,
    });
  }

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer ollama",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("serves /health without a bearer token", async () => {
    const res = await get("/health", false);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "ok",
      runtime: "local",
      session_mode: "sticky",
      auth_mode: "hosted",
    });
  });

  it("lists Cursor catalog models", async () => {
    const res = await get("/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((row) => row.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("auto");
  });

  it("answers 3+4 over chat completions", async () => {
    const res = await post("/v1/chat/completions", {
      model: MODEL,
      messages: [
        { role: "user", content: "What is 3+4? Reply with just the number." },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cursor-Session-Id")).toMatch(/^sess_/);
    const body = (await res.json()) as {
      choices: Array<{ finish_reason: string; message: { content: string } }>;
    };
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.choices[0]?.message.content).toMatch(/7/);
  });

  it("chains Responses 3+4 then why", async () => {
    const first = await post("/v1/responses", {
      model: MODEL,
      input: "What is 3+4? Reply with just the number.",
    });
    expect(first.status).toBe(200);
    const created = (await first.json()) as {
      id: string;
      status: string;
      output: Array<{ type: string; content?: Array<{ text: string }> }>;
    };
    expect(created.status).toBe("completed");
    // A visible-reasoning turn unshifts a `type: "reasoning"` item ahead of
    // the `message` item (see SPEC.md's "Reasoning summaries" section), so
    // the message isn't reliably output[0] -- find it by type instead.
    const createdMessage = created.output.find((item) => item.type === "message");
    expect(createdMessage?.content?.[0]?.text).toMatch(/7/);

    const second = await post("/v1/responses", {
      input: "Why? One short sentence.",
      previous_response_id: created.id,
    });
    expect(second.status).toBe(200);
    const follow = (await second.json()) as {
      status: string;
      previous_response_id: string;
      output: Array<{ type: string; content?: Array<{ text: string }> }>;
    };
    expect(follow.status).toBe("completed");
    expect(follow.previous_response_id).toBe(created.id);
    const followMessage = follow.output.find((item) => item.type === "message");
    expect(followMessage?.content?.[0]?.text.length).toBeGreaterThan(0);
  });

  it("parks a chat function tool and completes after the client result", async () => {
    const user = {
      role: "user" as const,
      content: "Call the add tool with a=3 and b=4. Do not compute the sum yourself.",
    };
    const first = await post("/v1/chat/completions", {
      model: MODEL,
      messages: [user],
      tools: [ADD_TOOL],
    });
    expect(first.status).toBe(200);
    const sessionId = first.headers.get("X-Cursor-Session-Id");
    expect(sessionId).toMatch(/^sess_/);
    const parked = (await first.json()) as {
      choices: Array<{
        finish_reason: string;
        message: {
          content: string | null;
          tool_calls: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };
    expect(parked.choices[0]?.finish_reason).toBe("tool_calls");
    expect(parked.choices[0]?.message.content).toBeNull();
    const toolCall = parked.choices[0]?.message.tool_calls[0];
    expect(toolCall?.function.name).toBe("add");
    expect(JSON.parse(toolCall?.function.arguments ?? "{}")).toMatchObject({
      a: 3,
      b: 4,
    });

    const second = await post("/v1/chat/completions", {
      model: MODEL,
      session_id: sessionId,
      tools: [ADD_TOOL],
      messages: [
        user,
        parked.choices[0]!.message,
        { role: "tool", tool_call_id: toolCall!.id, content: "7" },
      ],
    });
    expect(second.status).toBe(200);
    const done = (await second.json()) as {
      choices: Array<{ finish_reason: string; message: { content: string } }>;
    };
    expect(done.choices[0]?.finish_reason).toBe("stop");
    expect(done.choices[0]?.message.content).toMatch(/7/);
  });

  it("returns 501 for /v1/completions", async () => {
    const res = await post("/v1/completions", { prompt: "ping" });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      error: { code: "unsupported" },
    });
  });
});

describe("e2e spawned CLI", { timeout: 20_000 }, () => {
  it("listens on an ephemeral port and serves /health", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cursor-proxy-spawn-"));
    const started = await startSpawnedProxy(workspace);
    try {
      const res = await fetch(`${started.base}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok" });
    } finally {
      await stopChild(started.child);
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function startSpawnedProxy(
  workspace: string,
): Promise<{ child: ChildProcess; base: string }> {
  const tsxCli = join(ROOT, "node_modules/tsx/dist/cli.mjs");
  const child = spawn(
    process.execPath,
    [
      tsxCli,
      "src/index.ts",
      "--port",
      "0",
      "--host",
      "127.0.0.1",
      "--workspace",
      workspace,
    ],
    {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("spawned proxy did not log a listen address"));
    }, 20_000);

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `spawned proxy exited before listen (code=${code}, signal=${signal})`,
        ),
      );
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (settled) return;
      const match = buf.match(LISTEN_RE);
      if (!match) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve({ child, base: match[1]! });
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.once("exit", onExit);
  });
}

async function stopChild(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => proc.kill("SIGKILL"), 3_000);
    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}
