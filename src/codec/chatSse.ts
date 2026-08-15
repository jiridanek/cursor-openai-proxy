export type ChatChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
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

export function chatStopChunk(id: string, created: number, model: string): ChatChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
}

export type CompletionsChunk = {
  id: string;
  object: "text_completion";
  created: number;
  model: string;
  choices: Array<{
    text: string;
    index: number;
    finish_reason: string | null;
  }>;
};

export function completionsDeltaChunk(
  id: string,
  created: number,
  model: string,
  text: string,
): CompletionsChunk {
  return {
    id,
    object: "text_completion",
    created,
    model,
    choices: [{ text, index: 0, finish_reason: null }],
  };
}

export function completionsStopChunk(
  id: string,
  created: number,
  model: string,
): CompletionsChunk {
  return {
    id,
    object: "text_completion",
    created,
    model,
    choices: [{ text: "", index: 0, finish_reason: "stop" }],
  };
}
