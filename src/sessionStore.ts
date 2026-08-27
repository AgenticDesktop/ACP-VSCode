import * as vscode from "vscode";
import type { AgentSlot } from "./config";

export interface StoredSession {
  sessionId: string;
  slot: AgentSlot;
  title: string;
  created: number;
  lastActive: number;
}

export interface StoredTurn {
  prompt: string;
  responseMarkdown: string;
  thoughts?: string;
  tools: StoredToolCall[];
  stopReason: string;
  error?: string;
  startedAt: number;
  endedAt: number;
}

export interface StoredToolCall {
  toolCallId: string;
  title: string;
  kind?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  content?: string;
}

function sessionsKey(slot: AgentSlot): string {
  return `acpHarness.sessions.${slot}`;
}

function turnsKey(slot: AgentSlot): string {
  return `acpHarness.turns.${slot}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredSession(value: unknown): value is StoredSession {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.title === "string" &&
    typeof value.created === "number" &&
    typeof value.lastActive === "number"
  );
}

function isStoredTurn(value: unknown): value is StoredTurn {
  return (
    isRecord(value) &&
    typeof value.prompt === "string" &&
    typeof value.responseMarkdown === "string" &&
    typeof value.stopReason === "string" &&
    typeof value.startedAt === "number" &&
    typeof value.endedAt === "number" &&
    Array.isArray(value.tools)
  );
}

/**
 * Persists session metadata and turn logs in a VS Code {@link vscode.Memento}.
 *
 * Data layout:
 * - `acpHarness.sessions.<slot>`: `StoredSession[]`
 * - `acpHarness.turns.<slot>`: `Record<sessionId, StoredTurn[]>`
 *
 * Writes are simple direct `memento.update` calls (no debouncing).
 */
export class SessionStore {
  constructor(private readonly memento: vscode.Memento) {}

  listSessions(slot: AgentSlot): StoredSession[] {
    return this.readSessions(slot).sort((a, b) => b.lastActive - a.lastActive);
  }

  saveSession(session: StoredSession): void {
    const sessions = this.readSessions(session.slot);
    const index = sessions.findIndex((s) => s.sessionId === session.sessionId);
    if (index >= 0) {
      sessions[index] = session;
    } else {
      sessions.push(session);
    }
    void this.memento.update(sessionsKey(session.slot), sessions);
  }

  deleteSession(slot: AgentSlot, sessionId: string): void {
    const sessions = this.readSessions(slot).filter((s) => s.sessionId !== sessionId);
    void this.memento.update(sessionsKey(slot), sessions);

    const turns = this.readTurnRecord(slot);
    if (Object.prototype.hasOwnProperty.call(turns, sessionId)) {
      delete turns[sessionId];
      void this.memento.update(turnsKey(slot), turns);
    }
  }

  getTurns(slot: AgentSlot, sessionId: string): StoredTurn[] {
    const turns = this.readTurnRecord(slot)[sessionId];
    return Array.isArray(turns) ? turns : [];
  }

  appendTurn(slot: AgentSlot, sessionId: string, turn: StoredTurn): void {
    const record = this.readTurnRecord(slot);
    const turns = record[sessionId] ?? [];
    turns.push(turn);
    record[sessionId] = turns;
    void this.memento.update(turnsKey(slot), record);
  }

  updateTurn(slot: AgentSlot, sessionId: string, index: number, patch: Partial<StoredTurn>): void {
    const record = this.readTurnRecord(slot);
    const turns = record[sessionId];
    if (!Array.isArray(turns) || index < 0 || index >= turns.length) {
      return;
    }
    turns[index] = { ...turns[index], ...patch };
    record[sessionId] = turns;
    void this.memento.update(turnsKey(slot), record);
  }

  private readSessions(slot: AgentSlot): StoredSession[] {
    const raw = this.memento.get<unknown>(sessionsKey(slot), []);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter(isStoredSession);
  }

  private readTurnRecord(slot: AgentSlot): Record<string, StoredTurn[]> {
    const raw = this.memento.get<unknown>(turnsKey(slot), {});
    if (!isRecord(raw)) {
      return {};
    }
    const record: Record<string, StoredTurn[]> = {};
    for (const [sessionId, turns] of Object.entries(raw)) {
      if (Array.isArray(turns)) {
        record[sessionId] = turns.filter(isStoredTurn);
      }
    }
    return record;
  }
}
