/**
 * Last-known Remote seat facts on Command Center.
 *
 * Spawn hosts evaluate. This cache is only what the term-control hop already
 * delivered (no PTY bytes, no extra fields) so a renderer restart can hydrate
 * Remote seats the local runtime never saw.
 */

import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import type { InstallationId } from "@shared/installation-id";

const lastRemoteByBinding = new Map<string, AgentSeatStateEvent>();

export const rememberRemoteSeatState = (event: AgentSeatStateEvent): void => {
  if (event.bindingId.length === 0) return;
  lastRemoteByBinding.set(event.bindingId, event);
};

const remoteListeners = new Set<(event: AgentSeatStateEvent) => void>();

/** Told each remote seat's state as its machine reports it over the link. */
export const onRemoteSeatState = (listener: (event: AgentSeatStateEvent) => void): (() => void) => {
  remoteListeners.add(listener);
  return () => { remoteListeners.delete(listener); };
};

/** What the seats link says of a remote machine's seats: one seat's state, or that the link to it is lost. */
export type RemoteSeatFeed =
  | { readonly _tag: "State"; readonly machine: InstallationId; readonly event: AgentSeatStateEvent }
  | { readonly _tag: "Lost"; readonly machine: InstallationId };

const machineByBinding = new Map<string, InstallationId>();
const feedListeners = new Set<(feed: RemoteSeatFeed) => void>();

/** Told each remote seat's state with its machine, and each link to a seat's machine that is lost. */
export const onRemoteSeatFeed = (listener: (feed: RemoteSeatFeed) => void): (() => void) => {
  feedListeners.add(listener);
  return () => { feedListeners.delete(listener); };
};

/** A remote seat's state arrived from its machine: remember it and tell the window. */
export const publishRemoteSeatState = (event: AgentSeatStateEvent, machine?: InstallationId): void => {
  rememberRemoteSeatState(event);
  if (machine !== undefined && event.bindingId.length > 0) {
    machineByBinding.set(event.bindingId, machine);
    for (const listener of feedListeners) listener({ _tag: "State", machine, event });
  }
  for (const listener of remoteListeners) listener(event);
};

/** The link to that machine is lost: its seats are not heard until it says more. */
export const remoteSeatLinkLost = (machine: InstallationId): void => {
  for (const listener of feedListeners) listener({ _tag: "Lost", machine });
};

/** Each remote seat's last state with the machine that sent it, for a cold start. */
export const remoteSeatStateFeeds = (): ReadonlyArray<{ readonly machine: InstallationId; readonly event: AgentSeatStateEvent }> =>
  [...lastRemoteByBinding.values()].flatMap((event) => {
    const machine = machineByBinding.get(event.bindingId);
    return machine === undefined ? [] : [{ machine, event }];
  });

export const remoteSeatStateEvents = (): ReadonlyArray<AgentSeatStateEvent> =>
  [...lastRemoteByBinding.values()];

/** Whether the machine running this seat last reported an occupant for it. */
export const remoteSeatOccupied = (
  bindingId: string,
  remote: ReadonlyArray<AgentSeatStateEvent> = remoteSeatStateEvents(),
): boolean => remote.some((event) => event.bindingId === bindingId && event.state !== "gone");

export const resetRemoteSeatState = (): void => {
  lastRemoteByBinding.clear();
  machineByBinding.clear();
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
