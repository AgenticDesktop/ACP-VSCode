import type { AcpPermissionOption, AcpPermissionUpdate } from "../acp/types";

/**
 * Pure bridge-layer mapping for ACP permission responses. Extracted from
 * {@link "./permissions"}' QuickPick flow so it can be unit-tested in plain
 * Node without VS Code.
 */

function isRejectKind(kind: AcpPermissionOption["kind"]): boolean {
  return kind === "reject_once" || kind === "reject_always";
}

/**
 * Maps a chosen permission option (identified by its toolCallId + kind, the
 * option identity in the harness-internal model) onto per-option outcome
 * updates: the chosen option becomes `selected`; every other option becomes
 * `rejected` when the chosen option is a reject-kind, `pending` otherwise.
 * Options may span multiple toolCallIds; the rule is applied per option
 * across all of them.
 */
export function computePermissionOutcomes(
  options: readonly AcpPermissionOption[],
  chosenToolCallId: string,
  chosenKind: AcpPermissionOption["kind"],
): AcpPermissionUpdate[] {
  const chosenIsReject = isRejectKind(chosenKind);
  let chosenSeen = false;
  return options.map((option): AcpPermissionUpdate => {
    if (
      !chosenSeen &&
      option.toolCallId === chosenToolCallId &&
      option.kind === chosenKind
    ) {
      chosenSeen = true;
      return { toolCallId: option.toolCallId, outcome: "selected", kind: option.kind };
    }
    return {
      toolCallId: option.toolCallId,
      outcome: chosenIsReject ? "rejected" : "pending",
      kind: option.kind,
    };
  });
}
