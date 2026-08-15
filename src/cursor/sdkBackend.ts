import { Agent, Cursor, type SDKCustomTool } from "@cursor/sdk";
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

function wrapAgent(agent: SdkAgent): AgentHandle {
  return {
    agentId: agent.agentId,
    async send(prompt, options) {
      const customTools = toSdkCustomTools(options?.customTools);
      const run = await agent.send(
        prompt,
        customTools ? { local: { customTools } } : undefined,
      );
      return wrapRun(run);
    },
    async close() {
      await agent[Symbol.asyncDispose]();
    },
  };
}

const CATALOG_TTL_MS = 60_000;

export class SdkCursorBackend implements CursorBackend {
  #catalog = new Map<string, { expires: number; models: ModelListItem[] }>();
  #inflight = new Map<string, Promise<ModelListItem[]>>();

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
          aliases: model.aliases,
          parameters: model.parameters?.map((parameter) => ({
            id: parameter.id,
            values: parameter.values.map((value) => ({ value: value.value })),
          })),
        }));
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

  async createAgent(options: CreateAgentOptions): Promise<AgentHandle> {
    const agent = await Agent.create({
      apiKey: options.apiKey,
      model: {
        id: options.model,
        params: options.params,
      },
      mode: options.mode === "ask" ? undefined : options.mode,
      tools: options.tools,
      local: { cwd: options.workspace, settingSources: [] },
    });
    return wrapAgent(agent);
  }
}
