import test from "node:test";
import assert from "node:assert/strict";
import { TurnAccumulator } from "../src/provider/render";

function agentChunk(text: string) {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  };
}

test("agent_message_chunk chunks are concatenated in order", () => {
  const acc = new TurnAccumulator();
  acc.apply(agentChunk("Hello "));
  acc.apply(agentChunk("world"));
  assert.equal(acc.markdown, "Hello world");
});

test("agent_message_chunk non-text blocks are ignored for markdown", () => {
  const acc = new TurnAccumulator();
  acc.apply(agentChunk("answer"));
  acc.apply({
    sessionUpdate: "agent_message_chunk",
    content: { type: "image", mimeType: "image/png", data: "binary" },
  });
  assert.equal(acc.markdown, "answer");
});

test("multiple content blocks within one chunk are joined with a blank line", () => {
  const acc = new TurnAccumulator();
  acc.apply({
    sessionUpdate: "agent_message_chunk",
    content: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ],
  });
  assert.equal(acc.markdown, "first\n\nsecond");
});

test("agent_thought_chunk accumulates thoughts", () => {
  const acc = new TurnAccumulator();
  acc.apply({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "Considering " },
  });
  acc.apply({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "options" },
  });
  assert.equal(acc.thoughts, "Considering options");
  assert.equal(acc.markdown, "");
});

test("tool_call creates an entry and tool_call_update merges by toolCallId", () => {
  const acc = new TurnAccumulator();
  acc.apply({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Read file",
    kind: "read",
    status: "pending",
  });
  acc.apply({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "in_progress",
  });
  acc.apply({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "file contents" } }],
  });

  assert.equal(acc.tools.length, 1);
  assert.equal(acc.tools[0].toolCallId, "t1");
  assert.equal(acc.tools[0].title, "Read file");
  assert.equal(acc.tools[0].kind, "read");
  assert.equal(acc.tools[0].status, "completed");
  assert.equal(acc.tools[0].content, "file contents");
});

test("tool_call without status defaults to pending", () => {
  const acc = new TurnAccumulator();
  acc.apply({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Run command" });
  assert.equal(acc.tools[0].status, "pending");
});

test("tool_call_update for an unknown toolCallId is ignored", () => {
  const acc = new TurnAccumulator();
  acc.apply({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file" });
  acc.apply({ sessionUpdate: "tool_call_update", toolCallId: "missing", status: "failed" });
  assert.equal(acc.tools.length, 1);
  assert.equal(acc.tools[0].status, "pending");
});

test("non-text tool call content blocks are summarized as JSON", () => {
  const acc = new TurnAccumulator();
  acc.apply({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Show image",
  });
  acc.apply({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
    content: [
      {
        type: "content",
        content: { type: "image", mimeType: "image/png", data: "abc" },
      },
    ],
  });
  assert.equal(
    acc.tools[0].content,
    JSON.stringify({ type: "image", mimeType: "image/png", data: "abc" }),
  );
});

test("plan updates replace the full entry list", () => {
  const acc = new TurnAccumulator();
  acc.apply({
    sessionUpdate: "plan",
    entries: [
      { content: "step 1", status: "completed", priority: "high" },
      { content: "step 2", status: "in_progress", priority: "medium" },
    ],
  });
  assert.deepEqual(acc.plan, [
    { content: "step 1", status: "completed" },
    { content: "step 2", status: "in_progress" },
  ]);

  acc.apply({
    sessionUpdate: "plan",
    entries: [{ content: "only step", status: "pending", priority: "low" }],
  });
  assert.deepEqual(acc.plan, [{ content: "only step", status: "pending" }]);
});

test("plan entries with unknown status fall back to pending", () => {
  const acc = new TurnAccumulator();
  acc.apply({
    sessionUpdate: "plan",
    entries: [{ content: "step", status: "some_new_status" }],
  });
  assert.deepEqual(acc.plan, [{ content: "step", status: "pending" }]);
});

test("usage_update with context window stats is formatted", () => {
  const acc = new TurnAccumulator();
  acc.apply({
    sessionUpdate: "usage_update",
    used: 120,
    size: 2000,
    cost: { amount: 0.5, currency: "USD" },
  });
  assert.equal(acc.usageText, "context: 120 / 2000 tokens, cost 0.5 USD");
});

test("usage_update with token counters is formatted as in/out", () => {
  const acc = new TurnAccumulator();
  acc.apply({
    sessionUpdate: "usage_update",
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  });
  assert.equal(acc.usageText, "tokens: in 10 / out 20, total 30");
});

test("usage_update without recognizable counters leaves usageText unset", () => {
  const acc = new TurnAccumulator();
  acc.apply({ sessionUpdate: "usage_update" });
  assert.equal(acc.usageText, undefined);
});

test("unknown update types and malformed inputs are ignored without throwing", () => {
  const acc = new TurnAccumulator();
  acc.apply(agentChunk("kept"));
  acc.apply({ sessionUpdate: "some_future_update", data: 1 });
  acc.apply({ sessionUpdate: "current_mode_update", currentModeId: "build" });
  acc.apply("not an object");
  acc.apply(null);
  acc.apply(undefined);
  acc.apply(42);
  assert.equal(acc.markdown, "kept");
  assert.deepEqual(acc.tools, []);
  assert.deepEqual(acc.plan, []);
  assert.equal(acc.usageText, undefined);
});

test("user_message_chunk does not affect agent markdown", () => {
  const acc = new TurnAccumulator();
  acc.apply({
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "user prompt" },
  });
  acc.apply(agentChunk("answer"));
  assert.equal(acc.markdown, "answer");
});
