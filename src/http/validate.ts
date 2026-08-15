import type { Context } from "hono";
import { Schema } from "effect";
import { HttpError } from "./errors.ts";

export async function decodeJson<A, I>(
  c: Context,
  schema: Schema.Schema<A, I>,
): Promise<A> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const standard = Schema.standardSchemaV1(schema);
  const result = await Promise.resolve(standard["~standard"].validate(raw));
  if ("issues" in result && result.issues) {
    const message = result.issues
      .map((issue) => issue.message)
      .filter(Boolean)
      .join("; ");
    throw new HttpError(400, message || "Invalid request body");
  }
  return (result as { value: A }).value;
}
