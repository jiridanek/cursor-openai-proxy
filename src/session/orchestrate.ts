import type { ProxyConfig } from "../config.ts";
import type { CursorBackend, RunHandle, RunOutcome } from "../cursor/backend.ts";
import { HttpError } from "../http/errors.ts";
import type {
  ChatCompletionRequest,
  ResponsesRequest,
} from "../http/schemas.ts";
import { newId, nowSeconds } from "../ids.ts";
import {
  effortParams,
  flattenMessages,
  lastUserText,
  nextPrefixSessionId,
  prefixSessionId,
  withInstructions,
} from "../mapping.ts";
import {
  Mutex,
  SessionRegistry,
  type SessionRecord,
} from "./registry.ts";

export { SessionRegistry, type SessionRecord };

async function createAgentRecord(opts: {
  backend: CursorBackend;
  config: ProxyConfig;
  callerKeyHash: string;
  apiKey: string;
  model: string;
  id: string;
  kind: "chat" | "response";
  stored: boolean;
  previousResponseId?: string | null;
  effort?: string;
}): Promise<SessionRecord> {
  const catalog = await opts.backend.listModels(opts.apiKey).catch(() => []);
  const agent = await opts.backend.createAgent({
    apiKey: opts.apiKey,
    model: opts.model,
    workspace: opts.config.workspace,
    mode: opts.config.agentMode,
    params: effortParams(catalog, opts.model, opts.effort),
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
    kind: opts.kind,
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
}): Promise<SessionRecord> {
  const record = await createAgentRecord({
    ...opts,
    id: opts.id ?? newId("sess_"),
    kind: "chat",
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
}): Promise<{ record: SessionRecord; prompt: string }> {
  const stickyId =
    opts.body.cursor_session_id ??
    opts.body.session_id ??
    opts.headers.cursorSessionId ??
    opts.headers.sessionId;
  const effort = opts.body.reasoning_effort;

  if (opts.config.sessionMode === "prefix") {
    const prefix = opts.body.messages.slice(0, -1);
    if (prefix.length > 0) {
      const id = prefixSessionId(
        opts.body.messages,
        opts.model,
        opts.config.workspace,
      );
      const existing = opts.registry.get(opts.callerKeyHash, id);
      if (existing) {
        return { record: existing, prompt: lastUserText(opts.body.messages) };
      }
    }
    const record = await createChatSession({ ...opts, effort });
    return { record, prompt: flattenMessages(opts.body.messages) };
  }

  if (stickyId) {
    const existing = opts.registry.get(opts.callerKeyHash, stickyId);
    if (existing) {
      return { record: existing, prompt: lastUserText(opts.body.messages) };
    }
    const record = await createChatSession({ ...opts, id: stickyId, effort });
    return { record, prompt: flattenMessages(opts.body.messages) };
  }

  const record = await createChatSession({ ...opts, effort });
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
  createdAt: number;
}): Promise<{ record: SessionRecord; prompt: string }> {
  const effort = opts.body.reasoning_effort ?? opts.body.reasoning?.effort;

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
    const followUp: SessionRecord = {
      ...existing,
      id: opts.responseId,
      previousResponseId: opts.body.previous_response_id,
      status: "in_progress",
      outputText: "",
      createdAt: opts.createdAt,
      kind: "response",
      stored: opts.store,
      activeRun: undefined,
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
    kind: "response",
    stored: opts.store,
    previousResponseId: null,
    effort,
  });
  record.createdAt = opts.createdAt;
  if (opts.store) opts.registry.set(record);
  return {
    record,
    prompt: withInstructions(opts.inputText, opts.body.instructions, true),
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

function applyOutcome(
  record: SessionRecord,
  outcome: RunOutcome,
  text: string,
): void {
  record.outputText = outcome.result ?? text;
  record.usage = outcome.usage;
  if (outcome.status === "cancelled") record.status = "cancelled";
  else if (outcome.status === "error") record.status = "failed";
  else record.status = "completed";
}

export async function runSession(
  record: SessionRecord,
  prompt: string,
  onDelta?: (delta: string) => Promise<void>,
): Promise<string> {
  return record.mutex.runExclusive(async () => {
    const run: RunHandle = await record.agent.send(prompt);
    record.activeRun = run;
    record.status = "in_progress";
    try {
      if (onDelta) {
        const chunks: string[] = [];
        for await (const delta of run.streamText()) {
          chunks.push(delta);
          record.outputText = chunks.join("");
          await onDelta(delta);
        }
        const outcome = await run.wait();
        applyOutcome(record, outcome, chunks.join(""));
      } else {
        const outcome = await run.wait();
        applyOutcome(record, outcome, outcome.result ?? "");
      }
      return record.outputText;
    } finally {
      record.activeRun = undefined;
      if (!record.stored) {
        await record.agent.close().catch(() => undefined);
      }
    }
  });
}
