#!/usr/bin/env node
/**
 * Orchestratable mock ACP agent.
 *
 * Speaks ndjson JSON-RPC 2.0 over stdio with no external dependencies.
 * Behavior is controlled by prompt keywords and/or environment variables:
 *
 *   - default:            3 agent_message_chunk ("Hello ", "from ", "mock.") then end_turn
 *   - prompt contains "tool":        tool_call (in_progress) -> tool_call_update (completed) -> 2 chunks -> end_turn
 *   - prompt contains "permission":  session/request_permission request; "granted:<optionId>"/"denied:<optionId>" chunk based on the outcome
 *   - prompt contains "cancel":      streams chunks until session/cancel, then resolves stopReason "cancelled"
 *   - prompt contains "crash":       process.exit(1)
 *   - prompt contains "readfile":    fs/read_text_file request for <cwd>/test.txt, content sent back as a chunk
 *   - prompt contains "slow":        delays the response by 500ms before the default behavior
 *
 * Environment variables:
 *   MOCK_SCENARIO     force a scenario regardless of the prompt text
 *   MOCK_FS           "true" -> advertise promptCapabilities.fsReadTextFile
 *   MOCK_STALL_INIT   "true" -> delay the initialize response by 10s (timeout testing)
 */

import { createInterface } from "node:readline";
import { join } from "node:path";

const SLOW_DELAY_MS = 500;
const STALL_INIT_MS = 10_000;
const CANCEL_CHUNK_INTERVAL_MS = 20;

const sessionCwds = new Map();
const sessionHistory = new Map();
const cancelledSessions = new Set();
const pendingClientRequests = new Map();
let nextRequestId = 1;
let nextSessionNumber = 0;

/** UNSTABLE `models` state advertised by session/new and session/load. */
const MODEL_STATE = {
  availableModels: [
    { modelId: "mock-fast", name: "Mock Fast" },
    { modelId: "mock-smart", name: "Mock Smart", description: "Slower but smarter" },
  ],
  currentModelId: "mock-fast",
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function debug(...args) {
  process.stderr.write(`[mock-agent] ${args.join(" ")}\n`);
}

function respondResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Sends a request to the client and awaits its response. */
function requestClient(method, params) {
  const id = `agent-req-${nextRequestId++}`;
  return new Promise((resolve, reject) => {
    pendingClientRequests.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function notifySessionUpdate(sessionId, update) {
  const history = sessionHistory.get(sessionId);
  if (history) {
    history.push(update);
  }
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

function agentMessageChunk(text) {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

function extractPromptText(promptBlocks) {
  return (promptBlocks ?? [])
    .map((block) => (block && block.type === "text" ? block.text : ""))
    .join(" ");
}

function detectScenario(text) {
  const forced = process.env.MOCK_SCENARIO;
  const source = forced ? String(forced) : text;
  for (const scenario of ["crash", "permission", "readfile", "tool", "cancel", "slow"]) {
    if (source.includes(scenario)) {
      return scenario;
    }
  }
  return "default";
}

async function handlePrompt(id, params) {
  const sessionId = params.sessionId;
  const text = extractPromptText(params.prompt);
  const scenario = detectScenario(text);
  debug(`session/prompt ${sessionId}: scenario=${scenario} text=${JSON.stringify(text)}`);

  if (scenario === "crash") {
    debug("crashing by request");
    process.exit(1);
  }

  if (scenario === "slow") {
    await delay(SLOW_DELAY_MS);
  }

  if (scenario === "permission") {
    let response;
    try {
      response = await requestClient("session/request_permission", {
        sessionId,
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
        toolCall: { toolCallId: "perm-1", title: "Mock permission tool", status: "pending" },
      });
    } catch (error) {
      notifySessionUpdate(sessionId, agentMessageChunk(`permission failed: ${error?.message ?? String(error)}`));
      respondResult(id, { stopReason: "end_turn" });
      return;
    }
    const outcome = response?.outcome;
    const granted =
      outcome?.outcome === "selected" && String(outcome.optionId ?? "").startsWith("allow");
    // Echo the outcome so tests can assert which option the client picked.
    const optionId = outcome?.outcome === "selected" ? String(outcome.optionId ?? "-") : "-";
    notifySessionUpdate(sessionId, agentMessageChunk(`${granted ? "granted" : "denied"}:${optionId}`));
    respondResult(id, { stopReason: "end_turn" });
    return;
  }

  if (scenario === "readfile") {
    const cwd = sessionCwds.get(sessionId) ?? process.cwd();
    try {
      const response = await requestClient("fs/read_text_file", {
        sessionId,
        path: join(cwd, "test.txt"),
      });
      notifySessionUpdate(sessionId, agentMessageChunk(String(response?.content ?? "")));
    } catch (error) {
      notifySessionUpdate(
        sessionId,
        agentMessageChunk(`readfile failed: ${error?.message ?? String(error)}`),
      );
    }
    respondResult(id, { stopReason: "end_turn" });
    return;
  }

  if (scenario === "tool") {
    notifySessionUpdate(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Echo tool",
      status: "in_progress",
    });
    notifySessionUpdate(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
    });
    notifySessionUpdate(sessionId, agentMessageChunk("Tool "));
    notifySessionUpdate(sessionId, agentMessageChunk("done."));
    respondResult(id, { stopReason: "end_turn" });
    return;
  }

  if (scenario === "cancel") {
    let index = 0;
    while (!cancelledSessions.has(sessionId)) {
      notifySessionUpdate(sessionId, agentMessageChunk(`chunk-${index++} `));
      await delay(CANCEL_CHUNK_INTERVAL_MS);
    }
    respondResult(id, { stopReason: "cancelled" });
    return;
  }

  notifySessionUpdate(sessionId, agentMessageChunk("Hello "));
  notifySessionUpdate(sessionId, agentMessageChunk("from "));
  notifySessionUpdate(sessionId, agentMessageChunk("mock."));
  respondResult(id, { stopReason: "end_turn" });
}

async function handleRequest(message) {
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize": {
      const respond = () =>
        respondResult(id, {
          protocolVersion: params.protocolVersion,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { fsReadTextFile: process.env.MOCK_FS === "true" },
          },
          agentInfo: { name: "mock-agent", version: "0.1.0" },
        });
      if (process.env.MOCK_STALL_INIT === "true") {
        debug("stalling initialize response");
        setTimeout(respond, STALL_INIT_MS);
      } else {
        respond();
      }
      return;
    }
    case "session/new": {
      const sessionId = `mock-session-${++nextSessionNumber}`;
      sessionCwds.set(sessionId, params.cwd);
      sessionHistory.set(sessionId, []);
      respondResult(id, { sessionId, models: MODEL_STATE });
      return;
    }
    case "session/load": {
      const updates = sessionHistory.get(params.sessionId) ?? [];
      for (const update of updates) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: params.sessionId, update },
        });
      }
      respondResult(id, { models: MODEL_STATE });
      return;
    }
    case "session/prompt": {
      await handlePrompt(id, params);
      return;
    }
    default:
      // Includes fs/read_text_file / fs/write_text_file arriving in the
      // wrong direction: this mock only ever sends those, never serves them.
      debug(`method not found: ${method}`);
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

function handleNotification(message) {
  if (message.method === "session/cancel") {
    cancelledSessions.add(message.params?.sessionId);
    debug(`cancel requested for ${message.params?.sessionId}`);
    return;
  }
  debug(`ignoring notification: ${message.method}`);
}

function handleResponse(message) {
  const pending = pendingClientRequests.get(message.id);
  if (!pending) {
    debug(`got response for unknown request id: ${message.id}`);
    return;
  }
  pendingClientRequests.delete(message.id);
  if ("error" in message) {
    pending.reject(
      Object.assign(new Error(message.error?.message ?? "client request failed"), {
        code: message.error?.code,
      }),
    );
  } else {
    pending.resolve(message.result);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    debug(`failed to parse line (${error?.message ?? error}): ${trimmed.slice(0, 120)}`);
    return;
  }
  debug(`received: ${message.method ?? `response#${message.id}`}`);
  if ("id" in message && "method" in message) {
    handleRequest(message).catch((error) => {
      debug(`error handling ${message.method}: ${error?.message ?? String(error)}`);
      respondError(message.id, -32603, "Internal error");
    });
  } else if ("method" in message) {
    handleNotification(message);
  } else if ("id" in message) {
    handleResponse(message);
  } else {
    debug("unrecognized message");
  }
});
rl.on("close", () => {
  debug("stdin closed, exiting");
  process.exit(0);
});
