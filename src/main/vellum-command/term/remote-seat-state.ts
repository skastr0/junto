/**
 * Last-known Remote seat facts on Command Center.
 *
 * Spawn hosts evaluate. This cache is only what the term-control hop already
 * delivered (no PTY bytes, no extra fields) so a renderer restart can hydrate
 * Remote seats the local runtime never saw.
 */

import type { AgentSeatStateEvent } from "@shared/agent-seat-state";

const lastRemoteByBinding = new Map<string, AgentSeatStateEvent>();

export const rememberRemoteSeatState = (event: AgentSeatStateEvent): void => {
  if (event.bindingId.length === 0) return;
  lastRemoteByBinding.set(event.bindingId, event);
};

export const remoteSeatStateEvents = (): ReadonlyArray<AgentSeatStateEvent> =>
  [...lastRemoteByBinding.values()];

export const resetRemoteSeatState = (): void => {
  lastRemoteByBinding.clear();
};

/** Spawn-host (local runtime) wins on bindingId collision. */
export const mergeSeatStateSnapshot = (
  local: ReadonlyArray<AgentSeatStateEvent>,
  remote: ReadonlyArray<AgentSeatStateEvent> = remoteSeatStateEvents(),
): AgentSeatStateEvent[] => {
  const byBinding = new Map<string, AgentSeatStateEvent>();
  for (const event of remote) byBinding.set(event.bindingId, event);
  for (const event of local) byBinding.set(event.bindingId, event);
  return [...byBinding.values()].sort((left, right) =>
    left.bindingId.localeCompare(right.bindingId),
  );
};
