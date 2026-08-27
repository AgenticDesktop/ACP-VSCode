import * as vscode from "vscode";
import type { AgentConfig, AgentSlot } from "../config";
import { agentScheme, parseSessionResource, readAgentConfigs } from "../config";
import type { SessionStore } from "../sessionStore";
import { AcpContentProvider } from "./contentProvider";
import { createSlotItemController } from "./itemController";
import { AcpLanguageModelProvider } from "./languageModelProvider";
import { SlotHarness } from "./slotHarness";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tracks one {@link SlotHarness} plus its three VS Code registrations (chat
 * participant, chat session content provider, chat session item controller)
 * per configured agent slot. `syncConfigs` diffs the configuration and
 * creates/destroys slots accordingly.
 */
export class HarnessRegistry implements vscode.Disposable {
  private readonly harnesses = new Map<AgentSlot, SlotHarness>();
  private readonly registrations = new Map<AgentSlot, vscode.Disposable[]>();
  private disposed = false;

  constructor(
    private readonly store: SessionStore,
    private readonly channel: vscode.LogOutputChannel,
    private readonly globalState: vscode.Memento,
  ) {}

  get(slot: AgentSlot): SlotHarness | undefined {
    return this.harnesses.get(slot);
  }

  /** Diffs `acpHarness.agents` against the registered slots. */
  syncConfigs(): void {
    if (this.disposed) {
      return;
    }
    const { configs } = readAgentConfigs(this.channel);

    const activeSlots = new Set<AgentSlot>();
    for (const [slot, config] of configs) {
      if (!config.enabled) {
        continue;
      }
      activeSlots.add(slot);
      if (!this.harnesses.has(slot)) {
        try {
          this.registerSlot(slot, config);
        } catch (error) {
          this.channel.error(
            `[acp:${slot}] failed to register agent slot: ${errorMessage(error)}`,
          );
        }
      }
    }

    for (const slot of [...this.harnesses.keys()]) {
      if (!activeSlots.has(slot)) {
        this.unregisterSlot(slot, "slot removed from configuration");
      }
    }
  }

  /**
   * Handles `vscode.chat.onDidDisposeChatSession`: drops the slot harness'
   * chat-session mapping (which disposes the agent process once no active
   * chat session remains for the slot).
   */
  handleSessionDisposed(sessionUri: string): void {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(sessionUri);
    } catch {
      return;
    }
    const parsed = parseSessionResource(uri);
    if (!parsed) {
      return;
    }
    const harness = this.harnesses.get(parsed.slot);
    if (!harness) {
      return;
    }
    harness.releaseChatSession(uri);
    this.channel.info(`[acp:${parsed.slot}] chat session disposed: ${sessionUri}`);
  }

  // ---- internals ---------------------------------------------------------

  private registerSlot(slot: AgentSlot, config: AgentConfig): void {
    // Give the session type a language model source so the session picker
    // stops flagging the agent as requiring a Copilot Pro upgrade. It is
    // created before the harness so the harness can feed the agent's model
    // list into it; its lifecycle is owned by this registry, not the harness.
    const lmProvider = new AcpLanguageModelProvider(slot, config.title, this.globalState);
    const harness = new SlotHarness(slot, config, this.store, this.channel, lmProvider);
    const provider = new AcpContentProvider(harness, this.store, agentScheme(slot));

    // The participant must be created before the content provider is
    // registered: registerChatSessionContentProvider takes it as the default
    // participant for sessions of this scheme.
    const participant = vscode.chat.createChatParticipant(agentScheme(slot), provider.requestHandler);
    // `fullName` exists on ChatParticipant at runtime but is missing from this
    // typings snapshot; assign it through an intersection type.
    (participant as vscode.ChatParticipant & { fullName?: string }).fullName = config.title;

    const providerRegistration = vscode.chat.registerChatSessionContentProvider(
      agentScheme(slot),
      provider,
      participant,
      { supportsInterruptions: true },
    );

    const itemController = createSlotItemController(harness, this.store, slot, this.channel);

    const lmRegistration = vscode.lm.registerLanguageModelChatProvider(
      agentScheme(slot),
      lmProvider,
    );

    this.harnesses.set(slot, harness);
    this.registrations.set(slot, [
      harness,
      participant,
      providerRegistration,
      itemController,
      lmProvider,
      lmRegistration,
    ]);
    this.channel.info(
      `[acp:${slot}] registered agent "${config.title}" (participant ${agentScheme(slot)})`,
    );
  }

  private unregisterSlot(slot: AgentSlot, reason: string): void {
    const disposables = this.registrations.get(slot);
    this.registrations.delete(slot);
    this.harnesses.delete(slot);
    for (const disposable of disposables ?? []) {
      try {
        disposable.dispose();
      } catch (error) {
        this.channel.warn(
          `[acp:${slot}] error while disposing registration: ${errorMessage(error)}`,
        );
      }
    }
    this.channel.info(`[acp:${slot}] unregistered agent slot (${reason})`);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const slot of [...this.harnesses.keys()]) {
      this.unregisterSlot(slot, "registry disposed");
    }
  }
}
