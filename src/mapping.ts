import { createHash } from "node:crypto";
import type { AgentMode } from "./config.ts";
import { HttpError, notImplemented } from "./http/errors.ts";
import type { ChatMessage } from "./http/schemas.ts";
import { newId, nowSeconds } from "./ids.ts";
import type { TokenUsage } from "./cursor/backend.ts";

export const DEFAULT_MODEL = "auto";

export type FunctionToolDef = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type FunctionCallOutput = {
  callId: string;
  output: string;
};

export type PendingToolCall = {
  callId: string;
  itemId: string;
  name: string;
  arguments: string;
};

const IGNORED_SAMPLING = [
  "temperature",
  "top_p",
  "seed",
  "max_tokens",
  "max_completion_tokens",
] as const;

export function logIgnoredSampling(body: object): void {
  if (!process.env.DEBUG) return;
  const rec = body as Record<string, unknown>;
  const present = IGNORED_SAMPLING.filter((key) => rec[key] !== undefined);
  if (present.length > 0) {
    console.debug(
      `cursor-openai-proxy: ignoring sampling knobs: ${present.join(", ")}`,
    );
  }
  if (rec.tool_choice !== undefined || rec.parallel_tool_calls !== undefined) {
    console.debug(
      "cursor-openai-proxy: ignoring tool_choice / parallel_tool_calls",
    );
  }
}

export function requireSingleChoice(n: number | undefined): void {
  if (n !== undefined && n !== 1) {
    throw new HttpError(400, "Only n=1 is supported");
  }
}

export function rejectLogprobs(body: { logprobs?: unknown }): void {
  if (body.logprobs !== undefined && Boolean(body.logprobs)) {
    throw notImplemented("logprobs");
  }
}

export function sdkToolAllowlist(
  mode: AgentMode,
  passThrough: boolean,
): string[] | undefined {
  if (passThrough) return ["mcp"];
  if (mode === "ask") return ["read", "grep", "glob", "ls"];
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function parseFunctionTools(
  tools: readonly unknown[] | undefined,
): FunctionToolDef[] | undefined {
  if (tools === undefined) return undefined;
  const defs: FunctionToolDef[] = [];
  for (const tool of tools) {
    const rec = asRecord(tool);
    if (!rec) {
      throw notImplemented("OpenAI tools");
    }
    if (rec.type !== "function") {
      throw notImplemented(
        `Tool type ${typeof rec.type === "string" ? rec.type : "unknown"}`,
      );
    }
    const fn = asRecord(rec.function);
    if (fn) {
      if (typeof fn.name !== "string" || !fn.name) {
        throw new HttpError(400, "Function tool is missing name");
      }
      defs.push({
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : undefined,
        parameters: asRecord(fn.parameters),
      });
      continue;
    }
    if (typeof rec.name === "string" && rec.name) {
      defs.push({
        name: rec.name,
        description: typeof rec.description === "string" ? rec.description : undefined,
        parameters: asRecord(rec.parameters),
      });
      continue;
    }
    throw new HttpError(400, "Function tool is missing name");
  }
  return defs;
}

export function toolOutputsFromMessages(
  messages: readonly ChatMessage[],
): FunctionCallOutput[] {
  // Only the *trailing* run of role:"tool" messages is a live follow-up.
  // OpenAI clients resend the full history on every request, so an older
  // tool exchange sitting earlier in `messages` is just history -- if the
  // client has since moved on to a new user/assistant turn, that trailing
  // message is what this request actually is, not a stale tool result.
  const outputs: FunctionCallOutput[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "tool") break;
    if (!message.tool_call_id) {
      throw new HttpError(400, "Tool message is missing tool_call_id");
    }
    outputs.unshift({
      callId: message.tool_call_id,
      output: flattenContent(message.content),
    });
  }
  return outputs;
}

export function extractFunctionCallOutputs(
  input: string | readonly unknown[],
): FunctionCallOutput[] {
  if (typeof input === "string") return [];
  const outputs: FunctionCallOutput[] = [];
  for (const item of input) {
    const rec = asRecord(item);
    if (!rec || rec.type !== "function_call_output") continue;
    if (typeof rec.call_id !== "string" || !rec.call_id) {
      throw new HttpError(400, "function_call_output is missing call_id");
    }
    outputs.push({
      callId: rec.call_id,
      output: typeof rec.output === "string" ? rec.output : stringifyOutput(rec.output),
    });
  }
  return outputs;
}

function stringifyOutput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isVisionPart(part: { type?: unknown; image_url?: unknown }): boolean {
  return (
    part.image_url !== undefined ||
    part.type === "image_url" ||
    part.type === "input_image"
  );
}

export function flattenContent(
  content:
    | string
    | ReadonlyArray<{ type?: string; text?: string; image_url?: unknown }>
    | null
    | undefined,
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const part of content) {
    if (isVisionPart(part)) {
      throw notImplemented("Vision / image inputs");
    }
    if (typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("");
}

function renderToolCall(call: unknown): string {
  const rec = asRecord(call);
  const fn = rec ? asRecord(rec.function) : undefined;
  const name =
    (fn && typeof fn.name === "string" && fn.name) ||
    (rec && typeof rec.name === "string" && rec.name) ||
    "unknown";
  const args =
    (fn && typeof fn.arguments === "string" && fn.arguments) ||
    (rec && typeof rec.arguments === "string" && rec.arguments) ||
    "{}";
  return `${name}(${args})`;
}

function flattenMessageLine(message: ChatMessage): string {
  if (message.role === "tool") {
    const label = message.tool_call_id ? ` [${message.tool_call_id}]` : "";
    return `tool${label}: ${flattenContent(message.content)}`;
  }
  const calls = message.tool_calls;
  if (message.role === "assistant" && calls && calls.length > 0) {
    const text = flattenContent(message.content);
    const rendered = calls.map(renderToolCall).join(", ");
    return text
      ? `assistant: ${text}\nassistant: [called ${rendered}]`
      : `assistant: [called ${rendered}]`;
  }
  return `${message.role}: ${flattenContent(message.content)}`;
}

export function flattenMessages(messages: readonly ChatMessage[]): string {
  return messages.map(flattenMessageLine).join("\n");
}

export function lastUserText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      return flattenContent(messages[i].content);
    }
  }
  return flattenMessages(messages);
}

export function flattenResponsesInput(
  input: string | readonly unknown[],
): string {
  if (typeof input === "string") return input;
  const parts: string[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") {
      throw notImplemented("Non-text input items");
    }
    const rec = item as Record<string, unknown>;
    if (isVisionPart(rec)) {
      throw notImplemented("Vision / image inputs");
    }
    const type = rec.type;
    if (type === "function_call_output") continue;
    if (type === "input_text" && typeof rec.text === "string") {
      parts.push(rec.text);
      continue;
    }
    if (type === "message" || typeof rec.role === "string") {
      parts.push(flattenContent(rec.content as ChatMessage["content"]));
      continue;
    }
    if (typeof rec.text === "string") {
      parts.push(rec.text);
      continue;
    }
    throw notImplemented(
      `Input item type ${typeof type === "string" ? type : "unknown"}`,
    );
  }
  return parts.join("\n");
}

function hashPrefix(prefix: unknown, model: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ prefix, model }))
    .digest("hex")
    .slice(0, 24);
  return `sess_${digest}`;
}

export function prefixSessionId(
  messages: readonly ChatMessage[],
  model: string,
): string {
  return hashPrefix(messages.slice(0, -1), model);
}

export function nextPrefixSessionId(
  messages: readonly ChatMessage[],
  assistantText: string,
  model: string,
): string {
  return hashPrefix(
    [...messages, { role: "assistant", content: assistantText }],
    model,
  );
}

export function toUsage(usage: TokenUsage | undefined): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  return {
    prompt_tokens: usage?.inputTokens ?? 0,
    completion_tokens: usage?.outputTokens ?? 0,
    total_tokens: usage?.totalTokens ?? 0,
  };
}

export function toResponseUsage(usage: TokenUsage | undefined): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    total_tokens: usage?.totalTokens ?? 0,
  };
}

export function toChatCompletion(opts: {
  id?: string;
  model: string;
  text: string;
  reasoningText?: string;
  usage?: TokenUsage;
  created?: number;
  toolCalls?: readonly PendingToolCall[];
}) {
  const reasoning = opts.reasoningText
    ? { reasoning_content: opts.reasoningText }
    : {};
  if (opts.toolCalls && opts.toolCalls.length > 0) {
    return {
      id: opts.id ?? newId("chatcmpl_"),
      object: "chat.completion" as const,
      created: opts.created ?? nowSeconds(),
      model: opts.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: null,
            ...reasoning,
            tool_calls: opts.toolCalls.map((call) => ({
              id: call.callId,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          },
          finish_reason: "tool_calls" as const,
        },
      ],
      usage: toUsage(opts.usage),
    };
  }
  return {
    id: opts.id ?? newId("chatcmpl_"),
    object: "chat.completion" as const,
    created: opts.created ?? nowSeconds(),
    model: opts.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: opts.text, ...reasoning },
        finish_reason: "stop" as const,
      },
    ],
    usage: toUsage(opts.usage),
  };
}

export function toResponseObject(opts: {
  id: string;
  model: string;
  text: string;
  reasoningText?: string;
  status: string;
  previousResponseId?: string | null;
  usage?: TokenUsage;
  createdAt?: number;
  error?: { message: string; code?: string };
  toolCalls?: readonly PendingToolCall[];
}) {
  const output: Array<Record<string, unknown>> = [];
  if (opts.reasoningText) {
    output.push({
      type: "reasoning" as const,
      id: newId("rs_"),
      summary: [{ type: "summary_text" as const, text: opts.reasoningText }],
    });
  }
  if (opts.text || !opts.toolCalls?.length) {
    output.push({
      type: "message" as const,
      id: newId("msg_"),
      role: "assistant" as const,
      status: opts.status === "requires_action" ? "completed" : opts.status,
      content: [{ type: "output_text" as const, text: opts.text }],
    });
  }
  for (const call of opts.toolCalls ?? []) {
    output.push({
      type: "function_call" as const,
      id: call.itemId,
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments,
      status: "completed",
    });
  }
  return {
    id: opts.id,
    object: "response" as const,
    status: opts.status,
    model: opts.model,
    created_at: opts.createdAt ?? nowSeconds(),
    previous_response_id: opts.previousResponseId ?? null,
    output,
    usage: toResponseUsage(opts.usage),
    ...(opts.error ? { error: opts.error } : {}),
  };
}

export type OpenAIModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: "cursor";
};

function dedupedCatalogEntries<T extends { id: string; aliases?: string[] }>(
  catalog: T[],
): Array<{ id: string; siblings: string[]; source: T }> {
  const seen = new Set<string>();
  const entries: Array<{ id: string; siblings: string[]; source: T }> = [];
  for (const model of catalog) {
    const names = [model.id, ...(model.aliases ?? [])];
    for (const id of names) {
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id,
        siblings: names.filter((name) => name !== id),
        source: model,
      });
    }
  }
  return entries;
}

export function flattenCatalog(
  catalog: Array<{ id: string; aliases?: string[] }>,
): { object: "list"; data: OpenAIModel[] } {
  const data = dedupedCatalogEntries(catalog).map(({ id }) => ({
    id,
    object: "model" as const,
    created: 0,
    owned_by: "cursor" as const,
  }));
  return { object: "list", data };
}

type ModelInfoCatalogEntry = {
  id: string;
  aliases?: string[];
  displayName?: string;
  description?: string;
  parameters?: Array<{ id: string; values: Array<{ value: string }> }>;
  variants?: Array<{
    params: Array<{ id: string; value: string }>;
    displayName: string;
    description?: string;
    isDefault?: boolean;
  }>;
};

export type ModelInfoEntry = {
  model_name: string;
  litellm_params: { model: string };
  model_info: {
    id: string;
    db_model: false;
    key: string;
    litellm_provider: "cursor";
    mode: "chat";
    display_name?: string;
    description?: string;
    aliases?: string[];
    parameters?: ModelInfoCatalogEntry["parameters"];
    variants?: ModelInfoCatalogEntry["variants"];
  };
};

export function flattenModelInfo(
  catalog: ModelInfoCatalogEntry[],
): { data: ModelInfoEntry[] } {
  const data = dedupedCatalogEntries(catalog).map(({ id, siblings, source }) => ({
    model_name: id,
    litellm_params: { model: id },
    model_info: {
      id,
      db_model: false as const,
      key: id,
      litellm_provider: "cursor" as const,
      mode: "chat" as const,
      ...(source.displayName ? { display_name: source.displayName } : {}),
      ...(source.description ? { description: source.description } : {}),
      ...(siblings.length > 0 ? { aliases: siblings } : {}),
      ...(source.parameters ? { parameters: source.parameters } : {}),
      ...(source.variants ? { variants: source.variants } : {}),
    },
  }));
  return { data };
}

type ModelCatalogEntry = {
  id: string;
  aliases?: string[];
  parameters?: Array<{ id: string; values: Array<{ value: string }> }>;
};

function findCatalogParam(
  catalog: ModelCatalogEntry[],
  modelId: string,
  paramIds: readonly string[],
): { id: string; values: Array<{ value: string }> } | undefined {
  const model = catalog.find(
    (item) => item.id === modelId || item.aliases?.includes(modelId),
  );
  return model?.parameters?.find((item) => paramIds.includes(item.id));
}

// Shared shell for effortParams()/fastParam()/contextParam()/thinkingParam()
// below: resolve the requested value (applying a default first, since
// fastParam's default must be applied *before* the falsy check -- see its
// comment), look up the matching catalog param, and validate the value is
// one the catalog actually advertises for this model.
function catalogParam(
  catalog: ModelCatalogEntry[],
  modelId: string,
  paramIds: readonly string[],
  requested: string | undefined,
  opts?: { default?: string },
): { id: string; value: string } | undefined {
  const value = requested ?? opts?.default;
  if (!value) return undefined;
  const param = findCatalogParam(catalog, modelId, paramIds);
  if (!param) return undefined;
  if (!param.values.some((v) => v.value === value)) return undefined;
  return { id: param.id, value };
}

export function effortParams(
  catalog: ModelCatalogEntry[],
  modelId: string,
  effort: string | undefined,
): Array<{ id: string; value: string }> | undefined {
  const param = catalogParam(catalog, modelId, ["effort", "reasoning_effort"], effort);
  return param ? [param] : undefined;
}

// Cursor's backend resolves an unset `fast` param to `true` for at least
// composer-2/composer-2.5/grok-4.5/grok-4.6 -- a value some team admin
// policies block outright ("Model Blocked"), even though the catalog's own
// `isDefault` variant for these models advertises `fast: false`. Default to
// `false` ourselves whenever a model's catalog entry exposes `fast` and the
// caller hasn't asked for a specific value, instead of inheriting whatever
// Cursor's backend silently falls back to. See docs/dev/model-availability-map.md.
export function fastParam(
  catalog: ModelCatalogEntry[],
  modelId: string,
  fast: string | undefined,
): { id: string; value: string } | undefined {
  return catalogParam(catalog, modelId, ["fast"], fast, { default: "false" });
}

// Unlike `fast`, neither `context` nor `thinking` has a known backend-side
// admin-block-on-unset issue (see docs/dev/model-availability-map.md), so
// these are opt-in only -- no default is applied when the caller doesn't ask
// for a specific value.
export function contextParam(
  catalog: ModelCatalogEntry[],
  modelId: string,
  context: string | undefined,
): { id: string; value: string } | undefined {
  return catalogParam(catalog, modelId, ["context"], context);
}

export function thinkingParam(
  catalog: ModelCatalogEntry[],
  modelId: string,
  thinking: string | undefined,
): { id: string; value: string } | undefined {
  return catalogParam(catalog, modelId, ["thinking"], thinking);
}

export function modelParams(
  catalog: ModelCatalogEntry[],
  modelId: string,
  opts: { effort?: string; fast?: string; context?: string; thinking?: string },
): Array<{ id: string; value: string }> | undefined {
  const fast = fastParam(catalog, modelId, opts.fast);
  const context = contextParam(catalog, modelId, opts.context);
  const thinking = thinkingParam(catalog, modelId, opts.thinking);
  const params = [
    ...(effortParams(catalog, modelId, opts.effort) ?? []),
    ...(fast ? [fast] : []),
    ...(context ? [context] : []),
    ...(thinking ? [thinking] : []),
  ];
  return params.length > 0 ? params : undefined;
}
