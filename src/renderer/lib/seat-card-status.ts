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

/**
 * What a seat or terminal card needs to know of its node, whoever holds the
 * node: the document today, the node store once a card reads from it.
 */
export type SeatFace = {
  readonly id: string;
  /** The name the operator gave it, first line only; "" when it has none. */
  readonly name: string;
  readonly bindingId: string;
  readonly harness?: string | undefined;
  readonly launch?: { readonly kind: string; readonly argv?: readonly string[] } | undefined;
  /** The label it was spawned under, shown when it has no name. */
  readonly spawnLabel?: string | undefined;
};

/** The face of a document node, or undefined when it holds no terminal. */
export const seatFaceOfNode = (node: CanvasNode): SeatFace | undefined => {
  const binding = resolveTerminalBinding(node);
  if (binding?.kind !== "native") return undefined;
  return {
    id: node.id,
    name: node.type === "text" ? (node.text.split("\n")[0] ?? "").trim() : "",
    bindingId: binding.bindingId,
    harness: typeof node.ether?.terminal?.harness === "string" ? node.ether.terminal.harness : undefined,
    launch: binding.launch,
    spawnLabel: binding.label,
  };
};

export const seatCardStatus = (input: {
  readonly face: SeatFace | undefined;
  readonly seatEvent: AgentSeatStateEvent | undefined;
  readonly needsLook: boolean | undefined;
  readonly session: TerminalSessionSummary | undefined;
  readonly graphBlocked: boolean;
  readonly attentionReasons: ReadonlyArray<string>;
}): SeatCardStatus | undefined => {
  const { face, seatEvent, session } = input;
  if (face === undefined) return undefined;

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
  const managedSeat = face.harness !== undefined && isHarnessId(face.harness);
  const activity = cardMark(
    seatFactsForNode({
      nodeId: face.id,
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
    launchSummary(face.launch);

  return {
    bindingId: face.bindingId,
    managedSeat,
    label: face.name || face.spawnLabel || "terminal",
    seatState,
    presentation,
    subtitle,
    activity,
    complete: activity.mode === "pulse" && activity.tone === "green",
    processLive,
    processName,
  };
};
