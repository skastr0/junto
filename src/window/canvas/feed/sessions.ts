/**
 * Seat and terminal session hydration, owned by the feed instead of the
 * cards: for every bound agent or terminal node on the canvas, one
 * `terminalGet` on join, a refresh on each session/exit event routed by
 * binding, and the shared poll while the session runs (lease-scoped events do
 * not reach a binding with no open surface). Writes only
 * `terminal$.sessionByBindingId` and the `agentSeat$` binding join — the same
 * two writes SeatCard and TerminalCard made.
 */
import { observe } from "@legendapp/state";
import type { TerminalSessionSummary } from "@shared/terminal";
import { agentSeat$ } from "../../lib/agent-seat-state";
import { getJuntoApi } from "../../lib/junto-api";
import { onTerminalEvent } from "../../lib/terminal-events";
import { registerTerminalSessionPoll } from "../../lib/terminal-session-poll";
import {
  sessionChromeUnchanged,
  shouldRefreshSessionFromTerminalEvent,
} from "../../lib/terminal-session-refresh";
import { terminal$ } from "../../lib/terminal-state";
import { modelStore } from "../../lib/use-model";

type Hydration = {
  readonly bindingId: string;
  readonly hostId: string | undefined;
  live: boolean;
  offEvents: () => void;
  offPoll: (() => void) | undefined;
};

const field = <T>(node$: unknown, name: string): T | undefined =>
  (node$ as Record<string, { get(): T | undefined }>)[name]?.get();

const isRunning = (session: TerminalSessionSummary | undefined): boolean =>
  session?.status === "running" || session?.status === "starting";

export const retainSeatSessions = (canvasName: string): (() => void) => {
  const hydrations = new Map<string, Hydration>();

  const applySession = (entry: Hydration, next: TerminalSessionSummary | undefined): void => {
    if (!entry.live) return;
    const prev = terminal$.sessionByBindingId[entry.bindingId].peek();
    if (!sessionChromeUnchanged(prev, next)) {
      terminal$.sessionByBindingId[entry.bindingId].set(next);
      if (next?.nodeId !== undefined) {
        agentSeat$.bindingIdByNodeId[next.nodeId].set(entry.bindingId);
      }
    }
    if (isRunning(next) && entry.offPoll === undefined) {
      entry.offPoll = registerTerminalSessionPoll(entry.bindingId, entry.hostId, (session) =>
        applySession(entry, session),
      );
    } else if (!isRunning(next) && entry.offPoll !== undefined) {
      entry.offPoll();
      entry.offPoll = undefined;
    }
  };

  const hydrate = (bindingId: string, hostId: string | undefined): void => {
    if (hydrations.has(bindingId)) return;
    const entry: Hydration = { bindingId, hostId, live: true, offEvents: () => undefined, offPoll: undefined };
    hydrations.set(bindingId, entry);
    const refresh = () =>
      getJuntoApi()
        ?.terminalGet?.(bindingId, hostId)
        .then((next) => applySession(entry, next))
        .catch(() => undefined);
    entry.offEvents = onTerminalEvent(
      (raw) => {
        if (!shouldRefreshSessionFromTerminalEvent(raw)) return;
        void refresh();
      },
      { bindingId },
    );
    void refresh();
  };

  const release = (entry: Hydration): void => {
    entry.live = false;
    entry.offEvents();
    entry.offPoll?.();
    hydrations.delete(entry.bindingId);
  };

  const offModel = observe(() => {
    const model = modelStore.canvas$(canvasName);
    const ids = model.nodeIds.get();
    const wanted = new Map<string, string | undefined>();
    for (const id of ids) {
      const node$ = model.nodes[id];
      const kind = field<string>(node$, "kind");
      if (kind !== "agent" && kind !== "terminal") continue;
      const bindingId = field<string>(node$, "bindingId");
      if (bindingId === undefined) continue;
      wanted.set(bindingId, field<string>(node$, "host"));
    }
    for (const [bindingId, entry] of [...hydrations]) {
      if (!wanted.has(bindingId)) release(entry);
    }
    for (const [bindingId, hostId] of wanted) {
      const existing = hydrations.get(bindingId);
      if (existing !== undefined && existing.hostId !== hostId) release(existing);
      hydrate(bindingId, hostId);
    }
  });

  return () => {
    offModel();
    for (const entry of [...hydrations.values()]) release(entry);
  };
};
