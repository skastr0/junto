/**
 * Last-known Remote seat facts on Command Center.
 *
 * Spawn hosts evaluate. This cache is only what the term-control hop already
 * delivered (no PTY bytes, no extra fields) so a renderer restart can hydrate
 * Remote seats the local runtime never saw.
 *
 * The remembered state is one service's, provided by a Layer: which event a
 * binding keeps is its epoch, then its `at`, never the order events arrived.
 */

import { Context, Layer } from "effect";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import type { InstallationId } from "@shared/installation-id";

/** What the seats link says of a remote machine's seats: one seat's state, or that the link to it is lost. */
export type RemoteSeatFeed =
  | { readonly _tag: "State"; readonly machine: InstallationId; readonly event: AgentSeatStateEvent }
  | { readonly _tag: "Lost"; readonly machine: InstallationId };

export class RemoteSeatState extends Context.Service<RemoteSeatState, {
  /** Remember a seat state its machine reported; a binding keeps the later event by epoch, then `at`. */
  readonly remember: (event: AgentSeatStateEvent) => void;
  /** A remote seat's state arrived from its machine: remember it and tell the window. */
  readonly publish: (event: AgentSeatStateEvent, machine?: InstallationId) => void;
  /** The link to that machine is lost: its seats are not heard until it says more. */
  readonly linkLost: (machine: InstallationId) => void;
  /** Told each remote seat's state as its machine reports it over the link. */
  readonly onState: (listener: (event: AgentSeatStateEvent) => void) => () => void;
  /** Told each remote seat's state with its machine, and each link to a seat's machine that is lost. */
  readonly onFeed: (listener: (feed: RemoteSeatFeed) => void) => () => void;
  /** Each remote seat's last state with the machine that sent it, for a cold start. */
  readonly feeds: () => ReadonlyArray<{ readonly machine: InstallationId; readonly event: AgentSeatStateEvent }>;
  readonly events: () => ReadonlyArray<AgentSeatStateEvent>;
  /** Whether the machine running this seat last reported an occupant for it. */
  readonly occupied: (bindingId: string) => boolean;
  readonly reset: () => void;
}>()("@junto/RemoteSeatState") {}

/**
 * Epochs are minted with their machine's clock in the id (`ep_<ms>_<hex>`), so
 * the later reading of one seat sorts after the earlier; `at` settles two of
 * one epoch. Arrival order decides nothing.
 */
const isLater = (held: AgentSeatStateEvent | undefined, candidate: AgentSeatStateEvent): boolean =>
  held === undefined || candidate.epoch > held.epoch ||
  (candidate.epoch === held.epoch && candidate.at > held.at);

/** One remote seat state's memory: the maps and listeners a Layer holds for the core. */
export const makeRemoteSeatState = (): RemoteSeatState["Service"] => {
  const lastRemoteByBinding = new Map<string, AgentSeatStateEvent>();
  const remoteListeners = new Set<(event: AgentSeatStateEvent) => void>();
  const machineByBinding = new Map<string, InstallationId>();
  const feedListeners = new Set<(feed: RemoteSeatFeed) => void>();

  const remember = (event: AgentSeatStateEvent): void => {
    if (event.bindingId.length === 0) return;
    if (!isLater(lastRemoteByBinding.get(event.bindingId), event)) return;
    lastRemoteByBinding.set(event.bindingId, event);
  };

  return RemoteSeatState.of({
    remember,
    publish: (event, machine) => {
      remember(event);
      if (machine !== undefined && event.bindingId.length > 0) {
        machineByBinding.set(event.bindingId, machine);
        for (const listener of feedListeners) listener({ _tag: "State", machine, event });
      }
      for (const listener of remoteListeners) listener(event);
    },
    linkLost: (machine) => {
      for (const listener of feedListeners) listener({ _tag: "Lost", machine });
    },
    onState: (listener) => {
      remoteListeners.add(listener);
      return () => { remoteListeners.delete(listener); };
    },
    onFeed: (listener) => {
      feedListeners.add(listener);
      return () => { feedListeners.delete(listener); };
    },
    feeds: () => [...lastRemoteByBinding.values()].flatMap((event) => {
      const machine = machineByBinding.get(event.bindingId);
      return machine === undefined ? [] : [{ machine, event }];
    }),
    events: () => [...lastRemoteByBinding.values()],
    occupied: (bindingId) => {
      const event = lastRemoteByBinding.get(bindingId);
      return event !== undefined && event.state !== "gone";
    },
    reset: () => {
      lastRemoteByBinding.clear();
      machineByBinding.clear();
    },
  });
};

export const RemoteSeatStateLive = Layer.sync(RemoteSeatState, makeRemoteSeatState);

/** Whether the machine running this seat last reported an occupant for it. */
export const remoteSeatOccupied = (
  bindingId: string,
  remote: ReadonlyArray<AgentSeatStateEvent>,
): boolean => remote.some((event) => event.bindingId === bindingId && event.state !== "gone");

/** Spawn-host (local runtime) wins on bindingId collision. */
export const mergeSeatStateSnapshot = (
  local: ReadonlyArray<AgentSeatStateEvent>,
  remote: ReadonlyArray<AgentSeatStateEvent>,
): AgentSeatStateEvent[] => {
  const byBinding = new Map<string, AgentSeatStateEvent>();
  for (const event of remote) byBinding.set(event.bindingId, event);
  for (const event of local) byBinding.set(event.bindingId, event);
  return [...byBinding.values()].sort((left, right) =>
    left.bindingId.localeCompare(right.bindingId),
  );
};
