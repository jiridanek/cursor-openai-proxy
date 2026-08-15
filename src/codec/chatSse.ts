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
