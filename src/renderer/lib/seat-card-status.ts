/**
 * One seat card's canonical deterministic status, derived once.
 *
 * The card body and the awareness hover both need this, and the hover's whole
 * contract is that it echoes the canonical status *unchanged*. Two derivations
 * would drift and the hover would start claiming a status the card does not
 * show, so both read this one function.
 *
 * It is presentation only: no store writes, no effects, and nothing here
 * depends on the advisory sidecar.
 */

import type { CanvasNode } from "@shared/canvas";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { resolveTerminalBinding, type TerminalSessionSummary } from "@shared/terminal";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import { presentationForSeat, type AgentSeatPresentation } from "./agent-seat-state";
import { isActiveProcessLabel } from "./activity";
import { cardMark, seatFactsForNode } from "./seat-projections";

/** Launch line for a seat with nothing else to say. */
export const launchSummary = (
  launch:
    | { readonly kind: string; readonly argv?: readonly string[] }
    | undefined,
): string => {
  if (!launch) return "shell";
  if (launch.kind === "command" && launch.argv?.length) return launch.argv.join(" ");
  return launch.kind;
};

export type SeatCardStatus = {
  readonly bindingId: string;
  readonly managedSeat: boolean;
  /** Authorial first line, else the spawn label. */
  readonly label: string;
  readonly seatState: AgentSeatStateEvent["state"] | undefined;
  readonly presentation: AgentSeatPresentation | undefined;
  /** Canonical one-line detail, exactly as the card shows it. */
  readonly subtitle: string;
  readonly activity: ReturnType<typeof cardMark>;
  readonly complete: boolean;
  readonly processLive: boolean;
  /** Foreground process label, shell chrome filtered out. */
  readonly processName: string | undefined;
};

export const seatCardStatus = (input: {
  readonly node: CanvasNode;
  readonly seatEvent: AgentSeatStateEvent | undefined;
  readonly needsLook: boolean | undefined;
  readonly session: TerminalSessionSummary | undefined;
  readonly graphBlocked: boolean;
  readonly attentionReasons: ReadonlyArray<string>;
}): SeatCardStatus | undefined => {
  const { node, seatEvent, session } = input;
  const binding = resolveTerminalBinding(node);
  const native = binding?.kind === "native" ? binding : undefined;
  if (native === undefined) return undefined;

  const firstLine =
    node.type === "text" ? (node.text.split("\n")[0] ?? "").trim() : "";
  const seatState = seatEvent?.state;
  const presentation = presentationForSeat(seatState, input.needsLook === true);
  const exitReason = session?.exitReason;
  const exitMessage = session?.exitMessage;
  const processLive = session?.status === "running" || session?.status === "starting";
  // Foreground label only: never launch argv basename (zsh) as "the process".
  const processName =
    session?.processName?.trim() || session?.title?.trim() || undefined;
  const activeProcess =
    session?.status === "starting" ||
    (session?.status === "running" && isActiveProcessLabel(processName));
  const harness =
    typeof node.ether?.terminal?.harness === "string"
      ? node.ether.terminal.harness
      : undefined;
  const managedSeat = harness !== undefined && isHarnessId(harness);
  const activity = cardMark(
    seatFactsForNode({
      nodeId: node.id,
      seatEvent,
      session,
      needsLook: input.needsLook === true,
      graphBlocked: input.graphBlocked,
      attentionReasons: input.attentionReasons,
      managedSeat,
    }),
  );
  // Prefer spawn-failure / attention reason over the raw launch argv line.
  const attentionSubtitle =
    seatState === "attention"
      ? seatEvent?.reason === "turn-stalled" || seatEvent?.reason === "prompt-stalled"
        ? "stalled — needs operator look"
        : seatEvent?.reason
      : undefined;
  const processSubtitle =
    activeProcess && processName
      ? session?.pid !== undefined
        ? `${processName} — pid ${session.pid}`
        : processName
      : undefined;
  const subtitle =
    (exitReason && exitMessage) ||
    attentionSubtitle ||
    processSubtitle ||
    (presentation === "done" ? "ready — review response" : undefined) ||
    (processLive && !activeProcess ? "seated" : undefined) ||
    launchSummary(native.launch);

  return {
    bindingId: native.bindingId,
    managedSeat,
    label: firstLine || native.label || "terminal",
    seatState,
    presentation,
    subtitle,
    activity,
    complete: activity.mode === "pulse" && activity.tone === "green",
    processLive,
    processName,
  };
};
