import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ProxyConfig } from "./config.ts";
import {
  chatDeltaChunk,
  chatFinishChunk,
  chatRoleChunk,
  chatToolCallChunk,
  chatUsageChunk,
} from "./codec/chatSse.ts";
import {
  responseFunctionCallArgumentsDeltaEvent,
  responseOutputTextDeltaEvent,
} from "./codec/responsesSse.ts";
import { writeDone, writeJsonSse } from "./codec/sse.ts";
import type { CursorBackend, StreamEvent } from "./cursor/backend.ts";
import { authenticate } from "./http/auth.ts";
import { HttpError, notImplemented, openaiErrorBody } from "./http/errors.ts";
import { ChatCompletionRequest, ResponsesRequest } from "./http/schemas.ts";
import { decodeJson } from "./http/validate.ts";
import { newId, nowSeconds } from "./ids.ts";
import {
  DEFAULT_MODEL,
  flattenCatalog,
  flattenModelInfo,
  flattenResponsesInput,
  logIgnoredSampling,
  parseFunctionTools,
  rejectLogprobs,
  requireSingleChoice,
  toChatCompletion,
  toResponseObject,
  toUsage,
  type FunctionToolDef,
} from "./mapping.ts";
import {
  aliasPrefixSession,
  cancelRun,
  lookupOwnedOr404,
  resolveChatSession,
  resolveResponseSession,
  resumeParked,
  runSession,
  SessionRegistry,
  type SessionRecord,
} from "./session/orchestrate.ts";
import type { RunListener, TurnResult } from "./session/supervisor.ts";

type Variables = {
  callerKeyHash: string;
  cursorApiKey: string;
};

function modelId(value: string | undefined): string {
  return value?.trim() || DEFAULT_MODEL;
}

function prepareGeneration(
  body: {
    model?: string;
    n?: number;
    logprobs?: unknown;
  },
  options: { n?: boolean } = {},
): string {
  logIgnoredSampling(body);
  if (options.n) requireSingleChoice(body.n);
  rejectLogprobs(body);
  return modelId(body.model);
}

function responseFromRecord(
  record: SessionRecord,
  extra?: { id?: string; text?: string; status?: string; createdAt?: number },
) {
  const status = extra?.status ?? record.status;
  return toResponseObject({
    id: extra?.id ?? record.id,
    model: record.model,
    text: extra?.text ?? record.outputText,
    status,
    previousResponseId: record.previousResponseId,
    createdAt: extra?.createdAt ?? record.createdAt,
    usage: record.usage,
    error: extra?.status === "in_progress" ? undefined : record.error,
    toolCalls: status === "requires_action" ? record.pendingToolCalls : undefined,
  });
}

function chatRunError(record: SessionRecord): HttpError | undefined {
  if (record.status !== "failed") return undefined;
  return new HttpError(500, record.error?.message ?? "Agent run failed", {
    type: "internal_error",
    code: record.error?.code ?? "run_failed",
  });
}

async function executeTurn(
  record: SessionRecord,
  prompt: string,
  resume: { outputs: { callId: string; output: string }[] } | undefined,
  tools: FunctionToolDef[] | undefined,
  onEvent?: RunListener,
): Promise<TurnResult> {
  if (resume) return resumeParked(record, resume.outputs, onEvent);
  return runSession(record, prompt, { tools, onEvent });
}

function toolCallStreamer(): {
  onEvent: (event: StreamEvent) => {
    kind: "text" | "tool_call";
    text?: string;
    callId?: string;
    itemId?: string;
    name?: string;
    argumentsDelta?: string;
    index?: number;
  } | undefined;
} {
  const seen = new Map<string, { index: number; args: string; itemId: string }>();
  return {
    onEvent(event) {
      if (event.type === "text") return { kind: "text", text: event.text };
      let state = seen.get(event.callId);
      const isNew = !state;
      if (!state) {
        state = {
          index: seen.size,
          args: "",
          itemId: event.callId,
        };
        seen.set(event.callId, state);
      }
      const prev = state.args;
      const next = event.arguments;
      let argumentsDelta: string | undefined;
      if (next.startsWith(prev) && next.length > prev.length) {
        argumentsDelta = next.slice(prev.length);
      } else if (next !== prev) {
        argumentsDelta = next;
      }
      state.args = next;
      return {
        kind: "tool_call",
        callId: event.callId,
        itemId: state.itemId,
        name: isNew ? event.name : undefined,
        argumentsDelta,
        index: state.index,
      };
    },
  };
}

export function createApp(config: ProxyConfig, backend: CursorBackend) {
  const registry = new SessionRegistry();
  const app = new Hono<{ Variables: Variables }>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(openaiErrorBody(err), err.status as never);
    }
    const message = err instanceof Error ? err.message : "Internal error";
    return c.json(
      openaiErrorBody(
        new HttpError(500, message, {
          type: "internal_error",
          code: "internal",
        }),
      ),
      500,
    );
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      runtime: "local",
      session_mode: config.sessionMode,
      auth_mode: config.auth.mode,
    }),
  );

  app.use("/v1/*", async (c, next) => {
    const auth = authenticate(c.req.header("authorization"), config.auth);
    c.set("callerKeyHash", auth.callerKeyHash);
    c.set("cursorApiKey", auth.cursorApiKey);
    await next();
  });

  app.get("/v1/models", async (c) => {
    const catalog = await backend.listModels(c.get("cursorApiKey"));
    return c.json(flattenCatalog(catalog));
  });

  app.get("/v1/models/:id", async (c) => {
    const id = c.req.param("id");
    const catalog = await backend.listModels(c.get("cursorApiKey"));
    const listed = flattenCatalog(catalog).data.find((model) => model.id === id);
    if (!listed) {
      throw new HttpError(404, `The model '${id}' does not exist`, {
        code: "model_not_found",
      });
    }
    return c.json(listed);
  });

  app.get("/v1/model/info", async (c) => {
    const catalog = await backend.listModels(c.get("cursorApiKey"));
    return c.json(flattenModelInfo(catalog));
  });

  app.post("/v1/embeddings", () => {
    throw notImplemented("Embeddings");
  });

  app.post("/v1/completions", () => {
    throw notImplemented("Completions");
  });

  app.post("/v1/chat/completions", async (c) => {
    const body = await decodeJson(c, ChatCompletionRequest);
    const model = prepareGeneration(body, { n: true });
    const tools = parseFunctionTools(body.tools);
    const callerKeyHash = c.get("callerKeyHash");
    const created = nowSeconds();
    const completionId = newId("chatcmpl_");
    const { record, prompt, resume } = await resolveChatSession({
      config,
      backend,
      registry,
      callerKeyHash,
      apiKey: c.get("cursorApiKey"),
      model,
      body,
      tools,
      headers: {
        cursorSessionId: c.req.header("x-cursor-session-id"),
        sessionId: c.req.header("x-session-id"),
      },
    });
    c.header("X-Cursor-Session-Id", record.id);

    if (body.stream) {
      return streamSSE(c, async (stream) => {
        await writeJsonSse(stream, chatRoleChunk(completionId, created, model));
        const tracker = toolCallStreamer();
        const result = await executeTurn(
          record,
          prompt,
          resume,
          tools,
          async (event) => {
            const mapped = tracker.onEvent(event);
            if (!mapped) return;
            if (mapped.kind === "text" && mapped.text) {
              await writeJsonSse(
                stream,
                chatDeltaChunk(completionId, created, model, mapped.text),
              );
              return;
            }
            if (mapped.kind === "tool_call") {
              if (mapped.name) {
                await writeJsonSse(
                  stream,
                  chatToolCallChunk(completionId, created, model, {
                    index: mapped.index ?? 0,
                    id: mapped.callId,
                    type: "function",
                    function: { name: mapped.name, arguments: "" },
                  }),
                );
              }
              if (mapped.argumentsDelta) {
                await writeJsonSse(
                  stream,
                  chatToolCallChunk(completionId, created, model, {
                    index: mapped.index ?? 0,
                    function: { arguments: mapped.argumentsDelta },
                  }),
                );
              }
            }
          },
        );
        const failed = chatRunError(record);
        if (failed) {
          await writeJsonSse(stream, openaiErrorBody(failed));
          await writeDone(stream);
          return;
        }
        const includeUsage = body.stream_options?.include_usage === true;
        if (result.status === "requires_action") {
          await writeJsonSse(
            stream,
            chatFinishChunk(completionId, created, model, "tool_calls"),
          );
          if (includeUsage) {
            await writeJsonSse(
              stream,
              chatUsageChunk(completionId, created, model, toUsage(record.usage)),
            );
          }
          await writeDone(stream);
          return;
        }
        aliasPrefixSession(
          config,
          registry,
          callerKeyHash,
          body,
          model,
          record,
          result.text,
        );
        await writeJsonSse(
          stream,
          chatFinishChunk(completionId, created, model, "stop"),
        );
        if (includeUsage) {
          await writeJsonSse(
            stream,
            chatUsageChunk(completionId, created, model, toUsage(record.usage)),
          );
        }
        await writeDone(stream);
      });
    }

    const result = await executeTurn(record, prompt, resume, tools);
    const failed = chatRunError(record);
    if (failed) throw failed;
    if (result.status !== "requires_action") {
      aliasPrefixSession(
        config,
        registry,
        callerKeyHash,
        body,
        model,
        record,
        result.text,
      );
    }
    return c.json(
      toChatCompletion({
        id: completionId,
        model,
        text: result.text,
        created,
        usage: record.usage,
        toolCalls:
          result.status === "requires_action" ? result.toolCalls : undefined,
      }),
    );
  });

  app.post("/v1/responses", async (c) => {
    const body = await decodeJson(c, ResponsesRequest);
    const model = prepareGeneration(body);
    const tools = parseFunctionTools(body.tools);
    const callerKeyHash = c.get("callerKeyHash");
    const store = body.store !== false;
    if (!store && tools && tools.length > 0) {
      throw new HttpError(
        400,
        "store:false cannot be combined with tools (tool outputs cannot be submitted)",
      );
    }
    const createdAt = nowSeconds();
    const responseId = newId("resp_");
    const inputText = flattenResponsesInput(body.input);
    const { record, prompt, resume } = await resolveResponseSession({
      config,
      backend,
      registry,
      callerKeyHash,
      apiKey: c.get("cursorApiKey"),
      model,
      body,
      responseId,
      inputText,
      store,
      tools,
      createdAt,
    });

    if (body.stream) {
      return streamSSE(c, async (stream) => {
        await writeJsonSse(
          stream,
          responseFromRecord(record, {
            id: responseId,
            text: "",
            status: "in_progress",
            createdAt,
          }),
          "response.created",
        );
        const tracker = toolCallStreamer();
        const result = await executeTurn(
          record,
          prompt,
          resume,
          tools,
          async (event) => {
            const mapped = tracker.onEvent(event);
            if (!mapped) return;
            if (mapped.kind === "text" && mapped.text) {
              const delta = responseOutputTextDeltaEvent({
                responseId,
                delta: mapped.text,
              });
              await writeJsonSse(stream, delta.data, delta.event);
              return;
            }
            if (mapped.kind === "tool_call" && mapped.argumentsDelta) {
              const itemId =
                record.supervisor?.itemIds.get(mapped.callId ?? "") ??
                mapped.callId ??
                responseId;
              const delta = responseFunctionCallArgumentsDeltaEvent({
                itemId,
                delta: mapped.argumentsDelta,
              });
              await writeJsonSse(stream, delta.data, delta.event);
            }
          },
        );
        const terminal =
          result.status === "requires_action"
            ? "response.requires_action"
            : "response.completed";
        await writeJsonSse(
          stream,
          responseFromRecord(record, {
            id: responseId,
            text: result.text,
            createdAt,
          }),
          terminal,
        );
      });
    }

    const result = await executeTurn(record, prompt, resume, tools);
    return c.json(
      responseFromRecord(record, {
        id: responseId,
        text: result.text,
        createdAt,
      }),
    );
  });

  app.get("/v1/responses/:response_id", (c) => {
    const record = lookupOwnedOr404(
      registry,
      c.get("callerKeyHash"),
      c.req.param("response_id"),
    );
    return c.json(responseFromRecord(record));
  });

  app.post("/v1/responses/:response_id/cancel", async (c) => {
    const record = lookupOwnedOr404(
      registry,
      c.get("callerKeyHash"),
      c.req.param("response_id"),
    );
    await cancelRun(record);
    return c.json(responseFromRecord(record));
  });

  return { app, registry };
}
