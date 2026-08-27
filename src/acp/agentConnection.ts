import { EventEmitter } from "node:events";
import { spawn as spawnProcess } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type {
  Client,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionModelState,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { spawnAgentProcess } from "./agentProcess";
import type {
  AgentProcessConfig,
  AcpLogFn,
  AcpPermissionResponse,
  AcpPermissionUpdate,
  FileReadHandler,
  FileWriteHandler,
  PermissionHandler,
} from "./types";
import { ACP_ERROR_CODES } from "./types";

const CLIENT_INFO = { name: "acp-agent-harness", version: "0.1.0" } as const;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;

/**
 * JSON-RPC error with a protocol error code. Extends the SDK's
 * `RequestError`, so errors thrown by injected handlers are passed through
 * to the agent with their original code.
 */
export class AcpJsonRpcError extends RequestError {
  constructor(code: number, message: string, data?: unknown) {
    super(code, message, data);
    this.name = "AcpJsonRpcError";
  }
}

export interface AcpAgentConnectionDeps {
  log: AcpLogFn;
  permissionHandler: PermissionHandler;
  fileReadHandler?: FileReadHandler;
  fileWriteHandler?: FileWriteHandler;
  initializeTimeoutMs?: number;
}

interface PendingRequest {
  label: string;
  reject: (error: Error) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The SDK rejects agent error responses with plain `{code, message, data}`
 * objects rather than `Error` instances; normalize those into
 * {@link AcpJsonRpcError} so callers always get an `Error` with a `code`.
 */
function normalizeAgentError(error: unknown): unknown {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    const { code, message, data } = error as { code: unknown; message: unknown; data?: unknown };
    if (typeof code === "number" && typeof message === "string") {
      return new AcpJsonRpcError(code, message, data);
    }
  }
  return error;
}

/**
 * Client-side connection to one ACP agent process.
 *
 * - Lazily spawns the agent, performs the `initialize` handshake over stdio
 *   (ndjson JSON-RPC 2.0 via the SDK's `ClientSideConnection`) and caches
 *   the negotiated capabilities.
 * - Implements the ACP `Client` interface by delegating to the injected
 *   permission / fs handlers.
 * - Events:
 *   - `sessionUpdate` `(notification: SessionNotification)` — every
 *     `session/update` notification, including replays emitted while a
 *     `session/load` request is in flight.
 *   - `optionsChanged` `(modelState: SessionModelState | null)` — fired after
 *     a `session/new` / `session/load` response was received, carrying the
 *     UNSTABLE `models` state the agent advertised (null when unsupported).
 *   - `processExit` `(code: number | null)` — the agent process exited; all
 *     pending requests are rejected first. A later `ensureInitialized`
 *     call spawns a fresh process (previous sessions are invalid; the upper
 *     layer is responsible for that).
 */
export class AcpAgentConnection extends EventEmitter implements Client {
  readonly slotId: string;

  private readonly processConfig: AgentProcessConfig;
  private readonly deps: AcpAgentConnectionDeps;
  private readonly log: AcpLogFn;

  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private initPromise: Promise<InitializeResponse> | null = null;
  private cachedInitializeResponse: InitializeResponse | null = null;
  /** UNSTABLE `models` state from the latest session/new / session/load response. */
  private supportedModelState: SessionModelState | null = null;
  private readonly pendingRequests = new Set<PendingRequest>();
  private disposed = false;

  constructor(slotId: string, processConfig: AgentProcessConfig, deps: AcpAgentConnectionDeps) {
    super();
    this.slotId = slotId;
    this.processConfig = processConfig;
    this.deps = deps;
    this.log = deps.log;
  }

  /** Cached `initialize` response, or null before the first handshake. */
  getInitializeResponse(): InitializeResponse | null {
    return this.cachedInitializeResponse;
  }

  /**
   * The UNSTABLE `models` state advertised by the agent in the latest
   * `session/new` / `session/load` response, or null when the agent does not
   * support models or the process was restarted since.
   */
  getSupportedModelState(): SessionModelState | null {
    return this.supportedModelState;
  }

  /**
   * Lazily initializes the connection (spawn + initialize handshake).
   * Concurrent calls share a single in-flight promise; after a failure or a
   * process exit the next call rebuilds the process.
   */
  ensureInitialized(): Promise<InitializeResponse> {
    if (this.disposed) {
      return Promise.reject(new Error(`[acp:${this.slotId}] connection has been disposed`));
    }
    if (!this.initPromise) {
      const promise = this.doInitialize();
      this.initPromise = promise;
      // Clear the cached promise on failure so the next call retries with a
      // fresh process instead of rethrowing a stale rejection.
      promise.catch(() => {
        if (this.initPromise === promise) {
          this.initPromise = null;
        }
      });
    }
    return this.initPromise;
  }

  // ---- session methods -------------------------------------------------

  async newSession(cwd: string): Promise<NewSessionResponse> {
    await this.ensureInitialized();
    const connection = this.requireConnection();
    const response = await this.tracked(
      "session/new",
      connection.newSession({ cwd, mcpServers: [] }),
    );
    this.applyModelState(response.models ?? null);
    return response;
  }

  async loadSession(sessionId: string, cwd: string): Promise<LoadSessionResponse> {
    await this.ensureInitialized();
    const connection = this.requireConnection();
    const response = await this.tracked(
      "session/load",
      connection.loadSession({ sessionId, cwd, mcpServers: [] }),
    );
    this.applyModelState(response.models ?? null);
    return response;
  }

  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    await this.ensureInitialized();
    const connection = this.requireConnection();
    return this.tracked(
      "session/prompt",
      connection.prompt({ sessionId, prompt: [{ type: "text", text }] }),
    );
  }

  async cancel(sessionId: string): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return;
    }
    try {
      await connection.cancel({ sessionId });
    } catch (error) {
      this.log("warn", `[acp:${this.slotId}] failed to cancel session ${sessionId}: ${errorMessage(error)}`);
    }
  }

  async listSessions(cursor?: string): Promise<ListSessionsResponse> {
    await this.ensureInitialized();
    const connection = this.requireConnection();
    return this.tracked("session/list", connection.unstable_listSessions({ cursor }));
  }

  // ---- ACP Client interface (called by the SDK on agent requests) ------

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.emit("sessionUpdate", params);
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const toolCallId = params.toolCall?.toolCallId;
    const request = {
      sessionId: params.sessionId,
      toolCallId,
      options: params.options.map((option) => ({
        toolCallId: toolCallId ?? "",
        title: option.name,
        kind: option.kind,
      })),
      _meta: params._meta ?? undefined,
    };

    let response: AcpPermissionResponse;
    try {
      response = await this.deps.permissionHandler(request);
    } catch (error) {
      // A failing handler must not break the protocol: reject every option.
      this.log(
        "warn",
        `[acp:${this.slotId}] permission handler failed, rejecting all options: ${errorMessage(error)}`,
      );
      response = {
        updates: request.options.map(
          (option): AcpPermissionUpdate => ({ toolCallId: option.toolCallId, outcome: "rejected" }),
        ),
      };
    }
    return this.toSdkPermissionResponse(params, response);
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const handler = this.deps.fileReadHandler;
    if (!handler) {
      throw new AcpJsonRpcError(
        ACP_ERROR_CODES.METHOD_NOT_FOUND,
        "fs/read_text_file is not available (no fileReadHandler configured)",
      );
    }
    const content = await handler({
      path: params.path,
      line: params.line ?? undefined,
      limit: params.limit ?? undefined,
    });
    return { content };
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const handler = this.deps.fileWriteHandler;
    if (!handler) {
      throw new AcpJsonRpcError(
        ACP_ERROR_CODES.METHOD_NOT_FOUND,
        "fs/write_text_file is not available (no fileWriteHandler configured)",
      );
    }
    await handler({ path: params.path, content: params.content });
    return {};
  }

  // ---- lifecycle -------------------------------------------------------

  /**
   * Kills the agent process (the whole tree on Windows) and cleans up.
   * Pending requests are rejected; the connection cannot be reused after
   * disposal.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const child = this.process;
    this.process = null;
    this.connection = null;
    this.initPromise = null;
    this.supportedModelState = null;
    if (child) {
      this.killProcessTree(child);
    }
    this.rejectPendingRequests(new Error(`[acp:${this.slotId}] connection disposed`));
    this.removeAllListeners();
  }

  // ---- internals ---------------------------------------------------------

  /**
   * Stores the UNSTABLE `models` state of a session/new / session/load
   * response and notifies `optionsChanged` listeners (before the request
   * promise resolves).
   */
  private applyModelState(models: SessionModelState | null): void {
    this.supportedModelState = models;
    this.emit("optionsChanged", models);
  }

  private requireConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error(`[acp:${this.slotId}] agent connection is not initialized`);
    }
    return this.connection;
  }

  private async doInitialize(): Promise<InitializeResponse> {
    const child = this.startProcess();
    this.process = child;

    if (!child.stdin || !child.stdout) {
      this.killProcessTree(child);
      throw new Error(`[acp:${this.slotId}] agent process has no stdio pipes`);
    }

    // The Node adapters are typed as ReadableStream<any>/WritableStream<any>;
    // cast them onto the SDK's Uint8Array stream types.
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = new ClientSideConnection(() => this, stream);
    this.connection = connection;
    this.cachedInitializeResponse = null;
    // A fresh process invalidates the model state of the previous generation.
    this.supportedModelState = null;

    const timeoutMs = this.deps.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    try {
      const response = await this.withTimeout(
        this.tracked(
          "initialize",
          connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: CLIENT_INFO.name, version: CLIENT_INFO.version },
            clientCapabilities: {
              fs: {
                readTextFile: this.deps.fileReadHandler !== undefined,
                writeTextFile: this.deps.fileWriteHandler !== undefined,
              },
              terminal: false,
            },
          }),
        ),
        timeoutMs,
        `initialize handshake with agent "${this.processConfig.command}"`,
      );
      this.cachedInitializeResponse = response;
      this.log(
        "info",
        `[acp:${this.slotId}] initialized agent ${response.agentInfo?.name ?? "unknown"} ` +
          `(protocol version ${response.protocolVersion})`,
      );
      return response;
    } catch (error) {
      // Do not clear this.process / this.connection here: the kill below
      // triggers the child's exit event, which performs the state cleanup
      // and emits `processExit` exactly once.
      this.killProcessTree(child);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Spawns the agent process and wires exit/error handling. State cleanup
   * and the `processExit` event only run while this child is still the
   * connection's current process (a replacement process must not be
   * clobbered by an older child's exit).
   */
  private startProcess(): ChildProcess {
    const child = spawnAgentProcess(this.processConfig, this.log);
    let terminated = false;
    const onTerminated = (code: number | null, reason: string) => {
      if (terminated || this.process !== child) {
        return;
      }
      terminated = true;
      this.process = null;
      this.connection = null;
      this.initPromise = null;
      this.supportedModelState = null;
      const detail = `[acp:${this.slotId}] agent process ${reason}`;
      this.log("warn", `${detail} (code ${code === null ? "unknown" : code})`);
      this.rejectPendingRequests(new Error(detail));
      this.emit("processExit", code);
    };
    child.once("exit", (code) => onTerminated(code ?? null, "exited"));
    child.once("error", (error) =>
      onTerminated(null, `failed (${errorMessage(error)})`),
    );
    return child;
  }

  /**
   * Wraps a protocol request so that it is rejected when the process exits
   * before a response arrives (the SDK leaves such promises pending), and so
   * agent error responses surface as `AcpJsonRpcError`.
   */
  private tracked<T>(label: string, promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        label,
        reject: (error: Error) => {
          this.pendingRequests.delete(pending);
          reject(error);
        },
      };
      this.pendingRequests.add(pending);
      const settle = (finish: () => void) => {
        this.pendingRequests.delete(pending);
        finish();
      };
      promise.then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(normalizeAgentError(error))),
      );
    });
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of [...this.pendingRequests]) {
      pending.reject(new Error(`${error.message} (while awaiting "${pending.label}")`));
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`[acp:${this.slotId}] ${label} timed out after ${ms}ms`));
      }, ms);
      const clear = () => clearTimeout(timer);
      promise.then(
        (value) => {
          clear();
          resolve(value);
        },
        (error) => {
          clear();
          reject(error);
        },
      );
    });
  }

  private killProcessTree(child: ChildProcess): void {
    const pid = child.pid;
    if (typeof pid === "number" && process.platform === "win32") {
      // Kill the whole process tree: shell-wrapped agents may have children.
      // Prefer the absolute taskkill path: a bare "taskkill" only resolves
      // when PATH contains System32, which is not guaranteed.
      const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
      const taskkillPath = join(systemRoot, "System32", "taskkill.exe");
      const command = existsSync(taskkillPath) ? taskkillPath : "taskkill";
      try {
        const killer = spawnProcess(command, ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        // Spawn failures (ENOENT etc.) arrive asynchronously; without a
        // listener the 'error' event would crash the host process.
        killer.once("error", (error) => {
          this.log(
            "warn",
            `[acp:${this.slotId}] taskkill failed (${errorMessage(error)}); falling back to child.kill()`,
          );
          this.tryKillChild(child);
        });
        return;
      } catch (error) {
        this.log(
          "warn",
          `[acp:${this.slotId}] taskkill failed (${errorMessage(error)}); falling back to child.kill()`,
        );
      }
    }
    this.tryKillChild(child);
  }

  private tryKillChild(child: ChildProcess): void {
    try {
      child.kill();
    } catch (error) {
      this.log("warn", `[acp:${this.slotId}] failed to kill agent process: ${errorMessage(error)}`);
    }
  }

  /**
   * Maps the harness-internal permission response onto the wire format:
   * a `selected` update picks the option with the same kind (falling back
   * to an allow-kind option for kind-less updates), a `rejected` update
   * picks a reject-kind option, and anything unresolved answers
   * `cancelled`.
   */
  private toSdkPermissionResponse(
    request: RequestPermissionRequest,
    response: AcpPermissionResponse,
  ): RequestPermissionResponse {
    const toolCallId = request.toolCall?.toolCallId;
    let updates = response.updates.filter((update) => update.toolCallId === toolCallId);
    if (updates.length === 0) {
      updates = response.updates;
    }

    const selected = updates.find((update) => update.outcome === "selected");
    if (selected) {
      const option =
        selected.kind !== undefined
          ? request.options.find((candidate) => candidate.kind === selected.kind) ??
            request.options[0]
          : request.options.find(
              (candidate) => candidate.kind === "allow_once" || candidate.kind === "allow_always",
            ) ?? request.options[0];
      if (option) {
        return { outcome: { outcome: "selected", optionId: option.optionId } };
      }
    }

    const rejected = updates.find((update) => update.outcome === "rejected");
    if (rejected) {
      const option = request.options.find(
        (o) => o.kind === "reject_once" || o.kind === "reject_always",
      );
      if (option) {
        return { outcome: { outcome: "selected", optionId: option.optionId } };
      }
    }

    return { outcome: { outcome: "cancelled" } };
  }
}
