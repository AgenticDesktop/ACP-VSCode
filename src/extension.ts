/// <reference path="../typings/vscode.proposed.chatSessionsProvider.d.ts" />
/// <reference path="../typings/vscode.proposed.chatParticipantAdditions.d.ts" />
/// <reference path="../typings/vscode.proposed.chatParticipantPrivate.d.ts" />
/// <reference path="../typings/vscode.proposed.chatProvider.d.ts" />
import * as vscode from "vscode";
import { CONFIG_KEY, onAgentConfigChanged } from "./config";
import { HarnessRegistry } from "./provider/harnessRegistry";
import {
  DEFAULT_MODEL_PROVIDER_ID,
  DefaultLanguageModelProvider,
  DefaultParticipantHandler,
  isCopilotAvailable,
} from "./provider/languageModelProvider";
import { SessionStore } from "./sessionStore";

export { CONFIG_KEY };

export const EXT_ID = "acp-vscode.acp-agent-harness";

export function activate(context: vscode.ExtensionContext) {
  const channel = vscode.window.createOutputChannel("ACP Agent Harness", { log: true });
  context.subscriptions.push(channel);
  // The actual extension id (publisher may differ between local rebuilds) is
  // used in the guidance message so users copy the right value into argv.json.
  const extId = context.extension.id;
  if (typeof (vscode.chat as any).registerChatSessionContentProvider !== "function") {
    void vscode.window.showErrorMessage(
      "ACP Agent Harness requires proposed APIs. Add to ~/.vscode/argv.json: \"enable-proposed-api\": [\"" + extId + "\"], then fully restart VS Code Insiders.",
      "OK"
    );
    channel.error(`Proposed API chatSessionsProvider not enabled for ${extId}; extension inactive.`);
    return;
  }

  const store = new SessionStore(context.globalState);
  const registry = new HarnessRegistry(store, channel, context.globalState);
  context.subscriptions.push(registry);

  // When GitHub Copilot is not active, register a fallback model provider so
  // the model picker is never empty. No chat participant is created here: on
  // VS Code 1.136+ dynamic (undeclared) participants are rejected.
  if (!isCopilotAvailable()) {
    const defaultLmProvider = new DefaultLanguageModelProvider();
    context.subscriptions.push(defaultLmProvider);
    context.subscriptions.push(
      vscode.lm.registerLanguageModelChatProvider(
        DEFAULT_MODEL_PROVIDER_ID,
        defaultLmProvider,
      ),
    );
  }

  registry.syncConfigs();
  context.subscriptions.push(
    onAgentConfigChanged(() => registry.syncConfigs()),
  );

  // When a chat session is closed, drop the slot harness' mapping; the agent
  // process is disposed once its slot has no active chat session left.
  if (typeof vscode.chat.onDidDisposeChatSession === "function") {
    context.subscriptions.push(
      vscode.chat.onDidDisposeChatSession((sessionUri) => {
        registry.handleSessionDisposed(sessionUri);
      }),
    );
  }

  channel.info("ACP Agent Harness activated.");
}
export function deactivate() {}
