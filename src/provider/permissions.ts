import * as vscode from "vscode";
import type {
  AcpPermissionOption,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPermissionUpdate,
  PermissionHandler,
} from "../acp/types";
import { computePermissionOutcomes } from "./permissionLogic";

interface PermissionPickItem extends vscode.QuickPickItem {
  option: AcpPermissionOption;
}

/**
 * Creates a {@link PermissionHandler} that surfaces ACP permission requests
 * as a VS Code QuickPick. Selecting an option marks it `selected`; when the
 * chosen option is a reject-kind every other option becomes `rejected`,
 * otherwise they stay `pending`. Dismissing the prompt rejects everything
 * instead of throwing, so the protocol flow is never broken.
 */
export function createPermissionHandler(log: vscode.LogOutputChannel): PermissionHandler {
  return async (request: AcpPermissionRequest): Promise<AcpPermissionResponse> => {
    const items: PermissionPickItem[] = request.options.map((option) => ({
      label: option.title,
      description: option.kind,
      option,
    }));

    const toolCallLabel = request.toolCallId
      ? `tool call ${request.toolCallId}`
      : "a tool call";
    const placeHolder = `ACP permission required for ${toolCallLabel} (session ${request.sessionId})`;

    const pick = await vscode.window.showQuickPick<PermissionPickItem>(items, {
      placeHolder,
      ignoreFocusOut: true,
    });

    if (!pick) {
      log.warn(
        `[acp:permissions] prompt dismissed for session ${request.sessionId}; rejecting all options`,
      );
      return {
        updates: request.options.map(
          (option): AcpPermissionUpdate => ({ toolCallId: option.toolCallId, outcome: "rejected" }),
        ),
      };
    }

    const chosen = pick.option;
    log.debug(
      `[acp:permissions] session ${request.sessionId}: selected "${chosen.title}" (${chosen.kind})`,
    );

    // Options may span multiple toolCallIds; the selected/rejected/pending
    // rule is applied per option across all of them.
    return {
      updates: computePermissionOutcomes(request.options, chosen.toolCallId, chosen.kind),
    };
  };
}
