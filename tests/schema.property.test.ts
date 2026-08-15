import { Arbitrary, FastCheck, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http/errors.ts";
import { ChatCompletion, ChatCompletionRequest } from "../src/http/schemas.ts";
import { flattenMessages, toChatCompletion } from "../src/mapping.ts";
import { FakeCursorBackend } from "./helpers/fakeBackend.ts";
import { authHeaders, jsonOf, makeApp } from "./helpers/app.ts";

const ChatRequestArb = Arbitrary.make(ChatCompletionRequest);

describe("schema property tests", () => {
  it("decoded chat requests map to well-formed completions", () => {
    FastCheck.assert(
      FastCheck.property(ChatRequestArb, (request) => {
        let text: string;
        try {
          text = flattenMessages(request.messages);
        } catch (err) {
          if (err instanceof HttpError && err.status === 501) return true;
          throw err;
        }
        const completion = toChatCompletion({
          model: request.model || "composer-2.5",
          text,
        });
        const decoded = Schema.decodeUnknownSync(ChatCompletion)(completion);
        expect(decoded.object).toBe("chat.completion");
        expect(decoded.choices).toHaveLength(1);
        expect(decoded.choices[0]?.message.role).toBe("assistant");
        expect(decoded.choices[0]?.message.content).toBe(text);
        return true;
      }),
      { numRuns: 25 },
    );
  });

  it("Responses follow-up send()s only the new input", async () => {
    await FastCheck.assert(
      FastCheck.asyncProperty(
        FastCheck.string({ minLength: 1, maxLength: 64 }),
        async (followUp) => {
          const backend = new FakeCursorBackend({ reply: "ok" });
          const { app } = makeApp(backend);
          const first = await app.request("/v1/responses", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ input: "start" }),
          });
          const created = await jsonOf<{ id: string }>(first);
          await app.request("/v1/responses", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({
              input: followUp,
              previous_response_id: created.id,
            }),
          });
          expect(backend.sends).toHaveLength(2);
          expect(backend.sends[1]?.prompt).toBe(followUp);
          expect(backend.creates).toBe(1);
        },
      ),
      { numRuns: 10 },
    );
  });
});
