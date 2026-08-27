import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const AGENT_SCRIPT_PATH = fileURLToPath(new URL("../mock-agent/agent.mjs", import.meta.url));
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Spawns the mock ACP agent and returns helpers for speaking raw ndjson
 * JSON-RPC 2.0 over its real stdio.
 *
 * @param {Record<string, string>} [env] extra environment variables for the agent process
 * @returns {{
 *   process: import("node:child_process").ChildProcess,
 *   sendRequest: (method: string, params?: unknown) => Promise<any>,
 *   sendNotification: (method: string, params?: unknown) => void,
 *   waitForNotification: (matcher: string | ((message: any) => boolean), timeoutMs?: number) => Promise<any>,
 *   nextMessage: (timeoutMs?: number) => Promise<any>,
 * }}
 */
export function spawnMockAgent(env = {}) {
  const agent = spawn(process.execPath, [AGENT_SCRIPT_PATH], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const pendingRequests = new Map();
  // Unmatched notifications are buffered so that several notifications
  // arriving in a single stdout chunk between two awaits are not lost.
  const notificationQueue = [];
  const notificationWaiters = [];
  const messageQueue = [];
  const nextMessageWaiters = [];
  let nextRequestId = 1;
  let buffer = "";

  function dispatch(message) {
    // Response to a request we sent.
    if (!("method" in message) && "id" in message) {
      const pending = pendingRequests.get(message.id);
      if (pending) {
        pendingRequests.delete(message.id);
        if ("error" in message) {
          pending.reject(
            Object.assign(new Error(message.error?.message ?? "request failed"), {
              code: message.error?.code,
            }),
          );
        } else {
          pending.resolve(message.result);
        }
      }
    }

    // Notification from the agent (no request id): hand it to a matching
    // waiter, otherwise buffer it for a later waitForNotification call.
    if ("method" in message && !("id" in message)) {
      const index = notificationWaiters.findIndex((waiter) => waiter.matches(message));
      if (index >= 0) {
        const waiter = notificationWaiters.splice(index, 1)[0];
        waiter.resolve(message);
      } else {
        notificationQueue.push(message);
      }
    }

    // FIFO feed for nextMessage().
    if (nextMessageWaiters.length > 0) {
      nextMessageWaiters.shift().resolve(message);
    } else {
      messageQueue.push(message);
    }
  }

  agent.stdout.setEncoding("utf8");
  agent.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          dispatch(JSON.parse(line));
        } catch {
          process.stderr.write(`[spawnMockAgent] malformed ndjson line: ${line}\n`);
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });

  function write(message) {
    agent.stdin.write(JSON.stringify(message) + "\n");
  }

  function sendRequest(method, params) {
    const id = `client-req-${nextRequestId++}`;
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      write({ jsonrpc: "2.0", id, method, params });
      const timer = setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`mock agent request "${method}" timed out`));
        }
      }, DEFAULT_TIMEOUT_MS);
      timer.unref?.();
    });
  }

  function sendNotification(method, params) {
    write({ jsonrpc: "2.0", method, params });
  }

  /**
   * Waits for the next agent notification matching `matcher`, which is
   * either a method name or a predicate over the raw message. Buffered
   * notifications are matched first.
   */
  function waitForNotification(matcher, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const matches =
      typeof matcher === "function" ? matcher : (message) => message.method === matcher;

    const bufferedIndex = notificationQueue.findIndex((message) => matches(message));
    if (bufferedIndex >= 0) {
      return Promise.resolve(notificationQueue.splice(bufferedIndex, 1)[0]);
    }

    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve };
      notificationWaiters.push(waiter);
      const timer = setTimeout(() => {
        const index = notificationWaiters.indexOf(waiter);
        if (index >= 0) {
          notificationWaiters.splice(index, 1);
          reject(new Error("timed out waiting for mock agent notification"));
        }
      }, timeoutMs);
      timer.unref?.();
    });
  }

  /** Resolves with the next message of any kind (request/notification/response). */
  function nextMessage(timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (messageQueue.length > 0) {
      return Promise.resolve(messageQueue.shift());
    }
    return new Promise((resolve, reject) => {
      nextMessageWaiters.push(resolve);
      const timer = setTimeout(() => {
        const index = nextMessageWaiters.indexOf(resolve);
        if (index >= 0) {
          nextMessageWaiters.splice(index, 1);
          reject(new Error("timed out waiting for next mock agent message"));
        }
      }, timeoutMs);
      timer.unref?.();
    });
  }

  return { process: agent, sendRequest, sendNotification, waitForNotification, nextMessage };
}
