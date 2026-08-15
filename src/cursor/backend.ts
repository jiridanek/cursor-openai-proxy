import type { AgentMode } from "../config.ts";

export type ModelListItem = {
  id: string;
  displayName?: string;
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

export type RunHandle = {
  id: string;
  streamText(): AsyncIterable<string>;
  wait(): Promise<RunOutcome>;
  cancel(): Promise<void>;
  supports(operation: "cancel" | "stream" | "wait"): boolean;
};

export type AgentHandle = {
  agentId: string;
  send(prompt: string): Promise<RunHandle>;
  close(): Promise<void>;
};

export type CreateAgentOptions = {
  apiKey: string;
  model: string;
  workspace: string;
  mode: AgentMode;
  params?: Array<{ id: string; value: string }>;
};

export type CursorBackend = {
  listModels(apiKey: string): Promise<ModelListItem[]>;
  createAgent(options: CreateAgentOptions): Promise<AgentHandle>;
};
