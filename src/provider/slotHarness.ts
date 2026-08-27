import * as vscode from "vscode";
import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { AcpAgentConnection } from "../acp/agentConnection";
import type { AcpLogFn } from "../acp/types";
import type { AgentConfig, AgentSlot } from "../config";
import { parseSessionResource } from "../config";
import type { StoredSession, StoredToolCall, StoredTurn } from "../sessionStore";
import { SessionStore } from "../sessionStore";
import { createWorkspaceFileHandlers } from "./filesystem";
import type { AcpLanguageModelProvider } from "./languageModelProvider";
import { createPermissionHandler } from "./permissions";
import { extractChunkText, renderStoredTurn, TurnAccumulator } from "./render";

const TITLE_MAX_LENGTH = 60;
const TOOL_ERROR_SUMMARY_MAX_LENGTH = 200;

/** Outcome of a completed prompt turn. */
export interface TurnOutcome {
  stopReason: string;
  error?: string;
}

interface ActiveTurn {
  accumulator: TurnAccumulator;
  done: Promise<TurnOutcome>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= TITLE_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}

function summarizeToolContent(content: string | undefined): string | undefined {
  const text = content?.trim();
  if (!text) {
    return undefined;
  }
  const firstLine = text.split(/\r?\n/)[0];
  if (firstLine.length <= TOOL_ERROR_SUMMARY_MAX_LENGTH) {
    return firstLine;
  }
  return `${firstLine.slice(0, TOOL_ERROR_SUMMARY_MAX_LENGTH - 3)}...`;
}

/**
 * Per-slot integration harness aggregating everything one configured agent
 * slot needs: a lazily created {@link AcpAgentConnection} (shared by all chat
 * sessions of the slot), the {@link SessionStore} reference and the mapping
 * between VS Code chat session URIs and ACP session ids.
 *
 * Process lifetime: the agent process is spawned on first use and disposed
 * when the last active chat session of the slot is closed (reference
 * counting). A generation counter tracks process restarts so a stale session
 * is re-attached through `session/load` when the agent supports it.
 */
export class SlotHarness implements vscode.Disposable {
  readonly slot: AgentSlot;

  private connection: AcpAgentConnection | null = null;
  /** Bumped whenever the backing agent process exits or is disposed. */
  private generation = 0;
  /** Latest known `loadSession` capability of the agent (undefined = unknown). */
  private lastKnownLoadSession: boolean | undefined;
  /** vscode chat session uri (string form) → ACP session + its generation. */
  private readonly activeChatSessions = new Map<string, { sessionId: string; generation: number }>();
  /** ACP session id → generation of the process that knows the session. */
  private readonly sessionGenerations = new Map<string, number>();
  /** Turns currently in flight, keyed by ACP session id. */
  private readonly turnStates = new Map<string, ActiveTurn>();
  private readonly onDidSessionsChangeEmitter = new vscode.EventEmitter<void>();
  private disposed = false;

  constructor(
    slot: AgentSlot,
    private readonly cfg: AgentConfig,
    private readonly store: SessionStore,
    private readonly channel: vscode.LogOutputChannel,
    private readonly lmProvider?: AcpLanguageModelProvider,
  ) {
    this.slot = slot;
  }

  /** Fired whenever the stored session list / metadata changed. */
  readonly onDidSessionsChange: vscode.Event<void> = this.onDidSessionsChangeEmitter.event;

  /**
   * Whether stored sessions of this slot should be listed as restorable
   * chat sessions. An unknown capability (agent not spawned yet) lists them;
   * once the agent is known not to declare `loadSession` they stay hidden.
   */
  shouldListStoredSessions(): boolean {
    return this.lastKnownLoadSession !== false;
  }

  /**
   * Resolves the ACP session id to use for the given VS Code chat session:
   *
   * 1. an in-memory mapping whose process generation still matches is reused;
   * 2. a stored session addressed by the URI is resumed via `session/load`
   *    when the agent supports it (replayed updates are ignored — the local
   *    turn log is the source of truth for history);
   * 3. otherwise a new `session/new` is issued and persisted.
   */
  async ensureSessionId(
    chatUri: vscode.Uri | undefined,
    firstPrompt: string,
  ): Promise<{ sessionId: string; isNew: boolean }> {
    this.assertLive();

    if (chatUri !== undefined) {
      const active = this.activeChatSessions.get(chatUri.toString());
      if (active && active.generation === this.generation) {
        return { sessionId: active.sessionId, isNew: false };
      }
    }

    if (chatUri !== undefined) {
      const parsed = parseSessionResource(chatUri);
      if (parsed && parsed.slot === this.slot && this.findStoredSession(parsed.sessionId)) {
        const resumed = await this.resumeStoredSession(parsed.sessionId);
        if (resumed !== undefined) {
          this.activeChatSessions.set(chatUri.toString(), {
            sessionId: resumed,
            generation: this.generation,
          });
          return { sessionId: resumed, isNew: false };
        }
        // Agent cannot re-attach (no loadSession capability or load failed):
        // fall through and start a fresh session.
      }
    }

    const sessionId = await this.createNewSession(firstPrompt);
    if (chatUri !== undefined) {
      this.activeChatSessions.set(chatUri.toString(), {
        sessionId,
        generation: this.generation,
      });
    }
    return { sessionId, isNew: true };
  }

  /**
   * Runs one prompt turn: subscribes to session updates (feeding both the
   * {@link TurnAccumulator} and the live stream), forwards cancellation to
   * `session/cancel`, and persists the finished turn in the store.
   */
  async runTurn(
    sessionId: string,
    prompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<TurnOutcome> {
    this.assertLive();
    const connection = this.ensureConnection();
    const accumulator = new TurnAccumulator();
    const startedAt = Date.now();

    const onUpdate = (notification: SessionNotification): void => {
      if (notification.sessionId !== sessionId) {
        return;
      }
      accumulator.apply(notification.update);
      try {
        this.renderUpdate(notification.update, accumulator, stream);
      } catch (error) {
        this.channel.warn(
          `[acp:${this.slot}] failed to render session update: ${errorMessage(error)}`,
        );
      }
    };
    connection.on("sessionUpdate", onUpdate);

    const cancelSubscription = token.onCancellationRequested(() => {
      void connection.cancel(sessionId);
    });

    const done: Promise<TurnOutcome> = connection.prompt(sessionId, prompt).then(
      (response) => ({ stopReason: response.stopReason }),
      (error) => ({ stopReason: "aborted", error: errorMessage(error) }),
    );

    this.turnStates.set(sessionId, { accumulator, done });

    const outcome = await done;

    connection.off("sessionUpdate", onUpdate);
    cancelSubscription.dispose();
    this.turnStates.delete(sessionId);
    this.persistTurn(sessionId, prompt, accumulator, outcome, startedAt);

    return outcome;
  }

  /**
   * Snapshot of a turn currently in flight for `sessionId`, used by the chat
   * session content provider's active response callback. Returns `undefined`
   * when no turn is running.
   */
  resumeActive(sessionId: string): { snapshotMarkdown: string; done: Promise<void> } | undefined {
    const active = this.turnStates.get(sessionId);
    if (!active) {
      return undefined;
    }
    const snapshot: StoredTurn = {
      prompt: "",
      responseMarkdown: active.accumulator.markdown,
      thoughts:
        active.accumulator.thoughts.length > 0 ? active.accumulator.thoughts : undefined,
      tools: active.accumulator.tools.map((tool): StoredToolCall => ({ ...tool })),
      stopReason: "end_turn",
      startedAt: 0,
      endedAt: 0,
    };
    return {
      snapshotMarkdown: renderStoredTurn(snapshot),
      done: active.done.then(() => undefined),
    };
  }

  /**
   * Drops the chat-session → ACP-session mapping and disposes the agent
   * process once the slot has no remaining active chat sessions.
   */
  releaseChatSession(chatUri: vscode.Uri): void {
    this.activeChatSessions.delete(chatUri.toString());
    if (this.activeChatSessions.size === 0) {
      this.disposeConnection("last active chat session closed");
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeConnection("harness disposed");
    this.activeChatSessions.clear();
    this.sessionGenerations.clear();
    this.turnStates.clear();
    this.onDidSessionsChangeEmitter.dispose();
  }

  // ---- internals ---------------------------------------------------------

  private assertLive(): void {
    if (this.disposed) {
      throw new Error(`[acp:${this.slot}] slot harness has been disposed`);
    }
  }

  private ensureConnection(): AcpAgentConnection {
    if (this.disposed) {
      throw new Error(`[acp:${this.slot}] slot harness has been disposed`);
    }
    if (!this.connection) {
      const { fileReadHandler, fileWriteHandler } = createWorkspaceFileHandlers(this.channel);
      const log: AcpLogFn = (level, msg, data) => {
        if (data === undefined) {
          this.channel[level](msg);
        } else {
          this.channel[level](msg, data);
        }
      };
      const connection = new AcpAgentConnection(
        this.slot,
        {
          command: this.cfg.command,
          args: this.cfg.args,
          cwd: this.cfg.cwd,
          env: this.cfg.env,
        },
        {
          log,
          permissionHandler: createPermissionHandler(this.channel),
          fileReadHandler,
          fileWriteHandler,
        },
      );
      // Any session created by the previous process is stale now; a later
      // ensureSessionId tries session/load before reusing it.
      connection.on("processExit", () => {
        this.generation++;
      });
      // The agent advertised its (UNSTABLE) models state with the next
      // session/new / session/load response: push it into the language model
      // provider so the model picker follows the agent.
      connection.on("optionsChanged", () => {
        this.lmProvider?.updateModels(connection.getSupportedModelState()?.availableModels);
      });
      this.connection = connection;
      this.channel.info(
        `[acp:${this.slot}] agent connection created for "${this.cfg.command} ${this.cfg.args.join(" ")}"`,
      );
    }
    return this.connection;
  }

  private sessionCwd(): string {
    return this.cfg.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private findStoredSession(sessionId: string): StoredSession | undefined {
    return this.store.listSessions(this.slot).find((session) => session.sessionId === sessionId);
  }

  /**
   * Re-attaches a stored session to the current agent process. Returns the
   * session id on success, or undefined when the agent cannot resume it.
   */
  private async resumeStoredSession(sessionId: string): Promise<string | undefined> {
    const connection = this.ensureConnection();
    let init;
    try {
      init = await connection.ensureInitialized();
    } catch (error) {
      this.channel.warn(
        `[acp:${this.slot}] agent initialization failed while resuming session ${sessionId}: ${errorMessage(error)}`,
      );
      return undefined;
    }
    this.lastKnownLoadSession = init.agentCapabilities?.loadSession === true;
    if (!this.lastKnownLoadSession) {
      return undefined;
    }
    if (this.sessionGenerations.get(sessionId) === this.generation) {
      return sessionId;
    }
    try {
      await connection.loadSession(sessionId, this.sessionCwd());
      // Replayed session/update notifications are ignored on purpose: the
      // persisted turn log in the SessionStore is the source of truth.
      this.sessionGenerations.set(sessionId, this.generation);
      this.channel.info(`[acp:${this.slot}] resumed session ${sessionId} via session/load`);
      return sessionId;
    } catch (error) {
      this.channel.warn(
        `[acp:${this.slot}] session/load failed for ${sessionId}: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  private async createNewSession(firstPrompt: string): Promise<string> {
    const connection = this.ensureConnection();
    const response = await connection.newSession(this.sessionCwd());
    this.lastKnownLoadSession =
      connection.getInitializeResponse()?.agentCapabilities?.loadSession === true;
    const sessionId = response.sessionId;
    const now = Date.now();
    this.store.saveSession({
      sessionId,
      slot: this.slot,
      title: truncateTitle(firstPrompt),
      created: now,
      lastActive: now,
    });
    this.sessionGenerations.set(sessionId, this.generation);
    this.onDidSessionsChangeEmitter.fire();
    return sessionId;
  }

  private persistTurn(
    sessionId: string,
    prompt: string,
    accumulator: TurnAccumulator,
    outcome: TurnOutcome,
    startedAt: number,
  ): void {
    const endedAt = Date.now();
    const thoughts = accumulator.thoughts;
    this.store.appendTurn(this.slot, sessionId, {
      prompt,
      responseMarkdown: accumulator.markdown,
      thoughts: thoughts.length > 0 ? thoughts : undefined,
      tools: accumulator.tools.map((tool): StoredToolCall => ({ ...tool })),
      stopReason: outcome.stopReason,
      error: outcome.error,
      startedAt,
      endedAt,
    });

    const session = this.findStoredSession(sessionId);
    if (session) {
      const updated: StoredSession = { ...session, lastActive: endedAt };
      if (updated.title.length === 0 || updated.title === this.slot) {
        updated.title = truncateTitle(prompt);
      }
      this.store.saveSession(updated);
    }

    this.onDidSessionsChangeEmitter.fire();
  }

  // ---- live rendering ----------------------------------------------------

  private renderUpdate(
    update: SessionUpdate,
    accumulator: TurnAccumulator,
    stream: vscode.ChatResponseStream,
  ): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = extractChunkText(update.content);
        if (text.length > 0) {
          stream.markdown(text);
        }
        break;
      }
      case "agent_thought_chunk": {
        const text = extractChunkText(update.content);
        if (text.trim().length > 0) {
          stream.markdown(`> ${text.replace(/\n/g, "\n> ")}\n\n`);
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        this.renderToolCall(update, accumulator, stream);
        break;
      }
      case "plan": {
        const entries = accumulator.plan;
        if (entries.length > 0) {
          const lines = entries.map(
            (entry) => `- [${entry.status === "completed" ? "x" : " "}] ${entry.content}`,
          );
          stream.markdown(`**Plan**\n\n${lines.join("\n")}\n\n`);
        }
        break;
      }
      case "usage_update": {
        const usageText = accumulator.usageText;
        if (usageText !== undefined) {
          stream.markdown(`\n\n_${usageText}_`);
        }
        break;
      }
      default:
        // user_message_chunk and other update types are not rendered live.
        break;
    }
  }

  private renderToolCall(
    update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
    accumulator: TurnAccumulator,
    stream: vscode.ChatResponseStream,
  ): void {
    const toolCallId = update.toolCallId;
    if (!toolCallId) {
      return;
    }
    const title =
      update.title && update.title.length > 0
        ? update.title
        : update.kind && update.kind.length > 0
          ? update.kind
          : "Tool";

    let errorSummary: string | undefined;
    if (update.status === "failed") {
      const stored = accumulator.tools.find((tool) => tool.toolCallId === toolCallId);
      errorSummary = summarizeToolContent(stored?.content);
    }

    const part = new vscode.ChatToolInvocationPart(title, toolCallId, errorSummary);
    part.invocationMessage = title;
    part.enablePartialUpdate = true;
    if (update.status === "completed" || update.status === "failed") {
      part.isComplete = true;
      part.isError = update.status === "failed";
    }
    // Updates for tool call ids never seen before are pushed as well; VS Code
    // merges parts by toolCallId.
    stream.push(part);
  }

  private disposeConnection(reason: string): void {
    const connection = this.connection;
    if (!connection) {
      return;
    }
    this.connection = null;
    this.generation++;
    this.channel.info(`[acp:${this.slot}] disposing agent connection (${reason})`);
    connection.dispose();
  }
}
