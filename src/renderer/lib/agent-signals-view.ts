import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import {
  AGENT_SIGNAL_SEVERITY,
  type AgentSignal,
  type AgentSignalKind,
} from "@shared/agent-signals";
import { requestSectionReveal } from "./sidebar-sections";
import { state$ } from "./state";
import { openTerminalSurface } from "./terminal-state";

/**
 * How the seat sidebar reads and answers agent signals. The sidebar talks to
 * this one adapter; the signal store and IPC plug in behind it.
 */

/** Sidebar section key the reveal hook targets. */
export const SIGNALS_SECTION = "signals";

/** Same hues as the canvas badge: blocked crimson, escalate amber, feedback cyan. */
export const SIGNAL_KIND_TONE: Readonly<Record<AgentSignalKind, "crimson" | "amber" | "cyan">> = {
  blocked: "crimson",
  escalate: "amber",
  feedback: "cyan",
};

export const SIGNAL_KIND_LABEL: Readonly<Record<AgentSignalKind, string>> = {
  blocked: "blocked",
  escalate: "escalate",
  feedback: "feedback",
};

/** Open first, worst kind first, newest first; then closed, newest closure first. */
export const orderSignals = (signals: ReadonlyArray<AgentSignal>): ReadonlyArray<AgentSignal> =>
  [...signals].sort((a, b) => {
    const aOpen = a.state === "open";
    const bOpen = b.state === "open";
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    if (aOpen) {
      const severity = AGENT_SIGNAL_SEVERITY[b.kind] - AGENT_SIGNAL_SEVERITY[a.kind];
      if (severity !== 0) return severity;
      return b.createdAt - a.createdAt;
    }
    return (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt);
  });

export type SeatSignalSummary = {
  readonly signals: ReadonlyArray<AgentSignal>;
  readonly openCount: number;
  /** Worst open kind, for the section count tone. */
  readonly worstOpen: AgentSignalKind | undefined;
};

export const summarizeSeatSignals = (
  signals: ReadonlyArray<AgentSignal>,
  canvasName: string,
  nodeId: string,
): SeatSignalSummary => {
  const mine = orderSignals(
    signals.filter((signal) => signal.canvasName === canvasName && signal.nodeId === nodeId),
  );
  const open = mine.filter((signal) => signal.state === "open");
  return { signals: mine, openCount: open.length, worstOpen: open[0]?.kind };
};

/** A closed signal's one-line outcome for the row. */
export const signalOutcomeLabel = (signal: AgentSignal): string | undefined => {
  if (signal.state === "answered") return "answered";
  if (signal.state === "dismissed") return "dismissed";
  if (signal.state === "withdrawn") return "withdrawn by agent";
  return undefined;
};

// --- data source ---------------------------------------------------------
// Until the signal store lands this holds nothing and the actions report
// that signals are not wired. Swap `signalSource` for the real store.

export type SignalActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

type SignalSource = {
  readonly all: () => ReadonlyArray<AgentSignal>;
  readonly respond: (signalId: string, text: string) => Promise<SignalActionResult>;
  readonly dismiss: (signalId: string) => Promise<SignalActionResult>;
};

const stubSignals$ = observable<Record<string, AgentSignal>>({});

const NOT_WIRED: SignalActionResult = { ok: false, message: "Signals are not connected yet." };

const signalSource: SignalSource = {
  all: () => Object.values(stubSignals$.get()),
  respond: async () => NOT_WIRED,
  dismiss: async () => NOT_WIRED,
};

/** Signals for one seat, ordered for the sidebar, plus its actions. */
export const useSeatSignals = (
  canvasName: string,
  nodeId: string,
): SeatSignalSummary & Pick<SignalSource, "respond" | "dismiss"> => {
  const all = use$(() => signalSource.all());
  return {
    ...summarizeSeatSignals(all, canvasName, nodeId),
    respond: signalSource.respond,
    dismiss: signalSource.dismiss,
  };
};

/** Open the seat's focus modal with the Signals section expanded and in view. */
export const openSeatSignals = (node: CanvasNode): void => {
  requestSectionReveal(node.id, SIGNALS_SECTION);
  openTerminalSurface(node, "focus", state$.canvasName.peek());
};
