import * as vscode from "vscode";

/** Configuration key holding the per-slot agent launch configuration. */
export const CONFIG_KEY = "acpHarness.agents";

export const AGENT_SLOTS = [
  "gemini",
  "opencode",
  "cagent",
  "codex",
  "claude",
  "qwen",
  "custom1",
  "custom2",
  "custom3",
  "custom4",
] as const;
export type AgentSlot = typeof AGENT_SLOTS[number];

export interface AgentConfig {
  slot: AgentSlot;
  title: string;
  description?: string;
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  enabled: boolean;
}

export interface SlotStatus {
  slot: AgentSlot;
  configured: boolean;
  enabled: boolean;
}

export interface AgentConfigResult {
  configs: Map<AgentSlot, AgentConfig>;
  statuses: SlotStatus[];
  warnings: string[];
}

const SESSION_PATH = "/session";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

/**
 * Reads and validates the `acpHarness.agents` configuration section.
 *
 * - Slots without a `command` produce a warning (mentioning the slot) and are skipped.
 * - `enabled` defaults to `true` at the code level.
 * - `title` falls back to the slot id; `args`/`env` fall back to `[]`/`{}`.
 * - Unknown configuration keys are ignored.
 */
export function readAgentConfigs(log?: { warn(message: string): void }): AgentConfigResult {
  const configs = new Map<AgentSlot, AgentConfig>();
  const statuses: SlotStatus[] = [];
  const warnings: string[] = [];

  const raw = vscode.workspace.getConfiguration().get<unknown>(CONFIG_KEY);
  const section = isRecord(raw) ? raw : {};

  for (const slot of AGENT_SLOTS) {
    const entry = section[slot];
    if (!isRecord(entry)) {
      statuses.push({ slot, configured: false, enabled: false });
      continue;
    }

    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    if (!command) {
      const warning = `Agent slot "${slot}" is configured but has no "command"; skipping.`;
      warnings.push(warning);
      log?.warn(warning);
      statuses.push({ slot, configured: false, enabled: false });
      continue;
    }

    const enabled = typeof entry.enabled === "boolean" ? entry.enabled : true;
    const title =
      typeof entry.title === "string" && entry.title.trim().length > 0 ? entry.title : slot;

    const config: AgentConfig = {
      slot,
      title,
      command,
      args: readStringArray(entry.args),
      env: readStringRecord(entry.env),
      enabled,
    };
    if (typeof entry.description === "string") {
      config.description = entry.description;
    }
    if (typeof entry.cwd === "string" && entry.cwd.trim().length > 0) {
      config.cwd = entry.cwd;
    }

    configs.set(slot, config);
    statuses.push({ slot, configured: true, enabled });
  }

  return { configs, statuses, warnings };
}

export function agentScheme(slot: AgentSlot): string {
  return `acp-${slot}`;
}

/**
 * Characters that are safe unencoded in a URI authority component (RFC 3986
 * unreserved characters, which includes `-` for hyphenated session ids).
 */
const SAFE_AUTHORITY = /^[A-Za-z0-9\-._~]*$/;

function encodeSessionAuthority(sessionId: string): string {
  return SAFE_AUTHORITY.test(sessionId) ? sessionId : encodeURIComponent(sessionId);
}

/**
 * Builds the resource URI for a stored chat session:
 * `acp-<slot>://<sessionId>/session`.
 */
export function buildSessionResource(slot: AgentSlot, sessionId: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: agentScheme(slot),
    authority: encodeSessionAuthority(sessionId),
    path: SESSION_PATH,
  });
}

/**
 * Parses a session resource URI back into its slot and session id.
 * Returns `undefined` when the scheme is not a known agent scheme or the
 * authority is empty.
 */
export function parseSessionResource(
  uri: vscode.Uri,
): { slot: AgentSlot; sessionId: string } | undefined {
  const slot = AGENT_SLOTS.find((candidate) => agentScheme(candidate) === uri.scheme);
  if (!slot || uri.authority.length === 0) {
    return undefined;
  }
  if (uri.path !== SESSION_PATH && uri.path !== "") {
    return undefined;
  }
  let sessionId = uri.authority;
  try {
    sessionId = decodeURIComponent(uri.authority);
  } catch {
    // Keep the raw authority if it is not a valid percent-encoded string.
  }
  return { slot, sessionId };
}

/**
 * Registers a callback that fires when the `acpHarness.agents` configuration changes.
 */
export function onAgentConfigChanged(cb: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(CONFIG_KEY)) {
      cb();
    }
  });
}
