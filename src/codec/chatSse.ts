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

export function chatRoleChunk(id: string, created: number, model: string): ChatChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
}

export function chatDeltaChunk(
  id: string,
  created: number,
  model: string,
  content: string,
): ChatChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

export function chatReasoningChunk(
  id: string,
  created: number,
  model: string,
  reasoningContent: string,
): ChatChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      { index: 0, delta: { reasoning_content: reasoningContent }, finish_reason: null },
    ],
  };
}

export function chatToolCallChunk(
  id: string,
  created: number,
  model: string,
  toolCall: ChatToolCallDelta,
): ChatChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { tool_calls: [toolCall] },
        finish_reason: null,
      },
    ],
  };
}

export function chatFinishChunk(
  id: string,
  created: number,
  model: string,
  finishReason: "stop" | "tool_calls",
): ChatChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
}

export function chatStopChunk(id: string, created: number, model: string): ChatChunk {
  return chatFinishChunk(id, created, model, "stop");
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
