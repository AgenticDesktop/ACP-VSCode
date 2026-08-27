import test from "node:test";
import assert from "node:assert/strict";
import { computePermissionOutcomes } from "../src/provider/permissionLogic";
import { isPathInsideWorkspace, sliceReadRange } from "../src/provider/pathLogic";
import { renderStoredTurn } from "../src/provider/render";
import type { AcpPermissionOption, AcpPermissionUpdate } from "../src/acp/types";
import type { StoredTurn } from "../src/sessionStore";

// ---------------------------------------------------------------------------
// computePermissionOutcomes (permission result mapping)
// ---------------------------------------------------------------------------

const OPTIONS: AcpPermissionOption[] = [
  { toolCallId: "t1", title: "Allow once", kind: "allow_once" },
  { toolCallId: "t1", title: "Always allow", kind: "allow_always" },
  { toolCallId: "t1", title: "Reject once", kind: "reject_once" },
  { toolCallId: "t2", title: "Allow once", kind: "allow_once" },
  { toolCallId: "t2", title: "Always reject", kind: "reject_always" },
];

function outcomesOf(updates: AcpPermissionUpdate[]): string[] {
  return updates.map((update) => update.outcome);
}

test("permission: choosing allow_once marks it selected and all others pending", () => {
  const updates = computePermissionOutcomes(OPTIONS, "t1", "allow_once");
  assert.deepEqual(outcomesOf(updates), ["selected", "pending", "pending", "pending", "pending"]);
});

test("permission: choosing reject_once marks it selected and all others rejected", () => {
  const updates = computePermissionOutcomes(OPTIONS, "t1", "reject_once");
  assert.deepEqual(outcomesOf(updates), ["rejected", "rejected", "selected", "rejected", "rejected"]);
});

test("permission: choosing allow_always keeps other options pending", () => {
  const updates = computePermissionOutcomes(OPTIONS, "t2", "allow_once");
  assert.deepEqual(outcomesOf(updates), ["pending", "pending", "pending", "selected", "pending"]);
});

test("permission: choosing reject_always rejects options across other toolCallIds too", () => {
  const updates = computePermissionOutcomes(OPTIONS, "t2", "reject_always");
  assert.deepEqual(outcomesOf(updates), ["rejected", "rejected", "rejected", "rejected", "selected"]);
});

test("permission: updates stay aligned with the input option order and toolCallIds", () => {
  const updates = computePermissionOutcomes(OPTIONS, "t1", "allow_always");
  assert.equal(updates.length, OPTIONS.length);
  for (let i = 0; i < OPTIONS.length; i++) {
    assert.equal(updates[i].toolCallId, OPTIONS[i].toolCallId);
  }
  assert.equal(updates[1].outcome, "selected");
});

test("permission: empty option list yields no updates", () => {
  assert.deepEqual(computePermissionOutcomes([], "t1", "allow_once"), []);
});

// ---------------------------------------------------------------------------
// isPathInsideWorkspace (path containment rules)
// ---------------------------------------------------------------------------

test("path: file below the workspace root is inside", () => {
  assert.equal(isPathInsideWorkspace("D:\\ws\\src\\main.ts", ["D:\\ws"], true), true);
});

test("path: the workspace root itself is inside", () => {
  assert.equal(isPathInsideWorkspace("D:\\ws", ["D:\\ws"], true), true);
});

test("path: file outside all workspace roots is rejected", () => {
  assert.equal(isPathInsideWorkspace("E:\\other\\secret.txt", ["D:\\ws"], true), false);
  assert.equal(isPathInsideWorkspace("/var/log/syslog", ["/home/u/ws"], false), false);
});

test("path: relative paths are rejected in both platform modes", () => {
  assert.equal(isPathInsideWorkspace("src/main.ts", ["D:\\ws"], true), false);
  assert.equal(isPathInsideWorkspace(".\\file.txt", ["D:\\ws"], true), false);
  assert.equal(isPathInsideWorkspace("..\\sibling\\file.txt", ["D:\\ws"], true), false);
  assert.equal(isPathInsideWorkspace("src/main.ts", ["/home/u/ws"], false), false);
});

test("path: sibling directory sharing a name prefix is not inside (D:\\ws-x vs D:\\ws)", () => {
  assert.equal(isPathInsideWorkspace("D:\\ws-x\\evil.txt", ["D:\\ws"], true), false);
  assert.equal(isPathInsideWorkspace("D:\\ws.txt", ["D:\\ws"], true), false);
  assert.equal(isPathInsideWorkspace("/home/u/ws-x/evil.txt", ["/home/u/ws"], false), false);
});

test("path: Windows comparisons are case-insensitive, POSIX ones are case-sensitive", () => {
  assert.equal(isPathInsideWorkspace("d:\\WS\\src\\FILE.ts", ["D:\\ws"], true), true);
  assert.equal(isPathInsideWorkspace("D:\\ws\\src\\FILE.ts", ["d:\\WS"], true), true);
  assert.equal(isPathInsideWorkspace("/home/u/ws/FILE.ts", ["/HOME/U/WS"], false), false);
  assert.equal(isPathInsideWorkspace("/HOME/U/WS/FILE.ts", ["/HOME/U/WS"], false), true);
});

test("path: trailing separators on root or candidate do not break containment", () => {
  assert.equal(isPathInsideWorkspace("D:\\ws\\src", ["D:\\ws\\"], true), true);
  assert.equal(isPathInsideWorkspace("D:\\ws\\src\\", ["D:\\ws"], true), true);
  assert.equal(isPathInsideWorkspace("/home/u/ws/src", ["/home/u/ws/"], false), true);
});

test("path: forward and back slashes are equivalent separators on Windows", () => {
  assert.equal(isPathInsideWorkspace("D:/ws/src/main.ts", ["D:\\ws"], true), true);
  assert.equal(isPathInsideWorkspace("D:\\ws\\src\\main.ts", ["D:/ws"], true), true);
});

test("path: a path only needs to be inside one of several workspace roots", () => {
  const roots = ["C:\\proj", "D:\\ws"];
  assert.equal(isPathInsideWorkspace("D:\\ws\\a.txt", roots, true), true);
  assert.equal(isPathInsideWorkspace("C:\\proj\\a.txt", roots, true), true);
  assert.equal(isPathInsideWorkspace("E:\\elsewhere\\a.txt", roots, true), false);
});

// ---------------------------------------------------------------------------
// sliceReadRange (fs/read_text_file range parameters)
// ---------------------------------------------------------------------------

test("read range: without line/limit the full content is returned", () => {
  assert.equal(sliceReadRange("a\nb\nc"), "a\nb\nc");
  assert.equal(sliceReadRange("a\nb\nc", 1), "a\nb\nc");
});

test("read range: line is 1-based and preserves line terminators", () => {
  assert.equal(sliceReadRange("a\nb\nc", 2), "b\nc");
  assert.equal(sliceReadRange("a\r\nb\r\nc", 2), "b\r\nc");
});

test("read range: limit caps the number of lines returned", () => {
  assert.equal(sliceReadRange("a\nb\nc", 1, 2), "a\nb\n");
  assert.equal(sliceReadRange("a\nb\nc\n", 2, 2), "b\nc\n");
});

test("read range: line and limit combine; out-of-range slices are empty", () => {
  assert.equal(sliceReadRange("a\nb\nc", 2, 1), "b\n");
  assert.equal(sliceReadRange("a\nb", 5), "");
  assert.equal(sliceReadRange("a\nb", 1, 0), "");
});

// ---------------------------------------------------------------------------
// renderStoredTurn (StoredTurn playback rendering)
// ---------------------------------------------------------------------------

function storedTurn(patch: Partial<StoredTurn> = {}): StoredTurn {
  return {
    prompt: "hi",
    responseMarkdown: "",
    tools: [],
    stopReason: "end_turn",
    startedAt: 0,
    endedAt: 1,
    ...patch,
  };
}

test("renderStoredTurn: thoughts, body, tools, error and stop footnote all appear in order", () => {
  const rendered = renderStoredTurn(
    storedTurn({
      thoughts: "step one\nstep two",
      responseMarkdown: "Final answer",
      tools: [
        { toolCallId: "t1", title: "Echo tool", status: "completed" },
        { toolCallId: "t2", title: "Failing tool", status: "failed" },
      ],
      error: "boom",
      stopReason: "cancelled",
    }),
  );

  assert.ok(rendered.includes("> step one\n> step two"), "multi-line thoughts must stay quoted");
  assert.ok(rendered.includes("Final answer"));
  assert.ok(rendered.includes("- 🔧 Echo tool (completed)"));
  assert.ok(rendered.includes("- 🔧 Failing tool (failed)"));
  assert.ok(rendered.includes("> ⚠️ **Error:** boom"));
  assert.ok(rendered.includes("_stopped: cancelled_"));

  const order = [
    rendered.indexOf("> step one"),
    rendered.indexOf("Final answer"),
    rendered.indexOf("- 🔧 Echo tool"),
    rendered.indexOf("> ⚠️ **Error:**"),
    rendered.indexOf("_stopped: cancelled_"),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order, "sections must be ordered");
});

test("renderStoredTurn: end_turn produces no stop-reason footnote", () => {
  const rendered = renderStoredTurn(
    storedTurn({
      responseMarkdown: "done",
      tools: [{ toolCallId: "t1", title: "Echo tool", status: "completed" }],
    }),
  );
  assert.ok(rendered.includes("done"));
  assert.ok(rendered.includes("- 🔧 Echo tool (completed)"));
  assert.ok(!rendered.includes("_stopped:"));
});

test("renderStoredTurn: empty and whitespace-only sections render as empty string", () => {
  assert.equal(renderStoredTurn(storedTurn()), "");
  assert.equal(
    renderStoredTurn(storedTurn({ responseMarkdown: "   \n  ", thoughts: "   " })),
    "",
  );
});
