/**
 * A seat's declared signals (escalate, blocked, feedback) in its own
 * snapshot: each one opening or closing is a SeatReported on the slot of the
 * seat that raised it, so its needs carry the seat's claim. A generation
 * that binds to a seat picks up the signals already open there.
 */
import type { AgentSeatStateEvent } from "../../../../shared/agent-seat-state";
import type { AgentSignal } from "../../../../shared/wire/agent-signals";

export type SeatReportsDeps = {
  /** This machine's live seats and the canvas node each occupies. */
  readonly sessions: () => ReadonlyArray<{
    readonly bindingId: string;
    readonly epoch: string;
    readonly canvasName?: string;
    readonly nodeId?: string;
    readonly status: string;
  }>;
  readonly seatReported: (
    bindingId: string,
    report: { readonly signalId: string; readonly kind: AgentSignal["kind"]; readonly open: boolean; readonly text?: string },
  ) => unknown;
  readonly subscribeSeatState: (listener: (event: AgentSeatStateEvent) => void) => () => void;
  readonly onSignalChanged: (listener: (signal: AgentSignal) => void) => () => void;
  /** The signals on one seat, open and recently closed. */
  readonly signalsOf: (canvasName: string, nodeId: string) => Promise<ReadonlyArray<AgentSignal>>;
};

const report = (signal: AgentSignal) => ({
  signalId: signal.signalId,
  kind: signal.kind,
  open: signal.state === "open",
  text: signal.text,
});

export const wireSeatReports = (deps: SeatReportsDeps): (() => void) => {
  const live = () => deps.sessions().filter((session) => session.status !== "exited" && session.status !== "missing");
  // The generation and seat each binding last picked up open signals for.
  const seeded = new Map<string, string>();

  const offSignals = deps.onSignalChanged((signal) => {
    for (const session of live()) {
      if (session.canvasName === signal.canvasName && session.nodeId === signal.nodeId) {
        deps.seatReported(session.bindingId, report(signal));
      }
    }
  });

  const offStates = deps.subscribeSeatState((event) => {
    if (event.state === "gone") {
      seeded.delete(event.bindingId);
      return;
    }
    const session = live().find((candidate) => candidate.bindingId === event.bindingId);
    if (session?.canvasName === undefined || session.nodeId === undefined) return;
    const key = `${session.epoch}\u0000${session.canvasName}\u0000${session.nodeId}`;
    if (seeded.get(event.bindingId) === key) return;
    seeded.set(event.bindingId, key);
    const { canvasName, nodeId } = session;
    void deps.signalsOf(canvasName, nodeId).then(
      (signals) => {
        if (seeded.get(event.bindingId) !== key) return;
        for (const signal of signals) {
          if (signal.state === "open") deps.seatReported(event.bindingId, report(signal));
        }
      },
      () => undefined,
    );
  });

  return () => {
    offSignals();
    offStates();
    seeded.clear();
  };
};
