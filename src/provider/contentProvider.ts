import * as vscode from "vscode";
import { parseSessionResource } from "../config";
import type { SessionStore, StoredTurn } from "../sessionStore";
import { renderStoredTurn } from "./render";
import type { SlotHarness } from "./slotHarness";

/**
 * Chat session content provider for one agent slot: replays stored turns as
 * chat history, exposes the in-flight response to the editor, and routes new
 * requests through the {@link SlotHarness}.
 */
export class AcpContentProvider implements vscode.ChatSessionContentProvider {
  constructor(
    private readonly harness: SlotHarness,
    private readonly store: SessionStore,
    private readonly participantId: string,
  ) {}

  provideChatSessionContent(
    resource: vscode.Uri,
    _token: vscode.CancellationToken,
    _context: { readonly inputState: vscode.ChatSessionInputState },
  ): vscode.ChatSession {
    const parsed = parseSessionResource(resource);
    if (!parsed || parsed.slot !== this.harness.slot) {
      // Unknown / not-yet-created session: an empty, writable chat session.
      return { history: [], requestHandler: this.requestHandler };
    }

    const sessionId = parsed.sessionId;
    const history: Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2> = [];
    for (const turn of this.store.getTurns(this.harness.slot, sessionId)) {
      history.push(this.toRequestTurn(turn));
      history.push(this.toResponseTurn(turn));
    }

    const active = this.harness.resumeActive(sessionId);
    return {
      history,
      requestHandler: this.requestHandler,
      activeResponseCallback: active
        ? async (stream: vscode.ChatResponseStream, _activeToken: vscode.CancellationToken) => {
            stream.markdown(active.snapshotMarkdown);
            await active.done;
          }
        : undefined,
    };
  }

  /** Handles a chat request inside a session of this slot. */
  readonly requestHandler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> => {
    try {
      const chatUri = context.chatSessionContext?.chatSessionItem?.resource;
      const { sessionId } = await this.harness.ensureSessionId(chatUri, request.prompt);

      const outcome = await this.harness.runTurn(sessionId, request.prompt, response, token);
      if (outcome.error !== undefined) {
        return { errorDetails: { message: outcome.error } };
      }
      return {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.markdown(`> ⚠️ **ACP error:** ${message}\n\n`);
      return { errorDetails: { message } };
    }
  };

  // ---- internals ---------------------------------------------------------

  private toRequestTurn(turn: StoredTurn): vscode.ChatRequestTurn {
    return new vscode.ChatRequestTurn2(
      turn.prompt,
      undefined,
      [],
      this.participantId,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
    );
  }

  private toResponseTurn(turn: StoredTurn): vscode.ChatResponseTurn2 {
    return new vscode.ChatResponseTurn2(
      [new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(renderStoredTurn(turn)))],
      {},
      this.participantId,
    );
  }
}
