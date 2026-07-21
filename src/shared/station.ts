import type { CanvasNode } from "./canvas";
import { HostId } from "./remote-hosts";

/**
 * Station plane: this machine's durable role in a Vellum fleet.
 *
 * Product nouns (not board vocabulary):
 * - Command Center — human authors the canvas; manages fleet via host registry.
 * - Remote — local capability host; pulls canvases; host-scoped execution only.
 *
 * Role is user-selected only. Never inferred from hardware, open windows, or
 * network topology.
 */

export const STATION_ROLES = ["command-center", "remote"] as const;
export type StationRole = (typeof STATION_ROLES)[number];

/** Default host id for this machine when unset (matches seeded local host). */
export const DEFAULT_STATION_HOST_ID = "local";

/** Executable entity kinds that participate in host-scoped kernel/tool work. */
export const EXECUTABLE_ENTITY_KINDS = [
  "agent",
  "herdr",
  "page",
  "watcher",
  "timer",
] as const;
export type ExecutableEntityKind = (typeof EXECUTABLE_ENTITY_KINDS)[number];

const EXECUTABLE_KIND_SET = new Set<string>(EXECUTABLE_ENTITY_KINDS);

export const isStationRole = (value: unknown): value is StationRole =>
  value === "command-center" || value === "remote";

export const isExecutableEntityKind = (value: unknown): value is ExecutableEntityKind =>
  typeof value === "string" && EXECUTABLE_KIND_SET.has(value);

/**
 * Resolve the host id a node is assigned to execute on.
 * Precedence: ether.host (authorial stamp) → herdr.host binding → default local.
 */
export const resolveNodeHostId = (node: CanvasNode): string => {
  const ether = node.ether;
  if (!ether) return DEFAULT_STATION_HOST_ID;
  if (typeof ether.host === "string" && ether.host.length > 0) return ether.host;
  if (typeof ether.herdr?.host === "string" && ether.herdr.host.length > 0) {
    return ether.herdr.host;
  }
  return DEFAULT_STATION_HOST_ID;
};

export const isExecutableNode = (node: CanvasNode): boolean =>
  isExecutableEntityKind(node.ether?.entity?.kind);

/** True when this station may evaluate/fire/act on the node under host scoping. */
export const isNodeEligibleOnStation = (
  node: CanvasNode,
  stationHostId: string,
): boolean => {
  if (!isExecutableNode(node)) return false;
  return resolveNodeHostId(node) === stationHostId;
};

/**
 * Watcher→agent edge host rule:
 * - Command Center may target any agent.
 * - Remote may only target agents with the same host id as the watcher (and station).
 */
export const watcherMayTargetAgent = (input: {
  readonly stationRole: StationRole;
  readonly stationHostId: string;
  readonly watcherHostId: string;
  readonly agentHostId: string;
}): boolean => {
  if (input.stationRole === "command-center") return true;
  return (
    input.watcherHostId === input.stationHostId &&
    input.agentHostId === input.stationHostId
  );
};

/** Validate a host id string against the shared HostId pattern without Effect decode. */
export const isValidStationHostId = (value: string): boolean => {
  try {
    // HostId is an Effect Schema; use pattern mirror for pure callers.
    return /^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value.length <= 64;
  } catch {
    return false;
  }
};

// Re-export HostId type surface for station stamps (same alphabet as remote-hosts).
export type { HostId };
