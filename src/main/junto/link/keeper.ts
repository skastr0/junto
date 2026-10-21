/**
 * The link keeper, on the machine that dials: a link that dropped while the
 * other machine holds a seat on a canvas this one holds is dialed again
 * until it opens, so rows held at either end move without waiting for the
 * next read that happens to open it. This end cannot see what the other one
 * holds, so the link is kept, not the rows.
 *
 * - Only pinned peers are dialed, selected by placement; a peer that shares
 *   no canvas is never dialed.
 * - A Boat machine is left to the Boat keeper, which wakes it for its mail.
 * - A peer that keeps failing is dialed after 10 s, then 20 s, doubling to
 *   5 min; a link that opens resets it. Only a change between linked and
 *   failing is logged.
 */
import type { InstallationId } from "@shared/installation-id";
import type { RemoteHost } from "@shared/remote-hosts";
import { encodeError } from "../failure-encode";

export const LINK_KEEPER_EVERY_MS = 10_000;
export const LINK_KEEPER_BACKOFF_CAP_MS = 5 * 60_000;

export interface LinkKeeperPeer {
  readonly machineName: string;
  readonly installationId: InstallationId;
}

export interface LinkKeeperDeps {
  /** This machine's name, for a failure that names no peer. */
  readonly self: string;
  readonly peers: () => Promise<ReadonlyArray<LinkKeeperPeer>>;
  /** Is a row link open to that machine right now. */
  readonly linked: (peer: InstallationId) => boolean;
  /** Should a link to that machine be open: it shares work with this one. */
  readonly wanted: (peer: LinkKeeperPeer) => Promise<boolean>;
  readonly boatMachines: () => Promise<ReadonlySet<string>>;
  readonly getHost: (name: string) => Promise<RemoteHost | undefined>;
  readonly connect: (host: RemoteHost) => Promise<void>;
  readonly log: (level: "Info" | "Warning", message: string, fields: Record<string, unknown>) => void;
  readonly now?: () => number;
  readonly every?: number;
}

interface Failing {
  readonly failures: number;
  readonly nextAt: number;
}

export interface LinkKeeper {
  /** One pass over every peer; answers which were dialed. */
  readonly pass: () => Promise<ReadonlyArray<string>>;
}

export const makeLinkKeeper = (deps: LinkKeeperDeps): LinkKeeper => {
  const every = deps.every ?? LINK_KEEPER_EVERY_MS;
  const now = deps.now ?? Date.now;
  const failing = new Map<string, Failing>();
  const recovered = (name: string): void => {
    if (!failing.delete(name)) return;
    deps.log("Info", "link keeper reached the machine again", { machine: name });
  };
  const visit = async (peer: LinkKeeperPeer, boat: ReadonlySet<string>): Promise<boolean> => {
    const name = peer.machineName;
    if (deps.linked(peer.installationId)) { recovered(name); return false; }
    if (boat.has(name)) return false;
    const held = failing.get(name);
    if (held !== undefined && now() < held.nextAt) return false;
    if (!await deps.wanted(peer)) return false;
    const host = await deps.getHost(name);
    if (host === undefined || host.isThisMachine) return false;
    try {
      await deps.connect(host);
      recovered(name);
    } catch (cause) {
      const failures = (held?.failures ?? 0) + 1;
      failing.set(name, { failures, nextAt: now() + Math.min(every * 2 ** (failures - 1), LINK_KEEPER_BACKOFF_CAP_MS) });
      if (held === undefined) deps.log("Warning", "link keeper cannot reach the machine", { machine: name, failure: encodeError(cause, { machine: name }) });
    }
    return true;
  };
  return {
    pass: async () => {
      const boat = await deps.boatMachines();
      const peers = await deps.peers();
      const dialed = await Promise.all(peers.map((peer) => visit(peer, boat)));
      for (const name of failing.keys()) if (!peers.some((peer) => peer.machineName === name)) failing.delete(name);
      return peers.filter((_, index) => dialed[index]).map((peer) => peer.machineName);
    },
  };
};

/** Runs the keeper while this machine runs; answers how to stop it. */
export const startLinkKeeper = (deps: LinkKeeperDeps): (() => void) => {
  const keeper = makeLinkKeeper(deps);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void keeper.pass()
        .catch((cause: unknown) => deps.log("Warning", "link keeper pass failed", { machine: deps.self, failure: encodeError(cause, { machine: deps.self }) }))
        .finally(schedule);
    }, deps.every ?? LINK_KEEPER_EVERY_MS);
    timer.unref?.();
  };
  schedule();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
};
