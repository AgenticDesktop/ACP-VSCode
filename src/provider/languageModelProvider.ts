/// <reference path="../../typings/vscode.proposed.chatProvider.d.ts" />
import * as vscode from "vscode";
import type { AgentSlot } from "../config";
import { mapAcpModelsToInfo } from "./modelMapping";
import type { AcpModelInput } from "./modelMapping";

export { mapAcpModelsToInfo } from "./modelMapping";
export type { AcpModelInput, AcpModelShape } from "./modelMapping";

/** Vendor id of the fallback default model provider. */
export const DEFAULT_MODEL_PROVIDER_ID = "acp-default";

type AcpModelInfo = vscode.LanguageModelChatInformation & {
  readonly isUserSelectable?: boolean;
  readonly targetChatSessionType?: string;
};

function modelsStorageKey(slot: AgentSlot): string {
  return `acpHarness.models.${slot}`;
}

/**
 * Language model provider for a single ACP agent slot. It always exposes a
 * selectable "seed" model bound to the slot's chat session type so the
 * session picker has a language model source even before the agent process
 * is spawned. Once the agent reports its UNSTABLE `models` state (see
 * `session/new` / `session/load`), {@link updateModels} replaces the list
 * with the agent's real models (plus the seed fallback); the list is also
 * persisted in the given memento so it survives window reloads. Actual
 * inference is handled by the chat session's request handler;
 * `provideLanguageModelChatResponse` is intentionally a no-op.
 */
export class AcpLanguageModelProvider
  implements vscode.LanguageModelChatProvider<AcpModelInfo>, vscode.Disposable
{
  private readonly slot: AgentSlot;
  private readonly seedModel: AcpModelInfo;
  private readonly memento?: vscode.Memento;
  private currentModels: AcpModelInfo[];

  private readonly _onDidChangeLanguageModelChatInformation =
    new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation =
    this._onDidChangeLanguageModelChatInformation.event;

  constructor(slot: AgentSlot, title: string, memento?: vscode.Memento) {
    this.slot = slot;
    this.memento = memento;
    this.seedModel = {
      id: `${slot}-default`,
      name: title,
      family: `acp-${slot}`,
      version: "default",
      maxInputTokens: 58_999,
      maxOutputTokens: 1,
      capabilities: { toolCalling: true },
      isUserSelectable: true,
      targetChatSessionType: `acp-${slot}`,
    };
    this.currentModels = [this.seedModel];
    // Restore the last known model list so the picker is populated before
    // the agent process is spawned.
    const stored = memento?.get<readonly AcpModelInput[] | undefined>(modelsStorageKey(slot));
    if (stored && stored.length > 0) {
      this.currentModels = this.computeModels(stored);
    }
  }

  /**
   * Replaces the model list. `null`/`undefined`/empty input restores the
   * seed-only fallback; a non-empty list yields the agent's models plus the
   * seed (dropped when its id collides with a real model id).
   */
  updateModels(models: readonly AcpModelInput[] | null | undefined): void {
    const hasModels = models !== null && models !== undefined && models.length > 0;
    if (this.memento) {
      void this.memento.update(modelsStorageKey(this.slot), hasModels ? models : undefined);
    }
    this.currentModels = this.computeModels(models);
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  private computeModels(models: readonly AcpModelInput[] | null | undefined): AcpModelInfo[] {
    if (models === null || models === undefined || models.length === 0) {
      return [this.seedModel];
    }
    const mapped = mapAcpModelsToInfo(this.slot, models) as AcpModelInfo[];
    if (mapped.some((model) => model.id === this.seedModel.id)) {
      return mapped;
    }
    return [this.seedModel, ...mapped];
  }

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<AcpModelInfo[]> {
    return this.currentModels;
  }

  provideLanguageModelChatResponse(
    _model: AcpModelInfo,
    _messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    _progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    _token: vscode.CancellationToken,
  ): Thenable<void> {
    return Promise.resolve();
  }

  provideTokenCount(
    _model: AcpModelInfo,
    _text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    return Promise.resolve(0);
  }

  dispose(): void {
    this._onDidChangeLanguageModelChatInformation.dispose();
  }
}

const DEFAULT_MODEL: AcpModelInfo = {
  id: DEFAULT_MODEL_PROVIDER_ID,
  name: "ACP Default",
  family: "acp",
  version: "default",
  maxInputTokens: 60_000,
  maxOutputTokens: 8_000,
  capabilities: { toolCalling: true },
  isUserSelectable: true,
};

/**
 * Fallback language model provider that registers a dummy "acp-default" model
 * when GitHub Copilot is not installed or enabled, so there is always at least
 * one model available in the model picker.
 */
export class DefaultLanguageModelProvider
  implements vscode.LanguageModelChatProvider<AcpModelInfo>, vscode.Disposable
{
  private readonly _onDidChangeLanguageModelChatInformation =
    new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation =
    this._onDidChangeLanguageModelChatInformation.event;

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<AcpModelInfo[]> {
    return [DEFAULT_MODEL];
  }

  provideLanguageModelChatResponse(
    _model: AcpModelInfo,
    _messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    _progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    _token: vscode.CancellationToken,
  ): Thenable<void> {
    return Promise.resolve();
  }

  provideTokenCount(
    _model: AcpModelInfo,
    _text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    return Promise.resolve(0);
  }

  dispose(): void {
    this._onDidChangeLanguageModelChatInformation.dispose();
  }
}

/** Returns true if GitHub Copilot (copilot or copilot-chat) is installed and active. */
export function isCopilotAvailable(): boolean {
  const copilot = vscode.extensions.getExtension("GitHub.copilot");
  const copilotChat = vscode.extensions.getExtension("GitHub.copilot-chat");
  return (
    (copilot !== undefined && copilot.isActive) ||
    (copilotChat !== undefined && copilotChat.isActive)
  );
}

/** Handler for the fallback "acp-default" chat participant. */
export const DefaultParticipantHandler: vscode.ChatRequestHandler = (
  _request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  response: vscode.ChatResponseStream,
) => {
  response.markdown("Please select one of the ACP agents for your request.");
};
