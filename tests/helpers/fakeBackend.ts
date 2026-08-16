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
  /**
   * When set, the pushed tool_call stream event reports the real Cursor SDK
   * wire shape for an MCP-routed customTool call: name:"mcp" and a
   * {providerIdentifier, toolName, args} envelope, instead of the resolved
   * name/arguments. `tool.execute()` is still invoked with the real,
   * unwrapped arguments either way -- only the stream event is wrapped.
   */
  wireWrap?: boolean;
  /**
   * When set, no "tool_call" stream event is pushed at all before
   * `tool.execute()` is called -- models the real SDK apparently never
   * surfacing a client-visible stream event for a customTool call that
   * parks (confirmed live: a real streaming request's SSE never emits a
   * tool_calls delta, jumping straight from text to
   * finish_reason:"tool_calls"). Proves listener notification doesn't
   * depend on that event arriving at all.
   */
  skipStreamEvent?: boolean;
};

export type FakeOptions = {
  reply?: string | ((prompt: string) => string);
  deltas?: string[];
  /** Pushed as "thinking" stream events, before `deltas`, to simulate the SDK's reasoning-summary stream. */
  thinkingDeltas?: string[];
  hangUntilCancel?: boolean;
  runError?: { message: string; code?: string };
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
  /**
   * Two or more tool calls the run dispatches together and awaits via
   * Promise.all -- unlike `toolCall` (single, awaited alone) or
   * `extraToolCalls` (fire-and-forget, never gates completion), every entry
   * here must resolve before the run pushes its final text and finishes.
   * Models a genuine multi-tool-call turn where the client may resolve them
   * one at a time across separate resumeParked() calls.
   */
  concurrentToolCalls?: FakeToolCall[];
  /**
   * When set alongside `toolCall`, the run reaches a terminal error outcome
   * `errorAfterParkMs` after parking -- independent of whether `toolCall`
   * has been resolved -- to simulate the underlying run failing out from
   * under a still-parked tool call.
   */
  errorAfterParkMs?: number;
  /** Observes whether a parked `toolCall.execute()` ultimately resolved or was rejected. */
  onToolExecuteSettled?: (callId: string, outcome: "resolved" | "rejected") => void;
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
    for (const delta of this.options.thinkingDeltas ?? []) {
      if (this.#cancelled) {
        this.#finish({ status: "cancelled", result: "" });
        return;
      }
      this.#push({ type: "thinking", text: delta });
    }
    const deltas = this.options.deltas ?? (this.options.toolCall ? [] : [this.#reply()]);
    for (const delta of deltas) {
      if (this.#cancelled) {
        this.#finish({ status: "cancelled", result: "" });
        return;
      }
      this.#push({ type: "text", text: delta });
    }
    const concurrentToolCalls = this.options.concurrentToolCalls;
    if (concurrentToolCalls && concurrentToolCalls.length > 0 && this.customTools) {
      const entries = concurrentToolCalls.map((tc) => ({
        tc,
        callId: tc.id ?? `call_${Math.random().toString(16).slice(2)}`,
      }));
      for (const { tc, callId } of entries) {
        if (tc.skipStreamEvent) continue;
        this.#push({
          type: "tool_call",
          callId,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        });
      }
      const outputs = await Promise.all(
        entries.map(async ({ tc, callId }) => {
          const tool = this.customTools![tc.name];
          if (!tool) return "";
          const result = await tool.execute(tc.arguments, { toolCallId: callId });
          return typeof result === "string" ? result : JSON.stringify(result ?? "");
        }),
      );
      if (this.#cancelled) {
        this.#finish({ status: "cancelled", result: "" });
        return;
      }
      const final = `tools:${outputs.join(",")}`;
      this.#push({ type: "text", text: final });
      this.#finish({
        status: "finished",
        result: final,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
      return;
    }
    const toolCall = this.options.toolCall;
    if (toolCall && this.customTools) {
      const callId = toolCall.id ?? "call_test";
      const argsJson = JSON.stringify(toolCall.arguments);
      if (!toolCall.skipStreamEvent) {
        this.#push(
          toolCall.wireWrap
            ? {
                type: "tool_call",
                callId,
                name: "mcp",
                arguments: JSON.stringify({
                  providerIdentifier: "custom-user-tools",
                  toolName: toolCall.name,
                  args: toolCall.arguments,
                }),
              }
            : {
                type: "tool_call",
                callId,
                name: toolCall.name,
                arguments: argsJson,
              },
        );
      }
      for (const extra of this.options.extraToolCalls ?? []) {
        void this.#dispatchExtra(extra);
      }
      if (this.options.errorAfterParkMs !== undefined) {
        const delay = this.options.errorAfterParkMs;
        void (async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          this.#finish({ status: "error", error: { message: "boom" } });
        })();
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
          this.options.onToolExecuteSettled?.(callId, "resolved");
        } catch {
          this.options.onToolExecuteSettled?.(callId, "rejected");
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
