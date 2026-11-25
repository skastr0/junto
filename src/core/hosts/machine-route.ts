import type { RemoteHost } from "@shared/remote-hosts";

/**
 * The route a send reached a machine over, as one stable string. It holds
 * every field that decides where and how this machine dials: the SSH
 * destination, port, identity, known-hosts file and host-key alias, and the
 * install location the far answered with. Presentation and capabilities are
 * not route.
 */
export const machineRouteFingerprint = (host: RemoteHost): string => JSON.stringify([
  host.sshEndpoint ?? null,
  host.sshPort ?? null,
  host.sshIdentityFile ?? null,
  host.sshKnownHostsFile ?? null,
  host.sshHostKeyAlias ?? null,
  host.juntoHome ?? null,
  host.installRoot ?? null,
]);
