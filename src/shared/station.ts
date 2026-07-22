import type { CanvasDoc, CanvasNode } from "./canvas";
import type { HostId } from "./remote-hosts";

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
  "terminal",
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
 * Hermes agent keys are `<host>:<profile>`. Extract host when well-formed.
 * Does not invent hosts from free-form labels.
 */
export const hostIdFromAgentKey = (key: string | undefined): string | undefined => {
  if (typeof key !== "string" || key.length === 0) return undefined;
  const colon = key.indexOf(":");
  if (colon <= 0) return undefined;
  const host = key.slice(0, colon);
  return isValidStationHostId(host) ? host : undefined;
};

/**
 * Resolve the host id a node is assigned to execute on.
 * Precedence:
 *   ether.host (authorial stamp)
 *   → herdr.host binding
 *   → agent key host prefix (hermes `<host>:<profile>`)
 *   → default local
 */
export const resolveNodeHostId = (node: CanvasNode): string => {
  const ether = node.ether;
  if (!ether) return DEFAULT_STATION_HOST_ID;
  if (typeof ether.host === "string" && ether.host.length > 0) return ether.host;
  if (typeof ether.herdr?.host === "string" && ether.herdr.host.length > 0) {
    return ether.herdr.host;
  }
  // Native terminals use ether.host only (binding has no host field).
  if (ether.entity?.kind === "agent") {
    const fromKey = hostIdFromAgentKey(ether.entity.name);
    if (fromKey !== undefined) return fromKey;
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
export const isValidStationHostId = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 64 &&
  /^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

// ---------------------------------------------------------------------------
// Supervised runtime preference vs LaunchAgent install (Remote 24×7 foundation)
//
// Product surface: settings.station.supervisedPreferred (StationRoleGate sets
// true for Remote). Install surface: `bun run app:install:supervised` /
// install-app.sh --supervised → install-launchd.sh. Doctor reports the gap;
// full Remote deploy of the agent is a later glyph — not this module.
// ---------------------------------------------------------------------------

/** Whether the Vellum LaunchAgent is loaded for this user domain. */
export type SupervisedInstallState = "installed" | "absent" | "unknown";

export type SupervisedRuntimeInput = {
  readonly role: string;
  readonly hostId: string;
  readonly supervisedPreferred: boolean;
  readonly supervisedInstalled: SupervisedInstallState;
};

export type SupervisedRuntimeAssessment = {
  readonly role: string;
  readonly hostId: string;
  readonly supervisedPreferred: boolean;
  readonly supervisedInstalled: SupervisedInstallState;
  /** Preferred intent matches observed install (unknown is never aligned when preferred). */
  readonly aligned: boolean;
  readonly status: "ok" | "warning";
  readonly detail: string;
  /** ServiceCheck.metadata — all string values. */
  readonly metadata: Readonly<Record<string, string>>;
};

/**
 * Pure reconciliation of station supervised preference vs LaunchAgent state.
 * No I/O — callers probe launchctl (or inject a test double).
 */
export const assessSupervisedRuntime = (
  input: SupervisedRuntimeInput,
): SupervisedRuntimeAssessment => {
  const role = input.role;
  const hostId = input.hostId;
  const preferred = input.supervisedPreferred;
  const installed = input.supervisedInstalled;

  let aligned: boolean;
  let status: "ok" | "warning";
  let detail: string;

  if (installed === "unknown") {
    aligned = !preferred;
    if (preferred) {
      status = "warning";
      detail = "supervised preferred but LaunchAgent state unknown";
    } else {
      status = "ok";
      detail = "supervised not preferred; LaunchAgent state unknown";
    }
  } else if (preferred && installed === "installed") {
    aligned = true;
    status = "ok";
    detail = "supervised preferred and LaunchAgent loaded";
  } else if (!preferred && installed === "absent") {
    aligned = true;
    status = "ok";
    detail = "unsupervised preferred; LaunchAgent absent";
  } else if (preferred && installed === "absent") {
    aligned = false;
    status = "warning";
    detail =
      role === "remote"
        ? "Remote prefers supervised runtime — run bun run app:install:supervised"
        : "supervised preferred but LaunchAgent not loaded — bun run app:install:supervised";
  } else {
    // !preferred && installed === "installed"
    aligned = false;
    status = "ok";
    detail = "LaunchAgent loaded; preference is unsupervised";
  }

  const roleKey = role.length > 0 ? role : "unset";
  return {
    role: roleKey,
    hostId,
    supervisedPreferred: preferred,
    supervisedInstalled: installed,
    aligned,
    status,
    detail,
    metadata: {
      role: roleKey,
      hostId,
      supervisedPreferred: preferred ? "true" : "false",
      supervisedInstalled: installed,
      supervisedAligned: aligned ? "true" : "false",
    },
  };
};

/**
 * Agent keys reachable from a watcher via soft relates edges (either direction).
 * Command Center may target any agent host; Remote only same-host agents.
 * Empty when no edges — region membership alone is not a fire router.
 */
export const agentKeysForWatcher = (
  doc: CanvasDoc,
  watcherNodeId: string,
  stationRole: StationRole,
  stationHostId: string,
): ReadonlyArray<string> => {
  const watcher = doc.nodes.find((node) => node.id === watcherNodeId);
  if (!watcher) return [];
  const watcherHostId = resolveNodeHostId(watcher);
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const edge of doc.edges) {
    if (edge.fromNode !== watcherNodeId && edge.toNode !== watcherNodeId) continue;
    const otherId = edge.fromNode === watcherNodeId ? edge.toNode : edge.fromNode;
    const other = doc.nodes.find((node) => node.id === otherId);
    if (!other || other.ether?.entity?.kind !== "agent") continue;
    const name = other.ether.entity.name;
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
    const agentHostId = resolveNodeHostId(other);
    if (
      !watcherMayTargetAgent({
        stationRole,
        stationHostId,
        watcherHostId,
        agentHostId,
      })
    ) {
      continue;
    }
    if (stationRole === "remote" && agentHostId !== stationHostId) continue;
    seen.add(name);
    keys.push(name);
  }
  return keys;
};

/** Timer sources deliver to same-host agents edged from the timer, same rules. */
export const agentKeysForExecutableSource = (
  doc: CanvasDoc,
  sourceNodeId: string,
  stationRole: StationRole,
  stationHostId: string,
): ReadonlyArray<string> => agentKeysForWatcher(doc, sourceNodeId, stationRole, stationHostId);

// Re-export HostId type surface for station stamps (same alphabet as remote-hosts).
export type { HostId };
