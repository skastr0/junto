import {
  defaultRemoteHostsDocument,
  hermesKeyFor,
  hostHasCapability,
  type HostCapability,
  type RemoteHost,
} from "@shared/remote-hosts";
import { getDefaultHostsRegistry } from "./registry";

/** Process-local snapshot so herdr/hermes hot paths stay sync. */
let snapshot: ReadonlyArray<RemoteHost> = defaultRemoteHostsDocument().hosts;

export const hostsSnapshot = (): ReadonlyArray<RemoteHost> => snapshot;

export const setHostsSnapshot = (hosts: ReadonlyArray<RemoteHost>): void => {
  snapshot = hosts;
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
  if (!host || host.kind !== "remote") return undefined;
  return host.endpoint;
};

export const sshEndpointForHermesId = (hermesId: string): string | undefined => {
  const host = findHostByHermesId(hermesId);
  if (!host || host.kind !== "remote") return undefined;
  return host.endpoint;
};

/** Load durable registry into the sync snapshot (boot + after mutations). */
export const primeHostsSnapshot = async (): Promise<ReadonlyArray<RemoteHost>> => {
  const hosts = await getDefaultHostsRegistry().list();
  snapshot = hosts;
  return hosts;
};
