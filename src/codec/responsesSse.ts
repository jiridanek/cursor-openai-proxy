export function responseOutputTextDeltaEvent(opts: {
  responseId: string;
  delta: string;
  outputIndex?: number;
}): {
  event: string;
  data: {
    type: "response.output_text.delta";
    item_id: string;
    output_index: number;
    delta: string;
  };
} {
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

export function responseReasoningSummaryTextDeltaEvent(opts: {
  responseId: string;
  delta: string;
  outputIndex?: number;
  summaryIndex?: number;
}): {
  event: string;
  data: {
    type: "response.reasoning_summary_text.delta";
    item_id: string;
    output_index: number;
    summary_index: number;
    delta: string;
  };
} {
  return {
    event: "response.reasoning_summary_text.delta",
    data: {
      type: "response.reasoning_summary_text.delta",
      item_id: opts.responseId,
      output_index: opts.outputIndex ?? 0,
      summary_index: opts.summaryIndex ?? 0,
      delta: opts.delta,
    },
  };
}

export function responseFunctionCallArgumentsDeltaEvent(opts: {
  itemId: string;
  delta: string;
  outputIndex?: number;
}): {
  event: string;
  data: {
    type: "response.function_call_arguments.delta";
    item_id: string;
    output_index: number;
    delta: string;
  };
} {
  return {
    event: "response.function_call_arguments.delta",
    data: {
      type: "response.function_call_arguments.delta",
      item_id: opts.itemId,
      output_index: opts.outputIndex ?? 0,
      delta: opts.delta,
    },
  };
}
