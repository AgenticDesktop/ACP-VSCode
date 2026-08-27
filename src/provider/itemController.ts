import * as vscode from "vscode";
import type { AgentSlot } from "../config";
import { agentScheme, buildSessionResource } from "../config";
import type { SessionStore } from "../sessionStore";
import type { SlotHarness } from "./slotHarness";

const REFRESH_DEBOUNCE_MS = 500;

/** Item controller handle for one agent slot. */
export interface SlotItemController extends vscode.Disposable {
  /** Debounced refresh of the chat session item list. */
  refresh(): void;
}

/**
 * Creates the chat session item controller for one agent slot. The refresh
 * handler replaces the item list from the {@link SessionStore}; harness
 * session changes (turn finished, new session) trigger a debounced refresh.
 */
export function createSlotItemController(
  harness: SlotHarness,
  store: SessionStore,
  slot: AgentSlot,
  channel: vscode.LogOutputChannel,
): SlotItemController {
  const controller = vscode.chat.createChatSessionItemController(agentScheme(slot), (token) =>
    refreshNow(token),
  );

  async function refreshNow(token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested) {
      return;
    }
    // Hide the stored sessions when the agent is known not to support
    // session/load: they cannot be restored, only replayed locally.
    const sessions = harness.shouldListStoredSessions() ? store.listSessions(slot) : [];
    const items = sessions.map((session) => {
      const item = controller.createChatSessionItem(
        buildSessionResource(slot, session.sessionId),
        session.title,
      );
      item.description = `最后活动 ${new Date(session.lastActive).toLocaleString()}`;
      item.timing = {
        created: session.created,
        lastRequestStarted: session.lastActive,
      };
      return item;
    });
    controller.items.replace(items);
    channel.debug(`[acp:${slot}] listed ${items.length} chat session item(s)`);
  }

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const changeSubscription = harness.onDidSessionsChange(() => refresh());

  function refresh(): void {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      const cts = new vscode.CancellationTokenSource();
      void refreshNow(cts.token)
        .catch((error: unknown) =>
          channel.warn(
            `[acp:${slot}] failed to refresh session items: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        )
        .finally(() => cts.dispose());
    }, REFRESH_DEBOUNCE_MS);
  }

  return {
    refresh,
    dispose(): void {
      changeSubscription.dispose();
      if (refreshTimer !== undefined) {
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
      controller.dispose();
    },
  };
}
