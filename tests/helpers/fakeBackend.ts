import type {
  AgentHandle,
  CreateAgentOptions,
  CursorBackend,
  ModelListItem,
  RunHandle,
  RunOutcome,
} from "../../src/cursor/backend.ts";

export type SendCall = { agentId: string; prompt: string };

export type FakeOptions = {
  reply?: string | ((prompt: string) => string);
  deltas?: string[];
  hangUntilCancel?: boolean;
  runError?: { message: string };
};

export class FakeCursorBackend implements CursorBackend {
  creates = 0;
  sends: SendCall[] = [];
  closed: string[] = [];
  apiKeys: string[] = [];
  createOptions: CreateAgentOptions[] = [];
  models: ModelListItem[] = [
    {
      id: "composer-2.5",
      aliases: ["composer", "auto"],
      parameters: [
        { id: "effort", values: [{ value: "low" }, { value: "high" }] },
      ],
    },
  ];
  readonly options: FakeOptions;

  constructor(options: FakeOptions = {}) {
    this.options = options;
  }

  async listModels(apiKey: string): Promise<ModelListItem[]> {
    this.apiKeys.push(apiKey);
    return this.models;
  }

  async createAgent(options: CreateAgentOptions): Promise<AgentHandle> {
    this.creates += 1;
    this.createOptions.push(options);
    this.apiKeys.push(options.apiKey);
    const agentId = `agent-${this.creates}`;
    const backend = this;
    return {
      agentId,
      async send(prompt: string): Promise<RunHandle> {
        backend.sends.push({ agentId, prompt });
        return new FakeRun(prompt, backend.options);
      },
      async close() {
        backend.closed.push(agentId);
      },
    };
  }
}

class FakeRun implements RunHandle {
  readonly id: string;
  readonly prompt: string;
  readonly options: FakeOptions;
  #cancelled = false;
  #waiters: Array<(outcome: RunOutcome) => void> = [];

  constructor(prompt: string, options: FakeOptions) {
    this.prompt = prompt;
    this.options = options;
    this.id = `run-${Math.random().toString(16).slice(2)}`;
  }

  async *streamText(): AsyncIterable<string> {
    if (this.options.hangUntilCancel) {
      await this.#untilCancelled();
      return;
    }
    if (this.options.runError) return;
    const deltas = this.options.deltas ?? [this.#reply()];
    for (const delta of deltas) {
      if (this.#cancelled) return;
      yield delta;
    }
  }

  async wait(): Promise<RunOutcome> {
    if (this.options.hangUntilCancel) {
      if (!this.#cancelled) await this.#untilCancelled();
      return { status: "cancelled", result: "" };
    }
    if (this.#cancelled) return { status: "cancelled", result: "" };
    if (this.options.runError) {
      return { status: "error", error: this.options.runError };
    }
    return {
      status: "finished",
      result: this.#reply(),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  async cancel(): Promise<void> {
    this.#cancelled = true;
    for (const waiter of this.#waiters) {
      waiter({ status: "cancelled", result: "" });
    }
    this.#waiters = [];
  }

  supports(operation: "cancel" | "stream" | "wait"): boolean {
    return operation === "cancel" || operation === "stream" || operation === "wait";
  }

  #reply(): string {
    const reply = this.options.reply;
    if (typeof reply === "function") return reply(this.prompt);
    return reply ?? `echo:${this.prompt}`;
  }

  #untilCancelled(): Promise<void> {
    return new Promise((resolve) => {
      this.#waiters.push(() => resolve());
    });
  }
}
