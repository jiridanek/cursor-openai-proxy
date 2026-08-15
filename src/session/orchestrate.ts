import type { ProxyConfig } from "../config.ts";
import type { CursorBackend } from "../cursor/backend.ts";
import { HttpError } from "../http/errors.ts";
import type {
  ChatCompletionRequest,
  ResponsesRequest,
} from "../http/schemas.ts";
import { newId, nowSeconds } from "../ids.ts";
import {
  effortParams,
  extractFunctionCallOutputs,
  flattenMessages,
  lastUserText,
  nextPrefixSessionId,
  prefixSessionId,
  sdkToolAllowlist,
  toolOutputsFromMessages,
  type FunctionCallOutput,
  type FunctionToolDef,
} from "../mapping.ts";
import {
  Mutex,
  SessionRegistry,
  type SessionRecord,
} from "./registry.ts";
import {
  cancelRun,
  resumeParked,
  runSession,
} from "./supervisor.ts";

export { SessionRegistry, type SessionRecord };
export { cancelRun, resumeParked, runSession };

export type ResolvedTurn = {
  record: SessionRecord;
  prompt: string;
  resume?: { outputs: FunctionCallOutput[] };
};

async function createAgentRecord(opts: {
  backend: CursorBackend;
  config: ProxyConfig;
  callerKeyHash: string;
  apiKey: string;
  model: string;
  id: string;
  stored: boolean;
  previousResponseId?: string | null;
  effort?: string;
  passThroughTools?: boolean;
}): Promise<SessionRecord> {
  const catalog = opts.effort
    ? await opts.backend.listModels(opts.apiKey)
    : [];
  const agent = await opts.backend.createAgent({
    apiKey: opts.apiKey,
    model: opts.model,
    workspace: opts.config.workspace,
    mode: opts.config.agentMode,
    params: effortParams(catalog, opts.model, opts.effort),
    tools: sdkToolAllowlist(
      opts.config.agentMode,
      Boolean(opts.passThroughTools),
    ),
  });
  return {
    id: opts.id,
    callerKeyHash: opts.callerKeyHash,
    agent,
    mutex: new Mutex(),
    outputText: "",
    status: "in_progress",
    model: opts.model,
    createdAt: nowSeconds(),
    previousResponseId: opts.previousResponseId ?? null,
    stored: opts.stored,
  };
}

export async function createChatSession(opts: {
  backend: CursorBackend;
  registry: SessionRegistry;
  config: ProxyConfig;
  callerKeyHash: string;
  apiKey: string;
  model: string;
  id?: string;
  effort?: string;
  passThroughTools?: boolean;
}): Promise<SessionRecord> {
  const record = await createAgentRecord({
    ...opts,
    id: opts.id ?? newId("sess_"),
    stored: true,
  });
  opts.registry.set(record);
  return record;
}

export async function resolveChatSession(opts: {
  config: ProxyConfig;
  backend: CursorBackend;
  registry: SessionRegistry;
  callerKeyHash: string;
  apiKey: string;
  model: string;
  body: ChatCompletionRequest;
  headers: { cursorSessionId?: string; sessionId?: string };
  tools?: readonly FunctionToolDef[];
}): Promise<ResolvedTurn> {
  const stickyId =
    opts.body.cursor_session_id ??
    opts.body.session_id ??
    opts.headers.cursorSessionId ??
    opts.headers.sessionId;
  const effort = opts.body.reasoning_effort;
  const toolOutputs = toolOutputsFromMessages(opts.body.messages);
  const passThrough = Boolean(opts.tools && opts.tools.length > 0);

  if (opts.config.sessionMode === "prefix" && passThrough) {
    throw new HttpError(
      400,
      "OpenAI tools require sticky sessions; prefix mode is not supported",
    );
  }

  const lookupId =
    opts.config.sessionMode === "prefix"
      ? opts.body.messages.length > 1
        ? prefixSessionId(
            opts.body.messages,
            opts.model,
            opts.config.workspace,
          )
        : undefined
      : stickyId;

  if (toolOutputs.length > 0 && !lookupId) {
    throw new HttpError(
      400,
      "Tool follow-ups require X-Cursor-Session-Id or session_id",
    );
  }

  if (lookupId) {
    const existing = opts.registry.get(opts.callerKeyHash, lookupId);
    if (existing) {
      if (existing.status === "requires_action") {
        const pendingIds = new Set(
          (existing.pendingToolCalls ?? []).map((call) => call.callId),
        );
        const relevantOutputs = toolOutputs.filter((output) =>
          pendingIds.has(output.callId),
        );
        if (relevantOutputs.length === 0) {
          throw new HttpError(409, "Session is waiting for tool outputs", {
            code: "requires_action",
          });
        }
        return {
          record: existing,
          prompt: "",
          resume: { outputs: relevantOutputs },
        };
      }
      return { record: existing, prompt: lastUserText(opts.body.messages) };
    }
  }

  const record = await createChatSession({
    backend: opts.backend,
    registry: opts.registry,
    config: opts.config,
    callerKeyHash: opts.callerKeyHash,
    apiKey: opts.apiKey,
    model: opts.model,
    effort,
    passThroughTools: passThrough,
    id: opts.config.sessionMode === "sticky" ? stickyId : undefined,
  });
  return { record, prompt: flattenMessages(opts.body.messages) };
}

export function aliasPrefixSession(
  config: ProxyConfig,
  registry: SessionRegistry,
  callerKeyHash: string,
  body: ChatCompletionRequest,
  model: string,
  record: SessionRecord,
  text: string,
): void {
  if (config.sessionMode !== "prefix") return;
  const nextId = nextPrefixSessionId(
    body.messages,
    text,
    model,
    config.workspace,
  );
  registry.alias(callerKeyHash, nextId, record);
}

export async function resolveResponseSession(opts: {
  config: ProxyConfig;
  backend: CursorBackend;
  registry: SessionRegistry;
  callerKeyHash: string;
  apiKey: string;
  model: string;
  body: ResponsesRequest;
  responseId: string;
  inputText: string;
  store: boolean;
  tools?: readonly FunctionToolDef[];
  createdAt: number;
}): Promise<ResolvedTurn> {
  const effort = opts.body.reasoning_effort ?? opts.body.reasoning?.effort;
  const outputs = extractFunctionCallOutputs(opts.body.input);
  const passThrough = Boolean(opts.tools && opts.tools.length > 0);

  if (opts.body.previous_response_id) {
    const existing = opts.registry.get(
      opts.callerKeyHash,
      opts.body.previous_response_id,
    );
    if (!existing) {
      if (opts.registry.existsUnderAnyCaller(opts.body.previous_response_id)) {
        throw new HttpError(
          404,
          `Unknown response: ${opts.body.previous_response_id}`,
          { code: "not_found" },
        );
      }
      throw new HttpError(
        400,
        `Unknown previous_response_id: ${opts.body.previous_response_id}`,
      );
    }

    if (existing.status === "requires_action") {
      if (outputs.length === 0) {
        throw new HttpError(409, "Response is waiting for tool outputs", {
          code: "requires_action",
        });
      }
      if (opts.inputText.trim()) {
        throw new HttpError(409, "Response is waiting for tool outputs", {
          code: "requires_action",
        });
      }
      const followUp: SessionRecord = {
        ...existing,
        id: opts.responseId,
        previousResponseId: opts.body.previous_response_id,
        createdAt: opts.createdAt,
        stored: opts.store,
        usage: undefined,
        error: undefined,
      };
      if (opts.store) opts.registry.set(followUp);
      return { record: followUp, prompt: "", resume: { outputs } };
    }

    const followUp: SessionRecord = {
      ...existing,
      id: opts.responseId,
      previousResponseId: opts.body.previous_response_id,
      status: "in_progress",
      outputText: "",
      usage: undefined,
      error: undefined,
      createdAt: opts.createdAt,
      stored: opts.store,
      activeRun: undefined,
      supervisor: undefined,
      pendingToolCalls: undefined,
    };
    if (opts.store) opts.registry.set(followUp);
    return { record: followUp, prompt: opts.inputText };
  }

  const record = await createAgentRecord({
    backend: opts.backend,
    config: opts.config,
    callerKeyHash: opts.callerKeyHash,
    apiKey: opts.apiKey,
    model: opts.model,
    id: opts.responseId,
    stored: opts.store,
    previousResponseId: null,
    effort,
    passThroughTools: passThrough,
  });
  record.createdAt = opts.createdAt;
  if (opts.store) opts.registry.set(record);
  return {
    record,
    prompt: opts.body.instructions
      ? `system: ${opts.body.instructions}\n${opts.inputText}`
      : opts.inputText,
  };
}

export function lookupOwnedOr404(
  registry: SessionRegistry,
  callerKeyHash: string,
  id: string,
): SessionRecord {
  const record = registry.get(callerKeyHash, id);
  if (!record) {
    throw new HttpError(404, `Unknown response: ${id}`, { code: "not_found" });
  }
  return record;
}
