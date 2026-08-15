import { createHash } from "node:crypto";
import { HttpError, notImplemented } from "./http/errors.ts";
import type { ChatMessage } from "./http/schemas.ts";
import { newId, nowSeconds } from "./ids.ts";
import type { TokenUsage } from "./cursor/backend.ts";

export const DEFAULT_MODEL = "composer-2.5";

const IGNORED_SAMPLING = [
  "temperature",
  "top_p",
  "seed",
  "max_tokens",
  "max_completion_tokens",
] as const;

export function logIgnoredSampling(body: Record<string, unknown>): void {
  if (!process.env.DEBUG) return;
  const present = IGNORED_SAMPLING.filter((key) => body[key] !== undefined);
  if (present.length > 0) {
    console.debug(
      `cursor-openai-proxy: ignoring sampling knobs: ${present.join(", ")}`,
    );
  }
}

export function requireSingleChoice(n: number | undefined): void {
  if (n !== undefined && n !== 1) {
    throw new HttpError(400, "Only n=1 is supported");
  }
}

export function rejectToolsAndLogprobs(body: {
  tools?: unknown;
  logprobs?: unknown;
}): void {
  if (body.tools !== undefined) {
    throw notImplemented("OpenAI tools");
  }
  if (body.logprobs !== undefined && Boolean(body.logprobs)) {
    throw notImplemented("logprobs");
  }
}

function isVisionPart(part: { type?: string; image_url?: unknown }): boolean {
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

export function flattenMessages(messages: readonly ChatMessage[]): string {
  return messages
    .map((message) => `${message.role}: ${flattenContent(message.content)}`)
    .join("\n");
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
    const type = rec.type;
    if (type === "input_image" || type === "image_url") {
      throw notImplemented("Vision / image inputs");
    }
    if (type === "input_text" && typeof rec.text === "string") {
      parts.push(rec.text);
      continue;
    }
    if (type === "message" || typeof rec.role === "string") {
      parts.push(flattenContent(rec.content as never));
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

export function withInstructions(
  prompt: string,
  instructions: string | undefined,
  firstTurn: boolean,
): string {
  if (!firstTurn || !instructions) return prompt;
  return `system: ${instructions}\n${prompt}`;
}

function hashPrefix(
  prefix: unknown,
  model: string,
  workspace: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ prefix, model, workspace }))
    .digest("hex")
    .slice(0, 24);
  return `sess_${digest}`;
}

export function prefixSessionId(
  messages: readonly ChatMessage[],
  model: string,
  workspace: string,
): string {
  return hashPrefix(messages.slice(0, -1), model, workspace);
}

export function nextPrefixSessionId(
  messages: readonly ChatMessage[],
  assistantText: string,
  model: string,
  workspace: string,
): string {
  return hashPrefix(
    [...messages, { role: "assistant", content: assistantText }],
    model,
    workspace,
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
  usage?: TokenUsage;
  created?: number;
}) {
  return {
    id: opts.id ?? newId("chatcmpl_"),
    object: "chat.completion" as const,
    created: opts.created ?? nowSeconds(),
    model: opts.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: opts.text },
        finish_reason: "stop",
      },
    ],
    usage: toUsage(opts.usage),
  };
}

export function toTextCompletion(opts: {
  id?: string;
  model: string;
  text: string;
  usage?: TokenUsage;
  created?: number;
}) {
  return {
    id: opts.id ?? newId("cmpl_"),
    object: "text_completion" as const,
    created: opts.created ?? nowSeconds(),
    model: opts.model,
    choices: [{ text: opts.text, index: 0, finish_reason: "stop" }],
    usage: toUsage(opts.usage),
  };
}

export function toResponseObject(opts: {
  id: string;
  model: string;
  text: string;
  status: string;
  previousResponseId?: string | null;
  usage?: TokenUsage;
  createdAt?: number;
}) {
  const messageStatus =
    opts.status === "completed" ? "completed" : opts.status;
  return {
    id: opts.id,
    object: "response" as const,
    status: opts.status,
    model: opts.model,
    created_at: opts.createdAt ?? nowSeconds(),
    previous_response_id: opts.previousResponseId ?? null,
    output: [
      {
        type: "message" as const,
        id: newId("msg_"),
        role: "assistant" as const,
        status: messageStatus,
        content: [{ type: "output_text" as const, text: opts.text }],
      },
    ],
    usage: toResponseUsage(opts.usage),
  };
}

export type OpenAIModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: "cursor";
};

export function flattenCatalog(
  catalog: Array<{ id: string; aliases?: string[] }>,
): { object: "list"; data: OpenAIModel[] } {
  const seen = new Set<string>();
  const data: OpenAIModel[] = [];
  for (const model of catalog) {
    for (const id of [model.id, ...(model.aliases ?? [])]) {
      if (seen.has(id)) continue;
      seen.add(id);
      data.push({ id, object: "model", created: 0, owned_by: "cursor" });
    }
  }
  return { object: "list", data };
}

export function effortParams(
  catalog: Array<{
    id: string;
    aliases?: string[];
    parameters?: Array<{ id: string; values: Array<{ value: string }> }>;
  }>,
  modelId: string,
  effort: string | undefined,
): Array<{ id: string; value: string }> | undefined {
  if (!effort) return undefined;
  const model = catalog.find(
    (item) => item.id === modelId || item.aliases?.includes(modelId),
  );
  const param = model?.parameters?.find(
    (item) => item.id === "effort" || item.id === "reasoning_effort",
  );
  if (!param) return undefined;
  if (!param.values.some((value) => value.value === effort)) return undefined;
  return [{ id: param.id, value: effort }];
}
