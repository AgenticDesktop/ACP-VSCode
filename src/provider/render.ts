import type { StoredToolCall, StoredTurn } from "../sessionStore";

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

type ToolCallStatus = StoredToolCall["status"];
type PlanEntryStatus = PlanEntry["status"];

const TOOL_CALL_STATUSES: readonly ToolCallStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "failed",
];
const PLAN_ENTRY_STATUSES: readonly PlanEntryStatus[] = ["pending", "in_progress", "completed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolCallStatus(value: unknown): value is ToolCallStatus {
  return typeof value === "string" && (TOOL_CALL_STATUSES as readonly string[]).includes(value);
}

function isPlanEntryStatus(value: unknown): value is PlanEntryStatus {
  return typeof value === "string" && (PLAN_ENTRY_STATUSES as readonly string[]).includes(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function asBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) {
    return content;
  }
  return content === undefined || content === null ? [] : [content];
}

/**
 * Extracts text from content blocks (`ContentChunk.content` shape, i.e. a
 * single `ContentBlock`, defensively also accepting an array of blocks).
 * Only text-bearing blocks contribute; multiple blocks are joined with
 * a blank line.
 */
export function extractChunkText(content: unknown): string {
  const texts: string[] = [];
  for (const block of asBlocks(content)) {
    if (!isRecord(block)) {
      continue;
    }
    if (
      (block.type === "text" || block.type === "markdown") &&
      typeof block.text === "string"
    ) {
      texts.push(block.text);
    } else if (typeof block.text === "string" && Object.keys(block).length <= 2) {
      // Defensive fallback for text-like blocks with an unexpected type tag.
      texts.push(block.text);
    }
  }
  return texts.join("\n\n");
}

/**
 * Renders `ToolCallContent[]` into a plain string. Text content blocks
 * contribute their text; any other block kind is summarized via JSON.
 */
function extractToolContent(content: unknown): string | undefined {
  const blocks = asBlocks(content);
  if (blocks.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "content" && isRecord(block.content)) {
      const inner = block.content;
      if (inner.type === "text" && typeof inner.text === "string") {
        parts.push(inner.text);
        continue;
      }
      parts.push(safeStringify(inner));
      continue;
    }
    parts.push(safeStringify(block));
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function formatUsage(update: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if (
    typeof update.inputTokens === "number" ||
    typeof update.outputTokens === "number"
  ) {
    const input = typeof update.inputTokens === "number" ? update.inputTokens : 0;
    const output = typeof update.outputTokens === "number" ? update.outputTokens : 0;
    parts.push(`tokens: in ${input} / out ${output}`);
    if (typeof update.totalTokens === "number") {
      parts.push(`total ${update.totalTokens}`);
    }
  } else if (typeof update.used === "number" || typeof update.size === "number") {
    const used = typeof update.used === "number" ? update.used : 0;
    const size = typeof update.size === "number" ? update.size : 0;
    parts.push(`context: ${used} / ${size} tokens`);
  } else {
    return undefined;
  }
  if (
    isRecord(update.cost) &&
    typeof update.cost.amount === "number" &&
    typeof update.cost.currency === "string"
  ) {
    parts.push(`cost ${update.cost.amount} ${update.cost.currency}`);
  }
  return parts.join(", ");
}

/**
 * Accumulates ACP `session/update` notifications for a single prompt turn
 * into plain strings and plain tool-call records that can be persisted as a
 * `StoredTurn`. Pure data aggregation: no VS Code dependency, defensive
 * parsing of untyped update objects, unknown update types are ignored.
 */
export class TurnAccumulator {
  private readonly agentChunks: string[] = [];
  private readonly thoughtChunks: string[] = [];
  private readonly toolCalls: StoredToolCall[] = [];
  private planEntries: PlanEntry[] = [];
  private usageSummary: string | undefined;

  apply(update: unknown): void {
    if (!isRecord(update)) {
      return;
    }
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = extractChunkText(update.content);
        if (text.length > 0) {
          this.agentChunks.push(text);
        }
        break;
      }
      case "agent_thought_chunk": {
        const text = extractChunkText(update.content);
        if (text.length > 0) {
          this.thoughtChunks.push(text);
        }
        break;
      }
      case "tool_call": {
        const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
        if (toolCallId.length === 0) {
          break;
        }
        const title = typeof update.title === "string" && update.title.length > 0 ? update.title : toolCallId;
        const entry: StoredToolCall = {
          toolCallId,
          title,
          kind: typeof update.kind === "string" ? update.kind : undefined,
          status: isToolCallStatus(update.status) ? update.status : "pending",
          content: extractToolContent(update.content),
        };
        const index = this.toolCalls.findIndex((tool) => tool.toolCallId === toolCallId);
        if (index >= 0) {
          this.toolCalls[index] = entry;
        } else {
          this.toolCalls.push(entry);
        }
        break;
      }
      case "tool_call_update": {
        const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
        const existing = this.toolCalls.find((tool) => tool.toolCallId === toolCallId);
        if (!existing) {
          break;
        }
        if (isToolCallStatus(update.status)) {
          existing.status = update.status;
        }
        if (typeof update.title === "string" && update.title.length > 0) {
          existing.title = update.title;
        }
        if (typeof update.kind === "string" && update.kind.length > 0) {
          existing.kind = update.kind;
        }
        if (update.content !== undefined && update.content !== null) {
          existing.content = extractToolContent(update.content);
        }
        break;
      }
      case "plan": {
        const rawEntries = Array.isArray(update.entries) ? update.entries : [];
        const entries: PlanEntry[] = [];
        for (const raw of rawEntries) {
          if (isRecord(raw) && typeof raw.content === "string") {
            entries.push({
              content: raw.content,
              status: isPlanEntryStatus(raw.status) ? raw.status : "pending",
            });
          }
        }
        // Plans are always sent as the complete, current list of entries.
        this.planEntries = entries;
        break;
      }
      case "usage_update": {
        const text = formatUsage(update);
        if (text !== undefined) {
          this.usageSummary = text;
        }
        break;
      }
      default:
        // Unknown update types (user_message_chunk, available_commands_update,
        // current_mode_update, config_option_update, session_info_update, ...)
        // are ignored on purpose.
        break;
    }
  }

  /** Concatenated `agent_message_chunk` text for this turn. */
  get markdown(): string {
    return this.agentChunks.join("");
  }

  /** Concatenated `agent_thought_chunk` text for this turn. */
  get thoughts(): string {
    return this.thoughtChunks.join("");
  }

  /** Tool calls seen so far (created via `tool_call`, merged via `tool_call_update`). */
  get tools(): StoredToolCall[] {
    return this.toolCalls;
  }

  /** Latest plan entries ({@link PlanEntry} with content + status). */
  get plan(): PlanEntry[] {
    return this.planEntries;
  }

  /** Formatted usage summary of the most recent `usage_update`, if any. */
  get usageText(): string | undefined {
    return this.usageSummary;
  }
}

/**
 * Renders a persisted {@link StoredTurn} into a single markdown string used
 * for chat history playback (and in-progress snapshots). Layout: quoted
 * thoughts, agent markdown, tool-call list, error footnote and — unless the
 * turn ended with `end_turn` — a stop-reason footnote.
 */
export function renderStoredTurn(turn: StoredTurn): string {
  const sections: string[] = [];

  const thoughts = turn.thoughts?.trim() ?? "";
  if (thoughts.length > 0) {
    sections.push(`> ${thoughts.replace(/\n/g, "\n> ")}\n\n`);
  }

  const body = turn.responseMarkdown.trim();
  if (body.length > 0) {
    sections.push(`${turn.responseMarkdown.trimEnd()}\n\n`);
  }

  if (turn.tools.length > 0) {
    const lines = turn.tools.map((tool) => `- 🔧 ${tool.title} (${tool.status})`);
    sections.push(`${lines.join("\n")}\n\n`);
  }

  if (turn.error) {
    sections.push(`> ⚠️ **Error:** ${turn.error}\n\n`);
  }

  if (turn.stopReason.length > 0 && turn.stopReason !== "end_turn") {
    sections.push(`_stopped: ${turn.stopReason}_\n\n`);
  }

  return sections.join("");
}
