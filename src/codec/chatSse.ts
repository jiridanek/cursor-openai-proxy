export type ChatToolCallDelta = {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
};

export type ChatChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
      reasoning_content?: string;
      tool_calls?: ChatToolCallDelta[];
    };
    finish_reason: string | null;
  }>;
};

// Shared envelope for the five chunk builders below: each supplies only its
// own `delta` (and `finishReason`, for the finish chunk) and injects it here
// -- same shell/injected-payload split as mapping.ts's catalogParam(). Kept
// as named functions rather than one generic builder because each name is
// an OpenAI-wire-meaningful concept (role/content/reasoning/tool-call/finish),
// not incidental duplication -- see ARCHITECTURE.md.
function chatChunk(
  id: string,
  created: number,
  model: string,
  delta: ChatChunk["choices"][0]["delta"],
  finishReason: string | null = null,
): ChatChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function chatRoleChunk(id: string, created: number, model: string): ChatChunk {
  return chatChunk(id, created, model, { role: "assistant" });
}

export function chatDeltaChunk(
  id: string,
  created: number,
  model: string,
  content: string,
): ChatChunk {
  return chatChunk(id, created, model, { content });
}

export function chatReasoningChunk(
  id: string,
  created: number,
  model: string,
  reasoningContent: string,
): ChatChunk {
  return chatChunk(id, created, model, { reasoning_content: reasoningContent });
}

export function chatToolCallChunk(
  id: string,
  created: number,
  model: string,
  toolCall: ChatToolCallDelta,
): ChatChunk {
  return chatChunk(id, created, model, { tool_calls: [toolCall] });
}

export function chatFinishChunk(
  id: string,
  created: number,
  model: string,
  finishReason: "stop" | "tool_calls",
): ChatChunk {
  return chatChunk(id, created, model, {}, finishReason);
}

export type ChatUsageChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: [];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

export function chatUsageChunk(
  id: string,
  created: number,
  model: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): ChatUsageChunk {
  return { id, object: "chat.completion.chunk", created, model, choices: [], usage };
}
