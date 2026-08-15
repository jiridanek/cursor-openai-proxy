export type ResponsesSseEvent = {
  event: string;
  data: unknown;
};

export function responseCreatedEvent(response: unknown): ResponsesSseEvent {
  return { event: "response.created", data: response };
}

export function responseOutputTextDeltaEvent(opts: {
  responseId: string;
  delta: string;
  outputIndex?: number;
}): ResponsesSseEvent {
  return {
    event: "response.output_text.delta",
    data: {
      type: "response.output_text.delta",
      item_id: opts.responseId,
      output_index: opts.outputIndex ?? 0,
      delta: opts.delta,
    },
  };
}

export function responseCompletedEvent(response: unknown): ResponsesSseEvent {
  return { event: "response.completed", data: response };
}

export function formatResponsesSse(event: ResponsesSseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
