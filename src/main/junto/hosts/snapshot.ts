import {
  defaultRemoteHostsDocument,
  hermesKeyFor,
  hostHasCapability,
  projectMachines,
  type HostCapability,
  type RemoteHost,
} from "@shared/remote-hosts";
import { getDefaultHostsRegistry } from "./registry";

/** Process-local snapshot so hermes hot paths stay sync. */
let snapshot: ReadonlyArray<RemoteHost> = defaultRemoteHostsDocument().hosts;
const listeners = new Set<(
  hosts: ReadonlyArray<RemoteHost>,
  previous: ReadonlyArray<RemoteHost>,
) => void>();

const sameHosts = (
  left: ReadonlyArray<RemoteHost>,
  right: ReadonlyArray<RemoteHost>,
): boolean => JSON.stringify(left) === JSON.stringify(right);

export const hostsSnapshot = (): ReadonlyArray<RemoteHost> => snapshot;

export const setHostsSnapshot = (hosts: ReadonlyArray<RemoteHost>): void => {
  // Own capabilities are process fact; identity comes from the hydrated row.
  const next = projectMachines(hosts);
  const previous = snapshot;
  snapshot = next;
  if (sameHosts(previous, next)) return;
  for (const listener of listeners) {
    try {
      listener(next, previous);
    } catch {
      // A durable mutation has already committed. Keep notifying independent
      // consumers and never echo host data or endpoint-bearing exceptions.
      console.warn("[junto:hosts] routing snapshot listener failed");
    }
  }
};

export const subscribeHostsSnapshot = (
  listener: (
    hosts: ReadonlyArray<RemoteHost>,
    previous: ReadonlyArray<RemoteHost>,
  ) => void,
): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const hostsWithCapability = (
  capability: HostCapability,
): ReadonlyArray<RemoteHost> =>
  snapshot.filter((host) => hostHasCapability(host, capability));

export const findHostById = (id: string): RemoteHost | undefined =>
  snapshot.find((host) => host.id === id);

export const findHostByHermesId = (hermesId: string): RemoteHost | undefined =>
  snapshot.find(
    (host) =>
      hostHasCapability(host, "hermes") && hermesKeyFor(host) === hermesId,
  );

export const sshEndpointForHostId = (id: string): string | undefined => {
  const host = findHostById(id);
  if (!host || host.isThisMachine) return undefined;
  return host.sshEndpoint;
};

export const sshEndpointForHermesId = (hermesId: string): string | undefined => {
  const host = findHostByHermesId(hermesId);
  if (!host || host.isThisMachine) return undefined;
  return host.sshEndpoint;
};

/** Load durable registry into the sync snapshot (boot + after mutations). */
export const primeHostsSnapshot = async (): Promise<ReadonlyArray<RemoteHost>> => {
  const hosts = await getDefaultHostsRegistry().reload();
  setHostsSnapshot(hosts);
  return hosts;
};
