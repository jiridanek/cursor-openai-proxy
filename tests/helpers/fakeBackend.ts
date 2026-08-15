import type {
  AgentHandle,
  CreateAgentOptions,
  CustomToolsMap,
  CursorBackend,
  ModelListItem,
  RunHandle,
  RunOutcome,
  SendOptions,
  StreamEvent,
} from "../../src/cursor/backend.ts";

export type SendCall = {
  agentId: string;
  prompt: string;
  customTools?: string[];
};

export type FakeToolCall = {
  name: string;
  arguments: Record<string, unknown>;
  id?: string;
  finalReply?: string | ((toolOutput: string) => string);
};

export type FakeOptions = {
  reply?: string | ((prompt: string) => string);
  deltas?: string[];
  hangUntilCancel?: boolean;
  runError?: { message: string };
  toolCall?: FakeToolCall;
  /**
   * When set, each successive `send()` on the fake agent pops the next entry
   * instead of reusing `toolCall`. Lets a test drive multiple independent
   * tool-calling rounds (each its own run/supervisor) on one sticky session.
   */
  toolCallSequence?: FakeToolCall[];
  /**
   * Additional tool calls dispatched `delayMs` after `toolCall` parks,
   * independent of whether `toolCall` has been resolved yet. Lets a test
   * simulate the underlying SDK emitting a second tool_call for the same
   * turn later than the idle-park heuristic's window.
   */
  extraToolCalls?: Array<FakeToolCall & { delayMs: number }>;
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
      async send(prompt: string, sendOptions?: SendOptions): Promise<RunHandle> {
        backend.sends.push({
          agentId,
          prompt,
          customTools: sendOptions?.customTools
            ? Object.keys(sendOptions.customTools)
            : undefined,
        });
        const sequence = backend.options.toolCallSequence;
        const options = sequence
          ? { ...backend.options, toolCall: sequence[backend.sends.length - 1] }
          : backend.options;
        return new FakeRun(prompt, options, sendOptions?.customTools);
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
  readonly customTools?: CustomToolsMap;
  #cancelled = false;
  #done = false;
  #queue: StreamEvent[] = [];
  #notify: Array<() => void> = [];
  #loop?: Promise<void>;
  #outcome: RunOutcome = { status: "finished", result: "" };
  #cancelWaiters: Array<(outcome: RunOutcome) => void> = [];

  constructor(
    prompt: string,
    options: FakeOptions,
    customTools?: CustomToolsMap,
  ) {
    this.prompt = prompt;
    this.options = options;
    this.customTools = customTools;
    this.id = `run-${Math.random().toString(16).slice(2)}`;
  }

  async *stream(): AsyncIterable<StreamEvent> {
    this.#start();
    let index = 0;
    while (true) {
      while (index < this.#queue.length) {
        yield this.#queue[index++]!;
      }
      if (this.#done) return;
      await new Promise<void>((resolve) => {
        this.#notify.push(resolve);
      });
    }
  }

  async wait(): Promise<RunOutcome> {
    this.#start();
    while (!this.#done) {
      await new Promise<void>((resolve) => {
        this.#notify.push(resolve);
      });
    }
    return this.#outcome;
  }

  async cancel(): Promise<void> {
    this.#cancelled = true;
    for (const waiter of this.#cancelWaiters) {
      waiter({ status: "cancelled", result: "" });
    }
    this.#cancelWaiters = [];
    this.#finish({ status: "cancelled", result: "" });
  }

  supports(operation: "cancel" | "stream" | "wait"): boolean {
    return operation === "cancel" || operation === "stream" || operation === "wait";
  }

  #start(): void {
    if (this.#loop) return;
    this.#loop = this.#run();
  }

  async #run(): Promise<void> {
    if (this.options.hangUntilCancel) {
      if (!this.#cancelled) await this.#untilCancelled();
      this.#finish({ status: "cancelled", result: "" });
      return;
    }
    if (this.options.runError) {
      this.#finish({ status: "error", error: this.options.runError });
      return;
    }
    const deltas = this.options.deltas ?? (this.options.toolCall ? [] : [this.#reply()]);
    for (const delta of deltas) {
      if (this.#cancelled) {
        this.#finish({ status: "cancelled", result: "" });
        return;
      }
      this.#push({ type: "text", text: delta });
    }
    const toolCall = this.options.toolCall;
    if (toolCall && this.customTools) {
      const callId = toolCall.id ?? "call_test";
      const argsJson = JSON.stringify(toolCall.arguments);
      this.#push({
        type: "tool_call",
        callId,
        name: toolCall.name,
        arguments: argsJson,
      });
      for (const extra of this.options.extraToolCalls ?? []) {
        void this.#dispatchExtra(extra);
      }
      const tool = this.customTools[toolCall.name];
      let output = "";
      if (tool) {
        try {
          const result = await tool.execute(toolCall.arguments, {
            toolCallId: callId,
          });
          output =
            typeof result === "string" ? result : JSON.stringify(result ?? "");
        } catch {
          this.#finish({ status: "cancelled", result: "" });
          return;
        }
      }
      if (this.#cancelled) {
        this.#finish({ status: "cancelled", result: "" });
        return;
      }
      const final =
        typeof toolCall.finalReply === "function"
          ? toolCall.finalReply(output)
          : (toolCall.finalReply ?? `tool:${output}`);
      this.#push({ type: "text", text: final });
      this.#finish({
        status: "finished",
        result: final,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
      return;
    }
    this.#finish({
      status: "finished",
      result: this.#reply(),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  }

  async #dispatchExtra(tc: FakeToolCall & { delayMs: number }): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, tc.delayMs));
    if (!this.customTools) return;
    const callId = tc.id ?? `call_${Math.random().toString(16).slice(2)}`;
    this.#push({
      type: "tool_call",
      callId,
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
    });
    const tool = this.customTools[tc.name];
    if (!tool) return;
    // This park is intentionally left unresolved -- it models a call the
    // test never answers, only checks for visibility in pendingToolCalls.
    await Promise.resolve(tool.execute(tc.arguments, { toolCallId: callId })).catch(
      () => undefined,
    );
  }

  #reply(): string {
    const reply = this.options.reply;
    if (typeof reply === "function") return reply(this.prompt);
    return reply ?? `echo:${this.prompt}`;
  }

  #untilCancelled(): Promise<void> {
    return new Promise((resolve) => {
      this.#cancelWaiters.push(() => resolve());
    });
  }

  #push(event: StreamEvent): void {
    this.#queue.push(event);
    this.#flush();
  }

  #finish(outcome: RunOutcome): void {
    if (this.#done) return;
    this.#outcome = outcome;
    this.#done = true;
    this.#flush();
  }

  #flush(): void {
    const waiters = this.#notify;
    this.#notify = [];
    for (const waiter of waiters) waiter();
  }
}
