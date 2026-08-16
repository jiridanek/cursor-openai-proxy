import type {
  CustomToolsMap,
  RunHandle,
  RunOutcome,
  StreamEvent,
} from "../cursor/backend.ts";
import { HttpError } from "../http/errors.ts";
import { newId } from "../ids.ts";
import type {
  FunctionCallOutput,
  FunctionToolDef,
  PendingToolCall,
} from "../mapping.ts";
import type { SessionRecord } from "./registry.ts";

export const PARK_IDLE_MS = 50;

export type RunListener = (event: StreamEvent) => Promise<void> | void;

export type TurnResult = {
  status: SessionRecord["status"];
  text: string;
  reasoningText: string;
  toolCalls: PendingToolCall[];
};

type ParkedExecute = PendingToolCall & {
  resolve: (output: string) => void;
  reject: (error: Error) => void;
};

export type RunSupervisor = {
  run: RunHandle;
  parks: Map<string, ParkedExecute>;
  itemIds: Map<string, string>;
  outputText: string;
  reasoningText: string;
  listener?: RunListener;
  onPark?: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
  streamDone: Promise<void>;
  waitDone: Promise<RunOutcome>;
  waitSettled: boolean;
};

function publicCalls(parks: Map<string, ParkedExecute>): PendingToolCall[] {
  return [...parks.values()].map((park) => ({
    callId: park.callId,
    itemId: park.itemId,
    name: park.name,
    arguments: park.arguments,
  }));
}

function itemIdFor(supervisor: RunSupervisor, callId: string): string {
  const existing = supervisor.itemIds.get(callId);
  if (existing) return existing;
  const id = newId("fc_");
  supervisor.itemIds.set(callId, id);
  return id;
}

function stringifyArgs(args: unknown): string {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

function newSupervisorState(): Pick<
  RunSupervisor,
  "parks" | "itemIds" | "outputText" | "reasoningText" | "waitSettled"
> {
  return {
    parks: new Map(),
    itemIds: new Map(),
    outputText: "",
    reasoningText: "",
    waitSettled: false,
  };
}

export function wrapCustomTools(
  defs: readonly FunctionToolDef[],
  supervisor: RunSupervisor,
): CustomToolsMap {
  const tools: CustomToolsMap = {};
  for (const def of defs) {
    tools[def.name] = {
      description: def.description,
      inputSchema: def.parameters,
      execute: (args, context) =>
        new Promise<string>((resolve, reject) => {
          const callId = context.toolCallId || newId("call_");
          const parked: ParkedExecute = {
            callId,
            itemId: itemIdFor(supervisor, callId),
            name: def.name,
            arguments: stringifyArgs(args),
            resolve,
            reject,
          };
          supervisor.parks.set(callId, parked);
          supervisor.onPark?.();
          // Notify the listener right here, synchronously with park
          // creation, instead of relying on the SDK's raw "tool_call"
          // stream event to arrive at a predictable time relative to this
          // execute() call -- it doesn't (see attachRun() below). This is
          // also the only place with guaranteed-correct, guaranteed-
          // complete data: the SDK invokes execute() with the real,
          // already-resolved tool name and arguments.
          if (supervisor.listener) {
            Promise.resolve(
              supervisor.listener({
                type: "tool_call",
                callId: parked.callId,
                name: parked.name,
                arguments: parked.arguments,
              }),
            ).catch(() => undefined);
          }
        }),
    };
  }
  return tools;
}

function attachRun(supervisor: RunSupervisor, run: RunHandle): void {
  supervisor.run = run;
  supervisor.streamDone = (async () => {
    if (!run.supports("stream")) return;
    for await (const event of run.stream()) {
      // tool_call SDK stream events are intentionally ignored here. Every
      // MCP-routed call (i.e. every client-declared customTool call)
      // reports name:"mcp" and a wire-level {providerIdentifier, toolName,
      // args} envelope on this event, not the resolved tool -- and there's
      // no reliable guarantee about when it arrives relative to
      // wrapCustomTools()'s execute() call, which is what actually creates
      // the park with the correct data and notifies the listener (see
      // wrapCustomTools() above). Trusting this event for that notification
      // caused tool_call SSE deltas to go missing entirely whenever the SDK
      // emitted it before calling execute() -- the client would see the
      // model announce a tool call in text, then nothing, with the turn
      // still ending in finish_reason:"tool_calls".
      if (event.type === "thinking") {
        supervisor.reasoningText += event.text;
        if (supervisor.listener) await supervisor.listener(event);
        continue;
      }
      if (event.type !== "text") continue;
      supervisor.outputText += event.text;
      if (supervisor.listener) await supervisor.listener(event);
    }
  })();
  supervisor.waitDone = run.wait().finally(() => {
    supervisor.waitSettled = true;
  });
}

function waitForParkIdle(supervisor: RunSupervisor): Promise<"parked"> {
  return new Promise((resolve) => {
    const arm = () => {
      if (supervisor.parks.size === 0) return;
      if (supervisor.idleTimer) clearTimeout(supervisor.idleTimer);
      supervisor.idleTimer = setTimeout(() => resolve("parked"), PARK_IDLE_MS);
    };
    supervisor.onPark = arm;
    arm();
  });
}

function applyOutcome(
  record: SessionRecord,
  outcome: RunOutcome,
  text: string,
): void {
  record.outputText = outcome.result ?? text;
  record.usage = outcome.usage;
  if (outcome.status === "cancelled") {
    record.status = "cancelled";
    record.error = undefined;
  } else if (outcome.status === "error") {
    record.status = "failed";
    record.error = outcome.error ?? { message: "Agent run failed" };
  } else {
    record.status = "completed";
    record.error = undefined;
  }
}

function finishSupervisor(record: SessionRecord): void {
  const supervisor = record.supervisor;
  if (supervisor?.idleTimer) clearTimeout(supervisor.idleTimer);
  if (supervisor) supervisor.onPark = undefined;
  record.supervisor = undefined;
  record.activeRun = undefined;
  record.pendingToolCalls = [];
}

async function collectTurn(
  record: SessionRecord,
  onEvent: RunListener | undefined,
  resetText: boolean,
): Promise<TurnResult> {
  const supervisor = record.supervisor;
  if (!supervisor) {
    throw new HttpError(500, "No active run supervisor", {
      type: "internal_error",
      code: "internal",
    });
  }
  if (resetText) {
    record.outputText = "";
    supervisor.outputText = "";
    record.reasoningText = "";
    supervisor.reasoningText = "";
  }
  supervisor.listener = onEvent;
  record.status = "in_progress";
  record.error = undefined;

  const parked = await Promise.race([
    waitForParkIdle(supervisor),
    supervisor.waitDone.then(() => "done" as const),
  ]);

  if (supervisor.idleTimer) clearTimeout(supervisor.idleTimer);

  if (
    parked === "parked" &&
    supervisor.parks.size > 0 &&
    !supervisor.waitSettled
  ) {
    record.status = "requires_action";
    record.outputText = supervisor.outputText;
    record.reasoningText = supervisor.reasoningText;
    record.pendingToolCalls = publicCalls(supervisor.parks);
    // PARK_IDLE_MS is a heuristic, not an authoritative "turn done" signal
    // from the SDK: wrapCustomTools().execute() keeps parking new calls into
    // supervisor.parks regardless of onPark, so a tool_call dispatched more
    // than PARK_IDLE_MS after the first one would otherwise be added to a
    // live map that record.pendingToolCalls (the only client-visible view of
    // it) never re-synced with -- permanently wedging the session, since
    // resumeParked() requires an output for every parked call_id including
    // ones the client was never told about. Keep onPark live for as long as
    // the record sits in requires_action so a late park is reflected on the
    // next status check instead of being invisible forever.
    supervisor.onPark = () => {
      record.pendingToolCalls = publicCalls(supervisor.parks);
    };
    supervisor.listener = undefined;
    return {
      status: "requires_action",
      text: record.outputText,
      reasoningText: record.reasoningText,
      toolCalls: record.pendingToolCalls,
    };
  }

  supervisor.onPark = undefined;
  const outcome = await supervisor.waitDone;
  await supervisor.streamDone.catch(() => undefined);
  if (supervisor.parks.size > 0) {
    // The run reached a terminal outcome (finished/errored/cancelled by the
    // SDK itself) while a customTools.execute() call was still parked
    // awaiting resumeParked(). Unlike cancelRun(), which explicitly rejects
    // every parked promise, this path used to just drop record.supervisor
    // and leave those execute() promises unsettled forever -- a leaked
    // promise, and whatever inside the SDK/tool machinery was awaiting it
    // would hang indefinitely.
    const abandoned = new Error(
      "run finished while a tool call was still parked",
    );
    for (const park of supervisor.parks.values()) {
      park.reject(abandoned);
    }
    supervisor.parks.clear();
  }
  applyOutcome(record, outcome, supervisor.outputText);
  record.reasoningText = supervisor.reasoningText;
  supervisor.listener = undefined;
  const stored = record.stored;
  const agent = record.agent;
  finishSupervisor(record);
  if (!stored) await agent.close().catch(() => undefined);
  return {
    status: record.status,
    text: record.outputText,
    reasoningText: record.reasoningText,
    toolCalls: [],
  };
}

function createPendingSupervisor(): RunSupervisor {
  const state = newSupervisorState();
  return {
    ...state,
    run: undefined as unknown as RunHandle,
    streamDone: Promise.resolve(),
    waitDone: Promise.resolve({ status: "finished" }),
  };
}

export async function runSession(
  record: SessionRecord,
  prompt: string,
  options: {
    tools?: readonly FunctionToolDef[];
    onEvent?: RunListener;
  } = {},
): Promise<TurnResult> {
  await record.mutex.acquire();
  let released = false;
  try {
    if (record.status === "requires_action") {
      throw new HttpError(409, "Session is waiting for tool outputs", {
        code: "requires_action",
      });
    }
    const supervisor = createPendingSupervisor();
    const customTools =
      options.tools && options.tools.length > 0
        ? wrapCustomTools(options.tools, supervisor)
        : undefined;
    const run = await record.agent.send(prompt, { customTools });
    supervisor.listener = options.onEvent;
    // Assign record.supervisor/activeRun *before* attachRun(): a
    // customTools.execute() call can now fire the listener synchronously
    // (see wrapCustomTools() above), and attachRun() can trigger that
    // synchronously too (starting the run's stream can synchronously drive
    // the underlying agent all the way through its first tool call). Any
    // listener that reads record.supervisor (e.g. the Responses SSE
    // handler's itemId lookup) needs it set before that can happen.
    record.supervisor = supervisor;
    record.activeRun = run;
    attachRun(supervisor, run);
    const result = await collectTurn(record, options.onEvent, false);
    if (result.status === "requires_action") {
      record.mutex.release();
      released = true;
    }
    return result;
  } finally {
    if (!released) record.mutex.release();
  }
}

export async function resumeParked(
  record: SessionRecord,
  outputs: readonly FunctionCallOutput[],
  onEvent?: RunListener,
): Promise<TurnResult> {
  await record.mutex.acquire();
  let released = false;
  try {
    if (record.status !== "requires_action" || !record.supervisor) {
      throw new HttpError(409, "Session is not waiting for tool outputs", {
        code: "requires_action",
      });
    }
    const supervisor = record.supervisor;
    for (const output of outputs) {
      if (!supervisor.parks.has(output.callId)) {
        throw new HttpError(400, `Unknown call_id: ${output.callId}`);
      }
    }
    // Outputs need not cover every currently parked call_id: a call parked
    // more than PARK_IDLE_MS after the first one (see collectTurn() below)
    // arrives after the client was already told about the earlier one, so it
    // has no way to answer it in the same round. Resolve whatever was
    // submitted and let collectTurn() re-report anything still outstanding
    // instead of erroring -- the client converges by answering what it's
    // told about, one round-trip at a time.
    record.status = "in_progress";
    record.pendingToolCalls = [];
    record.outputText = "";
    supervisor.outputText = "";
    record.reasoningText = "";
    supervisor.reasoningText = "";
    supervisor.listener = onEvent;
    for (const output of outputs) {
      const park = supervisor.parks.get(output.callId);
      if (!park) continue;
      park.resolve(output.output);
      supervisor.parks.delete(output.callId);
    }
    const result = await collectTurn(record, onEvent, false);
    if (result.status === "requires_action") {
      record.mutex.release();
      released = true;
    }
    return result;
  } finally {
    if (!released) record.mutex.release();
  }
}

export async function cancelRun(record: SessionRecord): Promise<void> {
  const supervisor = record.supervisor;
  const run = record.activeRun;
  if (!run) {
    throw new HttpError(409, "Response is not in progress", {
      code: "already_terminal",
    });
  }
  if (!run.supports("cancel")) {
    throw new HttpError(400, "Cancel is not supported for this run", {
      code: "unsupported",
    });
  }
  const blocked = new Error("cancelled");
  if (supervisor) {
    for (const park of supervisor.parks.values()) {
      park.reject(blocked);
    }
    supervisor.parks.clear();
  }
  await run.cancel();
  record.status = "cancelled";
  record.error = undefined;
  record.pendingToolCalls = [];
  finishSupervisor(record);
}
