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
  "parks" | "itemIds" | "outputText" | "waitSettled"
> {
  return {
    parks: new Map(),
    itemIds: new Map(),
    outputText: "",
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
      if (event.type === "text") {
        supervisor.outputText += event.text;
      } else if (event.type === "tool_call") {
        itemIdFor(supervisor, event.callId);
        const park = supervisor.parks.get(event.callId);
        if (park && event.arguments) park.arguments = event.arguments;
      }
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
  }
  supervisor.listener = onEvent;
  record.status = "in_progress";
  record.error = undefined;

  const parked = await Promise.race([
    waitForParkIdle(supervisor),
    supervisor.waitDone.then(() => "done" as const),
  ]);

  if (supervisor.idleTimer) clearTimeout(supervisor.idleTimer);
  supervisor.onPark = undefined;

  if (
    parked === "parked" &&
    supervisor.parks.size > 0 &&
    !supervisor.waitSettled
  ) {
    record.status = "requires_action";
    record.outputText = supervisor.outputText;
    record.pendingToolCalls = publicCalls(supervisor.parks);
    supervisor.listener = undefined;
    return {
      status: "requires_action",
      text: record.outputText,
      toolCalls: record.pendingToolCalls,
    };
  }

  const outcome = await supervisor.waitDone;
  await supervisor.streamDone.catch(() => undefined);
  applyOutcome(record, outcome, supervisor.outputText);
  supervisor.listener = undefined;
  const stored = record.stored;
  const agent = record.agent;
  finishSupervisor(record);
  if (!stored) await agent.close().catch(() => undefined);
  return {
    status: record.status,
    text: record.outputText,
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
    attachRun(supervisor, run);
    record.supervisor = supervisor;
    record.activeRun = run;
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
    for (const callId of supervisor.parks.keys()) {
      if (!outputs.some((output) => output.callId === callId)) {
        throw new HttpError(400, `Missing tool output for call_id: ${callId}`);
      }
    }
    record.status = "in_progress";
    record.pendingToolCalls = [];
    record.outputText = "";
    supervisor.outputText = "";
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
