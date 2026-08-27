/**
 * Pure protocol-layer types and constants for the ACP agent harness.
 *
 * This module MUST NOT import 'vscode': it is shared between the extension
 * host and plain-Node automated tests.
 */

import type { ReadTextFileRequest, WriteTextFileRequest } from "@agentclientprotocol/sdk";

/** How to launch an ACP agent process (per agent slot). */
export interface AgentProcessConfig {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * A single permission option surfaced to the user by the injected
 * {@link PermissionHandler}. This is the harness-internal, UI-facing model;
 * option identity is the tool call it belongs to plus its kind.
 */
export interface AcpPermissionOption {
  toolCallId: string;
  title: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** Permission request delivered to the injected {@link PermissionHandler}. */
export interface AcpPermissionRequest {
  sessionId: string;
  toolCallId?: string;
  options: AcpPermissionOption[];
  _meta?: unknown;
}

/** Per-option decision produced by the {@link PermissionHandler}. */
export interface AcpPermissionUpdate {
  toolCallId: string;
  outcome: "selected" | "rejected" | "pending";
  /** Kind of the option this update refers to, when known. */
  kind?: AcpPermissionOption["kind"];
}

/** Aggregate permission response produced by the {@link PermissionHandler}. */
export interface AcpPermissionResponse {
  updates: AcpPermissionUpdate[];
}

/**
 * Params for the injected file-read handler. Subset of the ACP
 * `fs/read_text_file` request (the full protocol type carries `sessionId`,
 * which the handler does not need).
 */
export interface AcpFileReadParams {
  path: string;
  /** 1-based line number to start reading from. */
  line?: number;
  /** Maximum number of lines to read. */
  limit?: number;
}

/**
 * Params for the injected file-write handler. Subset of the ACP
 * `fs/write_text_file` request.
 */
export interface AcpFileWriteParams {
  path: string;
  content: string;
}

/** Full SDK fs request types, re-exported for upper layers that need them. */
export type { ReadTextFileRequest, WriteTextFileRequest };

/**
 * Handles a permission request coming from the agent. When the handler
 * throws, the connection rejects every option and answers the agent with a
 * rejection.
 */
export type PermissionHandler = (req: AcpPermissionRequest) => Promise<AcpPermissionResponse>;

/**
 * Handles `fs/read_text_file` requests from the agent. Resolves with the
 * file content. May throw {@link AcpJsonRpcError} to pass a JSON-RPC error
 * code back to the agent.
 */
export type FileReadHandler = (params: AcpFileReadParams) => Promise<string>;

/**
 * Handles `fs/write_text_file` requests from the agent. May throw
 * {@link AcpJsonRpcError} to pass a JSON-RPC error code back to the agent.
 */
export type FileWriteHandler = (params: AcpFileWriteParams) => Promise<void>;

/** Structured logger injected into the protocol layer. */
export type AcpLogFn = (
  level: "trace" | "debug" | "info" | "warn" | "error",
  msg: string,
  data?: unknown,
) => void;

/**
 * JSON-RPC 2.0 / ACP error codes used by this layer (mirrors the SDK's
 * `ErrorCode` union; `CUSTOM` is a harness-specific code).
 */
export const ACP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AUTH_REQUIRED: -32800,
  /** Harness-specific custom error code. */
  CUSTOM: -32000,
} as const;
