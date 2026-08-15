import type { SSEStreamingApi } from "hono/streaming";

export async function writeJsonSse(
  stream: SSEStreamingApi,
  data: unknown,
  event?: string,
): Promise<void> {
  await stream.writeSSE({
    data: JSON.stringify(data),
    ...(event ? { event } : {}),
  });
}

export async function writeDone(stream: SSEStreamingApi): Promise<void> {
  await stream.writeSSE({ data: "[DONE]" });
}
