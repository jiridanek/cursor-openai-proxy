import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ProxyConfig } from "./config.ts";
import {
  chatDeltaChunk,
  chatRoleChunk,
  chatStopChunk,
  completionsDeltaChunk,
  completionsStopChunk,
} from "./codec/chatSse.ts";
import { responseOutputTextDeltaEvent } from "./codec/responsesSse.ts";
import { writeDone, writeJsonSse } from "./codec/sse.ts";
import type { CursorBackend } from "./cursor/backend.ts";
import { authenticate } from "./http/auth.ts";
import { HttpError, notImplemented, openaiErrorBody } from "./http/errors.ts";
import {
  ChatCompletionRequest,
  CompletionsRequest,
  ResponsesRequest,
} from "./http/schemas.ts";
import { decodeJson } from "./http/validate.ts";
import { newId, nowSeconds } from "./ids.ts";
import {
  DEFAULT_MODEL,
  flattenCatalog,
  flattenResponsesInput,
  logIgnoredSampling,
  rejectToolsAndLogprobs,
  requireSingleChoice,
  toChatCompletion,
  toResponseObject,
  toTextCompletion,
} from "./mapping.ts";
import {
  aliasPrefixSession,
  createChatSession,
  lookupOwnedOr404,
  resolveChatSession,
  resolveResponseSession,
  runSession,
  SessionRegistry,
  type SessionRecord,
} from "./session/orchestrate.ts";

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
    tools?: unknown;
    logprobs?: unknown;
  },
  options: { n?: boolean } = {},
): string {
  logIgnoredSampling(body);
  if (options.n) requireSingleChoice(body.n);
  rejectToolsAndLogprobs(body);
  return modelId(body.model);
}

function responseFromRecord(
  record: SessionRecord,
  extra?: { id?: string; text?: string; status?: string; createdAt?: number },
) {
  return toResponseObject({
    id: extra?.id ?? record.id,
    model: record.model,
    text: extra?.text ?? record.outputText,
    status: extra?.status ?? record.status,
    previousResponseId: record.previousResponseId,
    createdAt: extra?.createdAt ?? record.createdAt,
    usage: record.usage,
  });
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

  app.post("/v1/embeddings", () => {
    throw notImplemented("Embeddings");
  });

  app.post("/v1/chat/completions", async (c) => {
    const body = await decodeJson(c, ChatCompletionRequest);
    const model = prepareGeneration(body, { n: true });
    const callerKeyHash = c.get("callerKeyHash");
    const created = nowSeconds();
    const completionId = newId("chatcmpl_");
    const { record, prompt } = await resolveChatSession({
      config,
      backend,
      registry,
      callerKeyHash,
      apiKey: c.get("cursorApiKey"),
      model,
      body,
      headers: {
        cursorSessionId: c.req.header("x-cursor-session-id"),
        sessionId: c.req.header("x-session-id"),
      },
    });
    c.header("X-Cursor-Session-Id", record.id);

    if (body.stream) {
      return streamSSE(c, async (stream) => {
        await writeJsonSse(stream, chatRoleChunk(completionId, created, model));
        const text = await runSession(record, prompt, async (delta) => {
          await writeJsonSse(
            stream,
            chatDeltaChunk(completionId, created, model, delta),
          );
        });
        aliasPrefixSession(
          config,
          registry,
          callerKeyHash,
          body,
          model,
          record,
          text,
        );
        await writeJsonSse(stream, chatStopChunk(completionId, created, model));
        await writeDone(stream);
      });
    }

    const text = await runSession(record, prompt);
    aliasPrefixSession(
      config,
      registry,
      callerKeyHash,
      body,
      model,
      record,
      text,
    );
    return c.json(
      toChatCompletion({
        id: completionId,
        model,
        text,
        created,
        usage: record.usage,
      }),
    );
  });

  app.post("/v1/completions", async (c) => {
    const body = await decodeJson(c, CompletionsRequest);
    const model = prepareGeneration(body, { n: true });
    const prompt =
      typeof body.prompt === "string" ? body.prompt : body.prompt.join("");
    const created = nowSeconds();
    const completionId = newId("cmpl_");
    const record = await createChatSession({
      backend,
      registry,
      config,
      callerKeyHash: c.get("callerKeyHash"),
      apiKey: c.get("cursorApiKey"),
      model,
    });

    if (body.stream) {
      return streamSSE(c, async (stream) => {
        await runSession(record, prompt, async (delta) => {
          await writeJsonSse(
            stream,
            completionsDeltaChunk(completionId, created, model, delta),
          );
        });
        await writeJsonSse(
          stream,
          completionsStopChunk(completionId, created, model),
        );
        await writeDone(stream);
      });
    }

    const text = await runSession(record, prompt);
    return c.json(
      toTextCompletion({
        id: completionId,
        model,
        text,
        created,
        usage: record.usage,
      }),
    );
  });

  app.post("/v1/responses", async (c) => {
    const body = await decodeJson(c, ResponsesRequest);
    const model = prepareGeneration(body);
    const callerKeyHash = c.get("callerKeyHash");
    const store = body.store !== false;
    const createdAt = nowSeconds();
    const responseId = newId("resp_");
    const inputText = flattenResponsesInput(body.input);
    const { record, prompt } = await resolveResponseSession({
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
        const text = await runSession(record, prompt, async (delta) => {
          const event = responseOutputTextDeltaEvent({ responseId, delta });
          await writeJsonSse(stream, event.data, event.event);
        });
        await writeJsonSse(
          stream,
          responseFromRecord(record, { id: responseId, text, createdAt }),
          "response.completed",
        );
      });
    }

    const text = await runSession(record, prompt);
    return c.json(
      responseFromRecord(record, { id: responseId, text, createdAt }),
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
    if (!record.activeRun) {
      throw new HttpError(409, "Response is not in progress", {
        code: "already_terminal",
      });
    }
    if (!record.activeRun.supports("cancel")) {
      throw new HttpError(400, "Cancel is not supported for this run", {
        code: "unsupported",
      });
    }
    await record.activeRun.cancel();
    record.activeRun = undefined;
    record.status = "cancelled";
    return c.json(responseFromRecord(record));
  });

  return { app, registry };
}
