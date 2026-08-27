import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpAgentConnection, AcpJsonRpcError } from "../src/acp/agentConnection";
import type { AcpAgentConnectionDeps } from "../src/acp/agentConnection";
import type { AcpPermissionRequest } from "../src/acp/types";
import { ACP_ERROR_CODES } from "../src/acp/types";
import { computePermissionOutcomes } from "../src/provider/permissionLogic";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const MOCK_AGENT_SCRIPT = path.join(PROJECT_ROOT, "test", "mock-agent", "agent.mjs");

interface MockAgentHandle {
  process: ChildProcess;
  sendRequest: (method: string, params?: unknown) => Promise<any>;
  sendNotification: (method: string, params?: unknown) => void;
  waitForNotification: (matcher: string | ((message: any) => boolean), timeoutMs?: number) => Promise<any>;
  nextMessage: (timeoutMs?: number) => Promise<any>;
}

// The helper is an ESM .mjs module; load it via require (Node >= 22 supports
// require(esm)) because the test bundle compiles to CommonJS.
const { spawnMockAgent } = require(path.join(PROJECT_ROOT, "test", "util", "spawnMockAgent.mjs")) as {
  spawnMockAgent: (env?: Record<string, string>) => MockAgentHandle;
};

function createConnection(
  deps: Partial<AcpAgentConnectionDeps> = {},
  env: Record<string, string> = {},
): AcpAgentConnection {
  const fullDeps: AcpAgentConnectionDeps = {
    log: () => {},
    permissionHandler: async () => ({ updates: [] }),
    ...deps,
  };
  return new AcpAgentConnection(
    "test-slot",
    { command: process.execPath, args: [MOCK_AGENT_SCRIPT], env },
    fullDeps,
  );
}

function collectUpdates(connection: AcpAgentConnection): SessionNotification[] {
  const updates: SessionNotification[] = [];
  connection.on("sessionUpdate", (notification: SessionNotification) => {
    updates.push(notification);
  });
  return updates;
}

function textOf(notification: SessionNotification): string {
  const update = notification.update;
  return update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
    ? update.content.text
    : "";
}

async function waitForProcessExit(
  connection: AcpAgentConnection,
  timeoutMs = 5000,
): Promise<number | null> {
  return await Promise.race([
    once(connection, "processExit").then(([code]: unknown[]) => code as number | null),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("processExit was not emitted in time")),
        timeoutMs,
      );
      timer.unref();
    }),
  ]);
}

test("1) initialize handshake succeeds and caches agent capabilities", async () => {
  const connection = createConnection();
  try {
    const response = await connection.ensureInitialized();
    assert.equal(response.protocolVersion, 1);
    assert.equal(response.agentCapabilities?.loadSession, true);
    assert.equal(response.agentInfo?.name, "mock-agent");
    assert.equal(connection.getInitializeResponse(), response);
    // Concurrent calls share the same in-flight promise.
    const [a, b] = await Promise.all([
      connection.ensureInitialized(),
      connection.ensureInitialized(),
    ]);
    assert.equal(a, b);
  } finally {
    connection.dispose();
  }
});

test("2) newSession + prompt default scenario: >=3 updates, stopReason end_turn", async () => {
  const connection = createConnection();
  try {
    await connection.ensureInitialized();
    const session = await connection.newSession(process.cwd());
    assert.equal(session.sessionId, "mock-session-1");
    const updates = collectUpdates(connection);
    const response = await connection.prompt(session.sessionId, "say something");
    assert.equal(response.stopReason, "end_turn");
    assert.ok(updates.length >= 3, `expected >= 3 updates, got ${updates.length}`);
    assert.equal(updates.map(textOf).join(""), "Hello from mock.");
  } finally {
    connection.dispose();
  }
});

test("3) cancel: session/cancel resolves the prompt turn with stopReason cancelled", async () => {
  const connection = createConnection();
  try {
    await connection.ensureInitialized();
    const session = await connection.newSession(process.cwd());
    const updates = collectUpdates(connection);
    const promptPromise = connection.prompt(session.sessionId, "please cancel me");
    await once(connection, "sessionUpdate");
    await connection.cancel(session.sessionId);
    const response = await promptPromise;
    assert.equal(response.stopReason, "cancelled");
    assert.ok(updates.length >= 1, "expected at least one chunk before cancellation");
  } finally {
    connection.dispose();
  }
});

test("4) crash: process exit rejects the pending prompt and emits processExit", async () => {
  const connection = createConnection();
  try {
    await connection.ensureInitialized();
    const session = await connection.newSession(process.cwd());
    const promptRejection = assert.rejects(
      connection.prompt(session.sessionId, "crash now"),
      /agent process exited/,
    );
    const exitCode = await waitForProcessExit(connection);
    assert.equal(exitCode, 1);
    await promptRejection;
  } finally {
    connection.dispose();
  }
});

test("5) permission: injected handler is consulted; selected lets the agent continue", async () => {
  const received: AcpPermissionRequest[] = [];
  const connection = createConnection({
    permissionHandler: async (request) => {
      received.push(request);
      return { updates: [{ toolCallId: request.toolCallId ?? "", outcome: "selected" }] };
    },
  });
  try {
    await connection.ensureInitialized();
    const session = await connection.newSession(process.cwd());
    const updates = collectUpdates(connection);
    const response = await connection.prompt(session.sessionId, "needs permission");
    assert.equal(received.length, 1);
    assert.equal(received[0].sessionId, session.sessionId);
    assert.equal(received[0].toolCallId, "perm-1");
    assert.deepEqual(
      received[0].options.map((option) => option.kind),
      ["allow_once", "allow_always", "reject_once"],
    );
    assert.equal(response.stopReason, "end_turn");
    assert.equal(updates.map(textOf).join(""), "granted:allow_once");
  } finally {
    connection.dispose();
  }
});

test("5b) permission: a throwing handler rejects all options and the agent sees a denial", async () => {
  const connection = createConnection({
    permissionHandler: async () => {
      throw new Error("approval UI unavailable");
    },
  });
  try {
    await connection.ensureInitialized();
    const session = await connection.newSession(process.cwd());
    const updates = collectUpdates(connection);
    const response = await connection.prompt(session.sessionId, "needs permission");
    assert.equal(response.stopReason, "end_turn");
    assert.equal(updates.map(textOf).join(""), "denied:reject_once");
  } finally {
    connection.dispose();
  }
});

test("5c) permission: a reject-kind selection answers with the reject option", async () => {
  const connection = createConnection({
    permissionHandler: async (request) => ({
      updates: computePermissionOutcomes(request.options, request.toolCallId ?? "", "reject_once"),
    }),
  });
  try {
    await connection.ensureInitialized();
    const session = await connection.newSession(process.cwd());
    const updates = collectUpdates(connection);
    const response = await connection.prompt(session.sessionId, "needs permission");
    assert.equal(response.stopReason, "end_turn");
    assert.equal(updates.map(textOf).join(""), "denied:reject_once");
  } finally {
    connection.dispose();
  }
});

test("5d) permission: an allow_always selection answers with the allow_always option", async () => {
  const connection = createConnection({
    permissionHandler: async (request) => ({
      updates: computePermissionOutcomes(request.options, request.toolCallId ?? "", "allow_always"),
    }),
  });
  try {
    await connection.ensureInitialized();
    const session = await connection.newSession(process.cwd());
    const updates = collectUpdates(connection);
    const response = await connection.prompt(session.sessionId, "needs permission");
    assert.equal(response.stopReason, "end_turn");
    assert.equal(updates.map(textOf).join(""), "granted:allow_always");
  } finally {
    connection.dispose();
  }
});

test("6) initialize timeout rejects and kills the agent process", async () => {
  const connection = createConnection({ initializeTimeoutMs: 300 }, { MOCK_STALL_INIT: "true" });
  try {
    const rejection = assert.rejects(connection.ensureInitialized(), /timed out after 300ms/);
    const exitCode = await waitForProcessExit(connection);
    assert.ok(exitCode === 1 || exitCode === null, `unexpected exit code ${exitCode}`);
    await rejection;
  } finally {
    connection.dispose();
  }
});

test("7) readfile: fileReadHandler serves fs/read_text_file and the content flows back", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-readfile-"));
  const expected = "hello from test.txt\nline two";
  fs.writeFileSync(path.join(tempDir, "test.txt"), expected);
  const readPaths: string[] = [];
  try {
    const connection = createConnection(
      {
        fileReadHandler: async (params) => {
          readPaths.push(params.path);
          return await fs.promises.readFile(params.path, "utf8");
        },
      },
      { MOCK_FS: "true" },
    );
    try {
      const init = await connection.ensureInitialized();
      const promptCapabilities = init.agentCapabilities?.promptCapabilities as
        | { fsReadTextFile?: boolean }
        | undefined;
      assert.equal(promptCapabilities?.fsReadTextFile, true);
      const session = await connection.newSession(tempDir);
      const updates = collectUpdates(connection);
      const response = await connection.prompt(session.sessionId, "do the readfile");
      assert.equal(response.stopReason, "end_turn");
      assert.equal(readPaths.length, 1);
      assert.equal(readPaths[0], path.join(tempDir, "test.txt"));
      assert.equal(updates.map(textOf).join(""), expected);
    } finally {
      connection.dispose();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("7b) readfile: an AcpJsonRpcError thrown by the handler is passed through to the agent", async () => {
  const connection = createConnection(
    {
      fileReadHandler: async () => {
        throw new AcpJsonRpcError(ACP_ERROR_CODES.CUSTOM, "path is outside the workspace");
      },
    },
    { MOCK_FS: "true" },
  );
  try {
    await connection.ensureInitialized();
    const session = await connection.newSession(process.cwd());
    const updates = collectUpdates(connection);
    const response = await connection.prompt(session.sessionId, "do the readfile");
    assert.equal(response.stopReason, "end_turn");
    assert.match(updates.map(textOf).join(""), /readfile failed: path is outside the workspace/);
  } finally {
    connection.dispose();
  }
});

test("8) loadSession replays stored updates through the sessionUpdate event", async () => {
  const connection = createConnection();
  try {
    await connection.ensureInitialized();
    const session = await connection.newSession(process.cwd());
    await connection.prompt(session.sessionId, "hello there");

    const replayed = collectUpdates(connection);
    const response = await connection.loadSession(session.sessionId, process.cwd());
    assert.ok(typeof response === "object");
    assert.ok(replayed.length >= 3, `expected >= 3 replayed updates, got ${replayed.length}`);
    assert.equal(replayed.map(textOf).join(""), "Hello from mock.");

    // The session remains usable after being loaded.
    const followUp = await connection.prompt(session.sessionId, "hello again");
    assert.equal(followUp.stopReason, "end_turn");
  } finally {
    connection.dispose();
  }
});

test("9) raw protocol over real stdio: initialize, -32601 for unknown methods, default prompt", async () => {
  const agent = spawnMockAgent();
  try {
    const init = await agent.sendRequest("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "raw-test", version: "0.0.0" },
    });
    assert.equal(init.agentCapabilities.loadSession, true);
    assert.equal(init.agentInfo.name, "mock-agent");

    await assert.rejects(
      agent.sendRequest("foo/bar", {}),
      (error: Error & { code?: number }) => error.code === -32601,
    );

    const session = await agent.sendRequest("session/new", { cwd: process.cwd(), mcpServers: [] });
    assert.equal(session.sessionId, "mock-session-1");

    const updates: any[] = [];
    const promptPromise = agent.sendRequest("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "raw hello" }],
    });
    for (let i = 0; i < 3; i++) {
      const notification = await agent.waitForNotification("session/update");
      updates.push(notification.params.update);
    }
    const response = await promptPromise;
    assert.equal(response.stopReason, "end_turn");
    assert.equal(updates.map((update) => update.content.text).join(""), "Hello from mock.");

    // nextMessage observes any incoming message; here the response to a
    // second session/new (it has an id but no method).
    const secondSessionRequest = agent.sendRequest("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const message = await agent.nextMessage();
    assert.equal(message.method, undefined);
    assert.ok("id" in message);
    const secondSession = await secondSessionRequest;
    assert.equal(secondSession.sessionId, "mock-session-2");
  } finally {
    agent.process.kill();
  }
});

test("10) raw protocol: cancel notification stops the prompt turn", async () => {
  const agent = spawnMockAgent();
  try {
    await agent.sendRequest("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.sendRequest("session/new", { cwd: process.cwd(), mcpServers: [] });
    const promptPromise = agent.sendRequest("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "cancel me" }],
    });
    await agent.waitForNotification("session/update");
    agent.sendNotification("session/cancel", { sessionId: session.sessionId });
    const response = await promptPromise;
    assert.equal(response.stopReason, "cancelled");
  } finally {
    agent.process.kill();
  }
});

test("11) newSession captures the agent's models state and emits optionsChanged", async () => {
  const connection = createConnection();
  try {
    await connection.ensureInitialized();
    assert.equal(connection.getSupportedModelState(), null);
    const events: unknown[] = [];
    connection.on("optionsChanged", (payload: unknown) => events.push(payload));
    const session = await connection.newSession(process.cwd());
    assert.equal(session.sessionId, "mock-session-1");

    const state = connection.getSupportedModelState();
    assert.ok(state, "expected a models state after session/new");
    assert.equal(state.currentModelId, "mock-fast");
    assert.deepEqual(
      state.availableModels.map((model) => model.modelId),
      ["mock-fast", "mock-smart"],
    );
    assert.equal(state.availableModels[0].name, "Mock Fast");
    assert.equal(state.availableModels[1].name, "Mock Smart");

    assert.equal(events.length, 1);
    assert.equal(events[0], state);
  } finally {
    connection.dispose();
  }
});

test("12) loadSession refreshes the models state and re-emits optionsChanged", async () => {
  const connection = createConnection();
  try {
    await connection.ensureInitialized();
    const session = await connection.newSession(process.cwd());
    const events: unknown[] = [];
    connection.on("optionsChanged", (payload: unknown) => events.push(payload));

    await connection.loadSession(session.sessionId, process.cwd());

    const state = connection.getSupportedModelState();
    assert.ok(state, "expected a models state after session/load");
    assert.equal(state.availableModels.length, 2);
    assert.equal(state.currentModelId, "mock-fast");
    assert.equal(events.length, 1);
    assert.equal(events[0], state);
  } finally {
    connection.dispose();
  }
});

test("13) process exit clears the cached models state", async () => {
  const connection = createConnection();
  try {
    await connection.ensureInitialized();
    const session = await connection.newSession(process.cwd());
    assert.ok(connection.getSupportedModelState());
    const promptRejection = assert.rejects(
      connection.prompt(session.sessionId, "crash now"),
      /agent process exited/,
    );
    await waitForProcessExit(connection);
    await promptRejection;
    assert.equal(connection.getSupportedModelState(), null);
  } finally {
    connection.dispose();
  }
});
