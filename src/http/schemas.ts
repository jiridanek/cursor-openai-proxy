import { Schema } from "effect";

const TextPart = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  image_url: Schema.optional(Schema.Unknown),
});

export const ChatMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(
    Schema.Union(Schema.String, Schema.Array(TextPart), Schema.Null),
  ),
  name: Schema.optional(Schema.String),
  tool_call_id: Schema.optional(Schema.String),
  tool_calls: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type ChatMessage = Schema.Schema.Type<typeof ChatMessage>;

export const ChatCompletionRequest = Schema.Struct({
  model: Schema.optional(Schema.String),
  messages: Schema.Array(ChatMessage),
  stream: Schema.optional(Schema.Boolean),
  stream_options: Schema.optional(
    Schema.Struct({ include_usage: Schema.optional(Schema.Boolean) }),
  ),
  n: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  seed: Schema.optional(Schema.Number),
  max_tokens: Schema.optional(Schema.Number),
  max_completion_tokens: Schema.optional(Schema.Number),
  logprobs: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  tool_choice: Schema.optional(Schema.Unknown),
  parallel_tool_calls: Schema.optional(Schema.Boolean),
  reasoning_effort: Schema.optional(Schema.String),
  fast: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  cursor_session_id: Schema.optional(Schema.String),
});
export type ChatCompletionRequest = Schema.Schema.Type<
  typeof ChatCompletionRequest
>;

const Reasoning = Schema.Struct({
  effort: Schema.optional(Schema.String),
});

export const ResponsesRequest = Schema.Struct({
  model: Schema.optional(Schema.String),
  input: Schema.Union(Schema.String, Schema.Array(Schema.Unknown)),
  instructions: Schema.optional(Schema.String),
  previous_response_id: Schema.optional(Schema.String),
  store: Schema.optional(Schema.Boolean),
  stream: Schema.optional(Schema.Boolean),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  tool_choice: Schema.optional(Schema.Unknown),
  parallel_tool_calls: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Reasoning),
  reasoning_effort: Schema.optional(Schema.String),
  fast: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
});
export type ResponsesRequest = Schema.Schema.Type<typeof ResponsesRequest>;

export const ChatCompletion = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("chat.completion"),
  created: Schema.Number,
  model: Schema.String,
  choices: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      message: Schema.Struct({
        role: Schema.Literal("assistant"),
        content: Schema.Union(Schema.String, Schema.Null),
      }),
      finish_reason: Schema.String,
    }),
  ),
  usage: Schema.Struct({
    prompt_tokens: Schema.Number,
    completion_tokens: Schema.Number,
    total_tokens: Schema.Number,
  }),
});
export type ChatCompletion = Schema.Schema.Type<typeof ChatCompletion>;
