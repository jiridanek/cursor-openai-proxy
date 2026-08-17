import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  AgentBusyError,
  AuthenticationError,
  ConfigurationError,
  Cursor,
  CursorSdkError,
  NetworkError,
  RateLimitError,
  type SDKCustomTool,
} from "@cursor/sdk";
import { HttpError } from "../http/errors.ts";
import type {
  AgentHandle,
  CreateAgentOptions,
  CustomToolsMap,
  CursorBackend,
  ModelListItem,
  RunHandle,
  RunOutcome,
  StreamEvent,
} from "./backend.ts";

// The Cursor SDK's error classes are all direct siblings under
// CursorSdkError (none subclasses another), so instanceof-check order
// doesn't matter here -- a table lookup is behaviorally identical to an
// if-chain. Each class's intended HTTP status/type is per @cursor/sdk's own
// errors.d.ts doc comments; the instances themselves don't reliably set
// `.status`, so map by class instead of trusting the field.
const SDK_ERROR_STATUS_MAP: ReadonlyArray<
  [
    new (...args: never[]) => CursorSdkError,
    number,
    "invalid_request_error" | "internal_error",
  ]
> = [
  [AuthenticationError, 401, "invalid_request_error"],
  [RateLimitError, 429, "invalid_request_error"],
  [ConfigurationError, 400, "invalid_request_error"],
  [AgentBusyError, 409, "invalid_request_error"],
  [NetworkError, 503, "internal_error"],
];

function mapSdkError(err: unknown): HttpError | undefined {
  if (!(err instanceof CursorSdkError)) return undefined;
  for (const [ErrorClass, status, type] of SDK_ERROR_STATUS_MAP) {
    if (err instanceof ErrorClass) {
      return new HttpError(status, err.message, { type, code: err.code ?? null });
    }
  }
  return new HttpError(500, err.message, {
    type: "internal_error",
    code: err.code ?? null,
  });
}

type SdkRun = Awaited<
  ReturnType<Awaited<ReturnType<typeof Agent.create>>["send"]>
>;
type SdkAgent = Awaited<ReturnType<typeof Agent.create>>;

function stringifyArgs(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

function toSdkCustomTools(
  tools: CustomToolsMap | undefined,
): Record<string, SDKCustomTool> | undefined {
  if (!tools) return undefined;
  const mapped: Record<string, SDKCustomTool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    mapped[name] = {
      description: tool.description,
      inputSchema: tool.inputSchema as SDKCustomTool["inputSchema"],
      execute: (args, context) =>
        Promise.resolve(
          tool.execute(args as Record<string, unknown>, context),
        ).then((result) => result as string),
    };
  }
  return mapped;
}

function wrapRun(run: SdkRun): RunHandle {
  return {
    id: run.id,
    async *stream(): AsyncIterable<StreamEvent> {
      if (!run.supports("stream")) return;
      for await (const event of run.stream()) {
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              yield { type: "text", text: block.text };
            }
          }
          continue;
        }
        if (event.type === "tool_call") {
          yield {
            type: "tool_call",
            callId: event.call_id,
            name: event.name,
            arguments: stringifyArgs(event.args),
          };
          continue;
        }
        if (event.type === "thinking" && event.text) {
          yield { type: "thinking", text: event.text };
        }
      }
    },
    async wait(): Promise<RunOutcome> {
      const result = await run.wait();
      return {
        status: result.status,
        result: result.result,
        usage: result.usage
          ? {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              totalTokens: result.usage.totalTokens,
            }
          : undefined,
        error: result.error,
      };
    },
    async cancel() {
      if (run.supports("cancel")) await run.cancel();
    },
    supports(operation) {
      return run.supports(operation);
    },
  };
}

function wrapAgent(agent: SdkAgent, tempDir: string): AgentHandle {
  return {
    agentId: agent.agentId,
    async send(prompt, options) {
      const customTools = toSdkCustomTools(options?.customTools);
      try {
        const run = await agent.send(
          prompt,
          customTools ? { local: { customTools } } : undefined,
        );
        return wrapRun(run);
      } catch (err) {
        throw mapSdkError(err) ?? err;
      }
    },
    async close() {
      await agent[Symbol.asyncDispose]();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

const CATALOG_TTL_MS = 60_000;
// Passthrough auth mode keys the cache on the caller-supplied bearer token,
// so without a cap a long-running proxy serving many distinct keys would
// grow #catalog forever. This bounds worst-case memory use.
const MAX_CATALOG_ENTRIES = 1_000;

// Every local agent this proxy creates must be isolated from the operator's
// real machine, unconditionally -- not an opt-in flag. Two layers:
// (1) each agent gets its own fresh, empty cwd (see createAgent()); (2) the
// host environment is scrubbed once per process so the SDK/CLI can't fall
// back to the operator's real home directory or Cursor config even if some
// code path reads it directly instead of going through `local.cwd`. This
// runs once regardless of how many SdkCursorBackend instances get
// constructed (tests may construct more than one).
let hostEnvScrubbed = false;
function scrubHostEnv(): void {
  if (hostEnvScrubbed) return;
  hostEnvScrubbed = true;
  const isolatedHome = mkdtempSync(join(tmpdir(), "cursor-proxy-home-"));
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.CURSOR_CONFIG_DIR = isolatedHome;
}

export class SdkCursorBackend implements CursorBackend {
  #catalog = new Map<string, { expires: number; models: ModelListItem[] }>();
  #inflight = new Map<string, Promise<ModelListItem[]>>();

  constructor() {
    scrubHostEnv();
  }

  async listModels(apiKey: string): Promise<ModelListItem[]> {
    const cached = this.#catalog.get(apiKey);
    if (cached && cached.expires > Date.now()) return cached.models;
    const pending = this.#inflight.get(apiKey);
    if (pending) return pending;
    const load = Cursor.models
      .list({ apiKey })
      .then((models) => {
        const mapped: ModelListItem[] = models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          description: model.description,
          aliases: model.aliases,
          parameters: model.parameters?.map((parameter) => ({
            id: parameter.id,
            values: parameter.values.map((value) => ({ value: value.value })),
          })),
          variants: model.variants?.map((variant) => ({
            params: variant.params.map((param) => ({
              id: param.id,
              value: param.value,
            })),
            displayName: variant.displayName,
            description: variant.description,
            isDefault: variant.isDefault,
          })),
        }));
        this.#pruneCatalog();
        this.#catalog.set(apiKey, {
          expires: Date.now() + CATALOG_TTL_MS,
          models: mapped,
        });
        return mapped;
      })
      .finally(() => {
        this.#inflight.delete(apiKey);
      });
    this.#inflight.set(apiKey, load);
    return load;
  }

  /** Exposed for tests only; not part of the CursorBackend contract. */
  get catalogSize(): number {
    return this.#catalog.size;
  }

  #pruneCatalog(): void {
    const now = Date.now();
    for (const [key, entry] of this.#catalog) {
      if (entry.expires <= now) this.#catalog.delete(key);
    }
    while (this.#catalog.size >= MAX_CATALOG_ENTRIES) {
      const oldest = this.#catalog.keys().next().value;
      if (oldest === undefined) break;
      this.#catalog.delete(oldest);
    }
  }

  async createAgent(options: CreateAgentOptions): Promise<AgentHandle> {
    // A fresh, empty temp dir per agent -- never the operator's real cwd or
    // an operator-configured workspace. This is what actually contains
    // ask-mode's read/grep/glob/ls and plan/agent-mode's shell/edit: those
    // tools can only ever see this throwaway directory. Removed in
    // wrapAgent()'s close().
    const tempDir = mkdtempSync(join(tmpdir(), "cursor-agent-"));
    try {
      const agent = await Agent.create({
        apiKey: options.apiKey,
        model: {
          id: options.model,
          params: options.params,
        },
        mode: options.mode === "ask" ? undefined : options.mode,
        tools: options.tools,
        local: { cwd: tempDir, settingSources: [] },
      });
      return wrapAgent(agent, tempDir);
    } catch (err) {
      rmSync(tempDir, { recursive: true, force: true });
      throw mapSdkError(err) ?? err;
    }
  }
}
