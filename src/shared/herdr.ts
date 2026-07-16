// Pure herdr product logic: connection state machine + delete lifecycle.
// No Node, no Electron — unit-tested and shared by main + renderer.

export type HerdrConnectionState = "connected" | "degraded" | "lost" | "failed";

export type HerdrConnectionEvent =
  | { readonly type: "ok" }
  | { readonly type: "stream_drop" }
  | { readonly type: "host_unreachable" }
  | { readonly type: "pane_missing" }
  | { readonly type: "pane_closed" }
  | { readonly type: "reconnect_exhausted" }
  | { readonly type: "manual_fail" }
  | { readonly type: "reconnect_start" }
  | { readonly type: "reconnected" };

export interface HerdrConnectionMachine {
  readonly state: HerdrConnectionState;
  readonly reconnectAttempts: number;
  readonly maxReconnectAttempts: number;
}

export const initialHerdrConnection = (
  maxReconnectAttempts = 5,
): HerdrConnectionMachine => ({
  state: "connected",
  reconnectAttempts: 0,
  maxReconnectAttempts,
});

/**
 * Transition table for the herdr connection card/stream state machine.
 * Host unreachable stays degraded (not lost) until pane absence is confirmed.
 */
export const reduceHerdrConnection = (
  machine: HerdrConnectionMachine,
  event: HerdrConnectionEvent,
): HerdrConnectionMachine => {
  switch (event.type) {
    case "ok":
    case "reconnected":
      return { ...machine, state: "connected", reconnectAttempts: 0 };
    case "stream_drop":
    case "host_unreachable":
      if (machine.state === "lost" || machine.state === "failed") return machine;
      return { ...machine, state: "degraded" };
    case "reconnect_start": {
      if (machine.state === "lost" || machine.state === "failed") return machine;
      const attempts = machine.reconnectAttempts + 1;
      if (attempts > machine.maxReconnectAttempts) {
        return { ...machine, state: "failed", reconnectAttempts: attempts };
      }
      return { ...machine, state: "degraded", reconnectAttempts: attempts };
    }
    case "reconnect_exhausted":
    case "manual_fail":
      return { ...machine, state: "failed" };
    case "pane_missing":
    case "pane_closed":
      return { ...machine, state: "lost", reconnectAttempts: 0 };
    default:
      return machine;
  }
};

export const shouldAutoReconnect = (machine: HerdrConnectionMachine): boolean =>
  machine.state === "degraded" && machine.reconnectAttempts < machine.maxReconnectAttempts;

export type HerdrDeleteAction = "detach" | "kill-pane" | "noop";

/**
 * Decision matrix for node delete / kill UI.
 * Default onDelete is detach — never session stop from casual UI.
 */
export const herdrDeleteAction = (input: {
  readonly onDelete?: "detach" | "kill-pane";
  readonly paneId?: string;
  readonly explicitKill?: boolean;
}): HerdrDeleteAction => {
  if (input.explicitKill) {
    return input.paneId ? "kill-pane" : "noop";
  }
  const policy = input.onDelete ?? "detach";
  if (policy === "kill-pane") {
    return input.paneId ? "kill-pane" : "detach";
  }
  return "detach";
};
