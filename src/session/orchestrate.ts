import type { ProxyConfig } from "../config.ts";
import type { CursorBackend } from "../cursor/backend.ts";
import { HttpError } from "../http/errors.ts";
import type {
  ChatCompletionRequest,
  ResponsesRequest,
} from "../http/schemas.ts";
import { newId, nowSeconds } from "../ids.ts";
import {
  extractFunctionCallOutputs,
  flattenMessages,
  lastUserText,
  modelParams,
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
  fast?: string;
  context?: string;
  thinking?: string;
  passThroughTools?: boolean;
}): Promise<SessionRecord> {
  // The catalog is always needed now, not just when `effort` is requested:
  // some models (composer-2/2.5, grok-4.5/4.6) resolve an unset `fast` param
  // to a value team admin policy blocks, so a safe default has to be applied
  // whenever a model's catalog entry exposes `fast` at all -- see
  // modelParams() / docs/dev/model-availability-map.md.
  const catalog = await opts.backend.listModels(opts.apiKey);
  const agent = await opts.backend.createAgent({
    apiKey: opts.apiKey,
    model: opts.model,
    workspace: opts.config.workspace,
    mode: opts.config.agentMode,
    params: modelParams(catalog, opts.model, {
      effort: opts.effort,
      fast: opts.fast,
      context: opts.context,
      thinking: opts.thinking,
    }),
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
  fast?: string;
  context?: string;
  thinking?: string;
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
  const fast = opts.body.fast;
  const context = opts.body.context;
  const thinking = opts.body.thinking;
  const toolOutputs = toolOutputsFromMessages(opts.body.messages);
  const passThrough = Boolean(opts.tools && opts.tools.length > 0);

  if (opts.config.sessionMode === "prefix" && passThrough) {
    throw new HttpError(
      400,
      "OpenAI tools require sticky sessions; prefix mode is not supported",
    );
  }

  if (toolOutputs.length > 0) {
    // Resuming a parked tool call relies exclusively on tool_call_id --
    // every OpenAI-compliant client is already required to echo it back on
    // its role:"tool" message, that's core protocol, not a proxy extension.
    // No session id (cursor_session_id / session_id / X-Cursor-Session-Id /
    // X-Session-Id) is consulted here at all, not even as a first-choice
    // fast path: a present-but-wrong id must not be able to hijack or block
    // the correct resume (see tests/tools.test.ts for the scenario this
    // guards against).
    const outputIds = new Set(toolOutputs.map((output) => output.callId));
    const existing = opts.registry.findByPendingCall(
      opts.callerKeyHash,
      outputIds,
    );
    if (existing) {
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
    // No live Run parked anywhere for this call_id: it was evicted, the
    // proxy restarted, or the id never existed. Degrade instead of
    // erroring, same as an unrecognized explicit session id already does
    // below: start a fresh agent and replay the whole conversation -- tool
    // calls and their results included (see mapping.ts flattenMessages).
    // dedupeInFlight() collapses two concurrent requests racing into this
    // same branch (e.g. a client retry landing before the first attempt's
    // agent creation resolves) onto one factory call, keyed by the exact
    // set of call_ids neither found a live match for -- without aliasing
    // the result as a durable handle the way getOrCreate() does, since this
    // key is a coincidental match on one retry, not a session id meant to
    // be reused.
    const fallbackKey = `${opts.callerKeyHash}:toolfallback:${[...outputIds].sort().join(",")}`;
    const record = await opts.registry.dedupeInFlight(fallbackKey, () =>
      createChatSession({
        backend: opts.backend,
        registry: opts.registry,
        config: opts.config,
        callerKeyHash: opts.callerKeyHash,
        apiKey: opts.apiKey,
        model: opts.model,
        effort,
        fast,
        context,
        thinking,
        passThroughTools: passThrough,
      }),
    );
    return { record, prompt: flattenMessages(opts.body.messages) };
  }

  // No tool outputs to resolve: an ordinary or continuing plain-text turn.
  // This is the only remaining path that reads a session id -- resuming a
  // live agent here is a pure efficiency/context optimization (skip
  // resending full history), not something with any standard-protocol
  // substitute, so it keeps using the proxy's own sticky-id/prefix-hash
  // mechanism.
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

  if (lookupId) {
    const existing = opts.registry.get(opts.callerKeyHash, lookupId);
    if (existing) {
      if (existing.status === "requires_action") {
        // toolOutputs is empty (handled above), so this can only be a new
        // message arriving while a tool call is still parked.
        throw new HttpError(409, "Session is waiting for tool outputs", {
          code: "requires_action",
        });
      }
      return { record: existing, prompt: lastUserText(opts.body.messages) };
    }

    // No session exists yet under this id. getOrCreate() dedupes concurrent
    // requests racing to create it: only the first caller's factory actually
    // runs; later callers (in flight before it resolves) share its result
    // instead of each spinning up their own Cursor agent under the same id.
    const record = await opts.registry.getOrCreate(
      opts.callerKeyHash,
      lookupId,
      () =>
        createAgentRecord({
          backend: opts.backend,
          config: opts.config,
          callerKeyHash: opts.callerKeyHash,
          apiKey: opts.apiKey,
          model: opts.model,
          id: opts.config.sessionMode === "sticky" ? lookupId : newId("sess_"),
          stored: true,
          effort,
          fast,
          context,
          thinking,
          passThroughTools: passThrough,
        }),
    );
    return { record, prompt: flattenMessages(opts.body.messages) };
  }

  const record = await createChatSession({
    backend: opts.backend,
    registry: opts.registry,
    config: opts.config,
    callerKeyHash: opts.callerKeyHash,
    apiKey: opts.apiKey,
    model: opts.model,
    effort,
    fast,
    context,
    thinking,
    passThroughTools: passThrough,
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
  const fast = opts.body.fast;
  const context = opts.body.context;
  const thinking = opts.body.thinking;
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
    fast,
    context,
    thinking,
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
