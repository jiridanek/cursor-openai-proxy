import type { AgentMode } from "../config.ts";

export type ModelListItem = {
  id: string;
  aliases?: string[];
  parameters?: Array<{
    id: string;
    values: Array<{ value: string }>;
  }>;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type RunOutcome = {
  status: "finished" | "error" | "cancelled";
  result?: string;
  usage?: TokenUsage;
  error?: { message: string };
};

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; callId: string; name: string; arguments: string };

export type CustomToolExecute = (
  args: Record<string, unknown>,
  context: { toolCallId?: string },
) => Promise<unknown> | unknown;

export type CustomToolsMap = Record<
  string,
  {
    description?: string;
    inputSchema?: Record<string, unknown>;
    execute: CustomToolExecute;
  }
>;

export type SendOptions = {
  customTools?: CustomToolsMap;
};

export type RunHandle = {
  id: string;
  stream(): AsyncIterable<StreamEvent>;
  wait(): Promise<RunOutcome>;
  cancel(): Promise<void>;
  supports(operation: "cancel" | "stream" | "wait"): boolean;
};

export type AgentHandle = {
  agentId: string;
  send(prompt: string, options?: SendOptions): Promise<RunHandle>;
  close(): Promise<void>;
};

export type CreateAgentOptions = {
  apiKey: string;
  model: string;
  workspace: string;
  mode: AgentMode;
  params?: Array<{ id: string; value: string }>;
  tools?: string[];
};

export type CursorBackend = {
  listModels(apiKey: string): Promise<ModelListItem[]>;
  createAgent(options: CreateAgentOptions): Promise<AgentHandle>;
};
