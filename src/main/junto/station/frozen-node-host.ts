import { DEFAULT_STATION_HOST_ID, hostIdFromAgentKey } from "@shared/station";

// The station's frozen reading of a document node's host. Nothing outside the
// station reads a document node; a model node names its host in its own field.

/**
 * Resolve the host id a node is assigned to execute on.
 * Precedence:
 *   ether.host (authorial stamp)
 *   → agent key host prefix (hermes `<host>:<profile>`)
 *   → default local
 */
export const resolveNodeHostId = (node: {
  readonly ether?: {
    readonly host?: string;
    readonly entity?: { readonly kind?: string; readonly name?: string };
  };
}): string => {
  const ether = node.ether;
  if (!ether) return DEFAULT_STATION_HOST_ID;
  if (typeof ether.host === "string" && ether.host.length > 0) return ether.host;
  // Native terminals use ether.host only (binding has no host field).
  if (ether.entity?.kind === "agent") {
    const fromKey = hostIdFromAgentKey(ether.entity.name);
    if (fromKey !== undefined) return fromKey;
  }
  return DEFAULT_STATION_HOST_ID;
};
