import { describe, expect, it } from "vitest";
import { FakeCursorBackend } from "./helpers/fakeBackend.ts";
import {
  authHeaders,
  hostedConfig,
  jsonOf,
  makeApp,
  normalizeSse,
  postJson,
} from "./helpers/app.ts";

const ADD_TOOL = {
  type: "function",
  function: {
    name: "add",
    description: "Add two numbers",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
  },
};

describe("concurrent session creation", () => {
  it("dedupes two concurrent requests for the same not-yet-existing session id", async () => {
    // resolveChatSession() does registry.get() (sync) then, if absent,
    // awaits agent creation before registry.set(). Two requests racing on
    // the same explicit session_id both read `undefined` from get() before
    // either finishes creating -- without getOrCreate()'s in-flight-promise
    // dedup, both would spin up a separate FakeCursorBackend agent under the
    // same id, leaking one and leaving conversation state to whichever
    // creation happened to finish last.
    const backend = new FakeCursorBackend({ reply: "hi" });
    const { app } = makeApp(backend);

    const [first, second] = await Promise.all([
      postJson(app, "/v1/chat/completions", {
        session_id: "sess_race",
        messages: [{ role: "user", content: "one" }],
      }),
      postJson(app, "/v1/chat/completions", {
        session_id: "sess_race",
        messages: [{ role: "user", content: "two" }],
      }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(backend.creates).toBe(1);
  });
});

describe("OpenAI tool pass-through", () => {
  it("treats empty tools as text-only", async () => {
    const backend = new FakeCursorBackend({ reply: "ok" });
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    expect(res.status).toBe(200);
    expect(await jsonOf<{ choices: Array<{ finish_reason: string }> }>(res)).toMatchObject({
      choices: [{ finish_reason: "stop" }],
    });
    expect(backend.createOptions[0]?.tools).toEqual([
      "read",
      "grep",
      "glob",
      "ls",
    ]);
    expect(backend.sends[0]?.customTools).toBeUndefined();
  });

  it("does not 501 when chat tools are present", async () => {
    const backend = new FakeCursorBackend({
      toolCall: {
        name: "add",
        arguments: { a: 3, b: 4 },
        finalReply: (output) => `sum=${output}`,
      },
    });
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "add 3 and 4" }],
      tools: [ADD_TOOL],
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<{
      choices: Array<{
        finish_reason: string;
        message: {
          content: string | null;
          tool_calls: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    }>(res);
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    expect(body.choices[0]?.message.content).toBeNull();
    expect(body.choices[0]?.message.tool_calls[0]?.function.name).toBe("add");
    expect(backend.createOptions[0]?.tools).toEqual(["mcp"]);
    expect(backend.sends[0]?.customTools).toEqual(["add"]);
  });

  it("resumes a sticky chat session from role:tool and returns final text", async () => {
    const backend = new FakeCursorBackend({
      toolCall: {
        name: "add",
        arguments: { a: 3, b: 4 },
        id: "call_test",
        finalReply: (output) => `sum=${output}`,
      },
    });
    const { app } = makeApp(backend);
    const first = await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "add 3 and 4" }],
      tools: [ADD_TOOL],
    });
    const parked = await jsonOf<{
      choices: Array<{
        message: { tool_calls: Array<{ id: string }> };
      }>;
    }>(first);
    const sessionId = first.headers.get("X-Cursor-Session-Id");
    expect(sessionId).toBeTruthy();
    const callId = parked.choices[0]?.message.tool_calls[0]?.id;
    const second = await postJson(
      app,
      "/v1/chat/completions",
      {
        session_id: sessionId,
        tools: [ADD_TOOL],
        messages: [
          { role: "user", content: "add 3 and 4" },
          {
            role: "assistant",
            content: null,
            tool_calls: parked.choices[0]?.message.tool_calls,
          },
          { role: "tool", tool_call_id: callId, content: "7" },
        ],
      },
    );
    expect(second.status).toBe(200);
    const done = await jsonOf<{
      choices: Array<{ finish_reason: string; message: { content: string } }>;
    }>(second);
    expect(done.choices[0]?.finish_reason).toBe("stop");
    expect(done.choices[0]?.message.content).toBe("sum=7");
    expect(backend.creates).toBe(1);
    expect(backend.sends).toHaveLength(1);
  });

  it("resumes a second tool-calling round in the same sticky session", async () => {
    // Real OpenAI clients resend the *entire* message history on every
    // request. By the time round 2's tool output comes back, `messages`
    // contains both the already-resolved round-1 tool message (call_1) and
    // the new round-2 one (call_2). Before the orchestrate.ts fix,
    // toolOutputsFromMessages() returned both, and resumeParked() 400'd on
    // the stale call_1 (no longer parked in round 2's fresh supervisor)
    // before ever looking at call_2.
    const backend = new FakeCursorBackend({
      toolCallSequence: [
        { name: "add", arguments: { a: 3, b: 4 }, id: "call_1", finalReply: (o) => `sum=${o}` },
        { name: "add", arguments: { a: 5, b: 6 }, id: "call_2", finalReply: (o) => `sum2=${o}` },
      ],
    });
    const { app } = makeApp(backend);

    const user1 = { role: "user" as const, content: "add 3 and 4" };
    const round1 = await postJson(app, "/v1/chat/completions", {
      messages: [user1],
      tools: [ADD_TOOL],
    });
    const parked1 = await jsonOf<{
      choices: Array<{ message: { tool_calls: Array<{ id: string }> } }>;
    }>(round1);
    const sessionId = round1.headers.get("X-Cursor-Session-Id");
    const assistant1 = {
      role: "assistant" as const,
      content: null,
      tool_calls: parked1.choices[0]!.message.tool_calls,
    };
    const toolMsg1 = {
      role: "tool" as const,
      tool_call_id: parked1.choices[0]!.message.tool_calls[0]!.id,
      content: "7",
    };

    const resume1 = await postJson(app, "/v1/chat/completions", {
      session_id: sessionId,
      tools: [ADD_TOOL],
      messages: [user1, assistant1, toolMsg1],
    });
    const done1 = await jsonOf<{
      choices: Array<{ finish_reason: string; message: { content: string } }>;
    }>(resume1);
    expect(done1.choices[0]?.finish_reason).toBe("stop");
    expect(done1.choices[0]?.message.content).toBe("sum=7");

    const user2 = { role: "user" as const, content: "add 5 and 6" };
    const round2 = await postJson(app, "/v1/chat/completions", {
      session_id: sessionId,
      tools: [ADD_TOOL],
      messages: [user1, assistant1, toolMsg1, user2],
    });
    expect(round2.status).toBe(200);
    const parked2 = await jsonOf<{
      choices: Array<{
        finish_reason: string;
        message: { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> };
      }>;
    }>(round2);
    expect(parked2.choices[0]?.finish_reason).toBe("tool_calls");
    const callId2 = parked2.choices[0]!.message.tool_calls[0]!.id;
    const assistant2 = {
      role: "assistant" as const,
      content: null,
      tool_calls: parked2.choices[0]!.message.tool_calls,
    };
    const toolMsg2 = { role: "tool" as const, tool_call_id: callId2, content: "11" };

    // Full history, including the stale round-1 tool message: this is what
    // previously triggered "400 Unknown call_id: call_1".
    const resume2 = await postJson(app, "/v1/chat/completions", {
      session_id: sessionId,
      tools: [ADD_TOOL],
      messages: [user1, assistant1, toolMsg1, user2, assistant2, toolMsg2],
    });
    expect(resume2.status).toBe(200);
    const done2 = await jsonOf<{
      choices: Array<{ finish_reason: string; message: { content: string } }>;
    }>(resume2);
    expect(done2.choices[0]?.finish_reason).toBe("stop");
    expect(done2.choices[0]?.message.content).toBe("sum2=11");
  });

  it("serves a fresh unrelated message instead of treating stale tool history as a follow-up", async () => {
    // A client can report a tool result (role:"tool") and then move on to a
    // completely unrelated new message, all in the same resent history and
    // with no session id ever sent. toolOutputsFromMessages() used to scan
    // the *entire* messages array for role:"tool", so the stale tool
    // exchange kept getting treated as an active follow-up on every later
    // request in the conversation -- permanently 400ing anything sent
    // afterward, no matter how unrelated.
    const backend = new FakeCursorBackend({
      toolCallSequence: [{ name: "add", arguments: { a: 1, b: 2 }, id: "call_stale" }],
      reply: "gay.",
    });
    const { app } = makeApp(backend);

    const first = await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "add" }],
      tools: [ADD_TOOL],
    });
    const parked = await jsonOf<{
      choices: Array<{ message: { tool_calls: Array<{ id: string }> } }>;
    }>(first);

    const res = await postJson(app, "/v1/chat/completions", {
      // deliberately no session_id / X-Cursor-Session-Id anywhere
      tools: [ADD_TOOL],
      messages: [
        { role: "user", content: "add" },
        {
          role: "assistant",
          content: null,
          tool_calls: parked.choices[0]!.message.tool_calls,
        },
        { role: "tool", tool_call_id: "call_stale", content: "error: tool not found" },
        { role: "user", content: "say gay" },
      ],
    });
    expect(res.status).toBe(200);
    const done = await jsonOf<{
      choices: Array<{ finish_reason: string; message: { content: string } }>;
    }>(res);
    expect(done.choices[0]?.finish_reason).toBe("stop");
    expect(done.choices[0]?.message.content).toBe("gay.");
    expect(backend.creates).toBe(2); // a fresh agent for the new, unrelated turn
  });

  it("replays tool calls and their results (not just blank lines) when starting a fresh agent from history", async () => {
    // When resolveChatSession can't find a session for an explicit id (here:
    // one that was simply never created), it already falls back today to
    // starting a fresh agent and sending flattenMessages(messages) as the
    // prompt. flattenMessages used to render an assistant message with
    // tool_calls and content:null as just "assistant: " (empty -- content is
    // null, and the tool_calls themselves were never rendered), and a
    // role:"tool" message as "tool: <output>" with no indication of which
    // call it answers. A model replaying that history has no idea what tool
    // was called, with what arguments, or what the number in the tool
    // message is answering.
    const backend = new FakeCursorBackend({ reply: "ok" });
    const { app } = makeApp(backend);

    await postJson(app, "/v1/chat/completions", {
      session_id: "sess_never_created",
      tools: [ADD_TOOL],
      messages: [
        { role: "user", content: "add 3 and 4" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_ghost",
              type: "function",
              function: { name: "add", arguments: '{"a":3,"b":4}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_ghost", content: "7" },
      ],
    });

    expect(backend.creates).toBe(1);
    const prompt = backend.sends[0]?.prompt ?? "";
    expect(prompt).toContain("add(");
    expect(prompt).toContain('"a":3');
    expect(prompt).toContain("call_ghost");
    expect(prompt).toContain("7");
  });

  it("resumes a parked tool call via call_id alone when the session id is never sent", async () => {
    // A standards-compliant OpenAI client only has to echo the
    // tool_call_id back on its role:"tool" message -- that's core
    // protocol, not this proxy's X-Cursor-Session-Id extension. A client
    // that doesn't know about that extension (e.g. a generic
    // OpenAI-compatible agent CLI) must still be able to complete a
    // tool-calling round. This used to be a hard 400
    // ("Tool follow-ups require X-Cursor-Session-Id or session_id").
    const backend = new FakeCursorBackend({
      toolCall: {
        name: "add",
        arguments: { a: 1, b: 2 },
        id: "call_test",
        finalReply: (output) => `sum=${output}`,
      },
    });
    const { app } = makeApp(backend);
    const first = await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "add" }],
      tools: [ADD_TOOL],
    });
    const parked = await jsonOf<{
      choices: Array<{ message: { tool_calls: Array<{ id: string }> } }>;
    }>(first);

    const res = await postJson(app, "/v1/chat/completions", {
      // deliberately no session_id / X-Cursor-Session-Id anywhere
      tools: [ADD_TOOL],
      messages: [
        { role: "user", content: "add" },
        {
          role: "assistant",
          content: null,
          tool_calls: parked.choices[0]!.message.tool_calls,
        },
        { role: "tool", tool_call_id: "call_test", content: "3" },
      ],
    });
    expect(res.status).toBe(200);
    const done = await jsonOf<{
      choices: Array<{ finish_reason: string; message: { content: string } }>;
    }>(res);
    expect(done.choices[0]?.finish_reason).toBe("stop");
    expect(done.choices[0]?.message.content).toBe("sum=3");
    expect(backend.creates).toBe(1); // true resume, not a new agent
  });

  it("returns 400 for prefix mode plus tools", async () => {
    const { app } = makeApp(
      new FakeCursorBackend(),
      hostedConfig({ sessionMode: "prefix" }),
    );
    const res = await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "add" }],
      tools: [ADD_TOOL],
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 if a user message arrives while tool calls are parked", async () => {
    const backend = new FakeCursorBackend({
      toolCall: { name: "add", arguments: { a: 1, b: 2 }, id: "call_test" },
    });
    const { app } = makeApp(backend);
    const first = await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "add" }],
      tools: [ADD_TOOL],
    });
    const sessionId = first.headers.get("X-Cursor-Session-Id")!;
    const res = await postJson(app, "/v1/chat/completions", {
      session_id: sessionId,
      messages: [
        { role: "user", content: "add" },
        { role: "user", content: "never mind, just say hi" },
      ],
    });
    expect(res.status).toBe(409);
    expect(await jsonOf<{ error: { code: string } }>(res)).toMatchObject({
      error: { code: "requires_action" },
    });
  });

  it("snapshots chat SSE tool_call deltas", async () => {
    const backend = new FakeCursorBackend({
      deltas: ["Let me add. "],
      toolCall: {
        name: "add",
        arguments: { a: 3, b: 4 },
        id: "call_test",
      },
    });
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/chat/completions", {
      stream: true,
      messages: [{ role: "user", content: "add 3 and 4" }],
      tools: [ADD_TOOL],
    });
    expect(res.status).toBe(200);
    expect(
      normalizeSse(await res.text(), [
        [/chatcmpl_[a-f0-9-]+/g, "chatcmpl_ID"],
        [/"created":\s*\d+/g, '"created": 0'],
      ]),
    ).toMatchSnapshot();
  });

  it("parks Responses as requires_action and completes on function_call_output", async () => {
    const backend = new FakeCursorBackend({
      toolCall: {
        name: "add",
        arguments: { a: 3, b: 4 },
        id: "call_test",
        finalReply: (output) => `sum=${output}`,
      },
    });
    const { app } = makeApp(backend);
    const first = await postJson(app, "/v1/responses", {
      input: "add 3 and 4",
      tools: [
        {
          type: "function",
          name: "add",
          description: "Add two numbers",
          parameters: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
        },
      ],
    });
    expect(first.status).toBe(200);
    const parked = await jsonOf<{
      id: string;
      status: string;
      output: Array<{ type: string; call_id?: string; name?: string }>;
    }>(first);
    expect(parked.status).toBe("requires_action");
    expect(parked.output.some((item) => item.type === "function_call")).toBe(
      true,
    );

    const stored = await app.request(`/v1/responses/${parked.id}`, {
      headers: authHeaders(),
    });
    expect(stored.status).toBe(200);
    expect(await jsonOf<{ status: string }>(stored)).toMatchObject({
      status: "requires_action",
    });

    const second = await postJson(app, "/v1/responses", {
      previous_response_id: parked.id,
      input: [
        { type: "function_call_output", call_id: "call_test", output: "7" },
      ],
    });
    expect(second.status).toBe(200);
    const done = await jsonOf<{
      status: string;
      output: Array<{ content?: Array<{ text: string }> }>;
    }>(second);
    expect(done.status).toBe("completed");
    expect(done.output[0]?.content?.[0]?.text).toBe("sum=7");
    expect(backend.sends).toHaveLength(1);
  });

  it("returns 400 for store:false plus tools", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/v1/responses", {
      input: "add",
      store: false,
      tools: [ADD_TOOL],
    });
    expect(res.status).toBe(400);
  });

  it("cancels parked tool calls", async () => {
    const backend = new FakeCursorBackend({
      toolCall: { name: "add", arguments: { a: 1, b: 2 }, id: "call_test" },
    });
    const { app } = makeApp(backend);
    const first = await postJson(app, "/v1/responses", {
      input: "add",
      tools: [ADD_TOOL],
    });
    const parked = await jsonOf<{ id: string }>(first);
    const cancel = await app.request(`/v1/responses/${parked.id}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(cancel.status).toBe(200);
    expect(await jsonOf<{ status: string }>(cancel)).toMatchObject({
      status: "cancelled",
    });
  });

  it("snapshots Responses requires_action SSE", async () => {
    const backend = new FakeCursorBackend({
      deltas: ["Calling add. "],
      toolCall: {
        name: "add",
        arguments: { a: 3, b: 4 },
        id: "call_test",
      },
    });
    const { app } = makeApp(backend);
    const res = await postJson(app, "/v1/responses", {
      input: "add 3 and 4",
      stream: true,
      tools: [ADD_TOOL],
    });
    expect(res.status).toBe(200);
    expect(
      normalizeSse(await res.text(), [
        [/resp_[a-f0-9-]+/g, "resp_ID"],
        [/msg_[a-f0-9-]+/g, "msg_ID"],
        [/fc_[a-f0-9-]+/g, "fc_ID"],
        [/"created_at":\s*\d+/g, '"created_at": 0'],
      ]),
    ).toMatchSnapshot();
  });

  it("returns 501 for non-function tool types", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/v1/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "file_search" }],
    });
    expect(res.status).toBe(501);
  });

  it("surfaces a tool call parked after the idle window on a later status check", async () => {
    // waitForParkIdle() treats "no new park for PARK_IDLE_MS" as "turn done"
    // and collectTurn() used to freeze record.pendingToolCalls at that
    // instant. wrapCustomTools().execute() keeps adding to the live
    // supervisor.parks map regardless, so a tool_call the fake run dispatches
    // after the idle window used to become invisible to the client forever,
    // while resumeParked() would still (correctly) demand an output for it.
    const MULTIPLY_TOOL = {
      type: "function",
      function: {
        name: "multiply",
        description: "Multiply two numbers",
        parameters: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
    };
    const backend = new FakeCursorBackend({
      toolCall: { name: "add", arguments: { a: 1, b: 2 }, id: "call_first" },
      extraToolCalls: [
        { name: "multiply", arguments: { a: 3, b: 4 }, id: "call_late", delayMs: 80 },
      ],
    });
    const { app } = makeApp(backend);

    const first = await postJson(app, "/v1/responses", {
      input: "add then multiply",
      tools: [ADD_TOOL, MULTIPLY_TOOL],
    });
    const parked = await jsonOf<{
      id: string;
      status: string;
      output: Array<{ call_id?: string }>;
    }>(first);
    expect(parked.status).toBe("requires_action");
    expect(
      parked.output.filter((item) => item.call_id).map((item) => item.call_id),
    ).toEqual(["call_first"]);

    await new Promise((resolve) => setTimeout(resolve, 120));

    const stored = await app.request(`/v1/responses/${parked.id}`, {
      headers: authHeaders(),
    });
    const status = await jsonOf<{
      status: string;
      output: Array<{ call_id?: string }>;
    }>(stored);
    expect(status.status).toBe("requires_action");
    const callIds = status.output
      .filter((item) => item.call_id)
      .map((item) => item.call_id);
    expect(callIds).toContain("call_first");
    expect(callIds).toContain("call_late");
  });

  it("rejects a parked tool call instead of leaking it when the run errors out from under it", async () => {
    // collectTurn()'s terminal branch used to drop record.supervisor without
    // touching any still-pending supervisor.parks entries, unlike
    // cancelRun() which explicitly rejects them. A customTools.execute()
    // promise still parked when the underlying run reaches a terminal
    // outcome (here: an error unrelated to the tool call itself) would
    // never settle -- a leaked promise.
    const settled: Array<{ callId: string; outcome: string }> = [];
    const backend = new FakeCursorBackend({
      toolCall: { name: "add", arguments: { a: 1, b: 2 }, id: "call_leak" },
      errorAfterParkMs: 5, // fires well before PARK_IDLE_MS (50ms)
      onToolExecuteSettled: (callId, outcome) => settled.push({ callId, outcome }),
    });
    const { app } = makeApp(backend);

    await postJson(app, "/v1/responses", {
      input: "add",
      tools: [ADD_TOOL],
    });
    // Let the rejection's microtask chain (park.reject -> the fake run's
    // awaited tool.execute() -> its catch handler) flush.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(settled).toEqual([{ callId: "call_leak", outcome: "rejected" }]);
  });

  it("returns 400 for an unknown tool call_id", async () => {
    const backend = new FakeCursorBackend({
      toolCall: { name: "add", arguments: { a: 1, b: 2 }, id: "call_test" },
    });
    const { app } = makeApp(backend);
    const first = await postJson(app, "/v1/responses", {
      input: "add",
      tools: [ADD_TOOL],
    });
    const parked = await jsonOf<{ id: string }>(first);
    const res = await postJson(app, "/v1/responses", {
      previous_response_id: parked.id,
      input: [
        { type: "function_call_output", call_id: "call_missing", output: "3" },
      ],
    });
    expect(res.status).toBe(400);
  });
});
