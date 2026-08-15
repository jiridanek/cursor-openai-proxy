import { Agent, Cursor } from "@cursor/sdk";
import type {
  AgentHandle,
  CreateAgentOptions,
  CursorBackend,
  ModelListItem,
  RunHandle,
  RunOutcome,
} from "./backend.ts";

type SdkRun = Awaited<ReturnType<Awaited<ReturnType<typeof Agent.create>>["send"]>>;
type SdkAgent = Awaited<ReturnType<typeof Agent.create>>;

function wrapRun(run: SdkRun): RunHandle {
  return {
    id: run.id,
    async *streamText() {
      if (!run.supports("stream")) return;
      for await (const event of run.stream()) {
        if (event.type !== "assistant") continue;
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) yield block.text;
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
    async send(prompt: string) {
      const run = await agent.send(prompt);
      return wrapRun(run);
    },
    async close() {
      await agent[Symbol.asyncDispose]();
    },
  };
}

export class SdkCursorBackend implements CursorBackend {
  async listModels(apiKey: string): Promise<ModelListItem[]> {
    const models = await Cursor.models.list({ apiKey });
    return models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      aliases: model.aliases,
      parameters: model.parameters?.map((parameter) => ({
        id: parameter.id,
        values: parameter.values.map((value) => ({ value: value.value })),
      })),
    }));
  }

  async createAgent(options: CreateAgentOptions): Promise<AgentHandle> {
    const agent = await Agent.create({
      apiKey: options.apiKey,
      model: {
        id: options.model,
        params: options.params,
      },
      mode: options.mode === "ask" ? undefined : options.mode,
      tools: options.mode === "ask" ? ["read", "grep", "glob", "ls"] : undefined,
      local: { cwd: options.workspace },
    });
    return wrapAgent(agent);
  }
}
