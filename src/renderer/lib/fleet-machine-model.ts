import type { RemoteHost } from "@shared/remote-hosts";
import type { DiscoveredPeer } from "@shared/ipc";
import { GREEN, HUE } from "./theme";

export const FLEET_MACHINE_MODELS = [
  "command-core",
  "compute-tower",
  "relay-obelisk",
  "terminal-dock",
  "artifact-vault",
  "browser-lens",
  "watch-beacon",
  "chrono-drum",
  "request-gate",
  "task-foundry",
  "agent-prism",
  "remote-anchor",
  "mac-mini",
  "mac-studio",
  "macbook-pro",
] as const;

export type FleetMachineModelId = (typeof FLEET_MACHINE_MODELS)[number];

export interface FleetMachineModel {
  readonly id: FleetMachineModelId;
  readonly label: string;
  /** Stable identity tint. Operational state is painted separately. */
  readonly color: string;
}

export const FLEET_MACHINE_CATALOG: readonly FleetMachineModel[] = [
  { id: "command-core", label: "Command Core", color: HUE.amber },
  { id: "compute-tower", label: "Compute Tower", color: HUE.orange },
  { id: "relay-obelisk", label: "Relay Obelisk", color: HUE.violet },
  { id: "terminal-dock", label: "Terminal Dock", color: HUE.cyan },
  { id: "artifact-vault", label: "Artifact Vault", color: HUE.gold },
  { id: "browser-lens", label: "Browser Lens", color: HUE.indigo },
  { id: "watch-beacon", label: "Watch Beacon", color: HUE.cyan },
  { id: "chrono-drum", label: "Chrono Drum", color: HUE.violet },
  { id: "request-gate", label: "Request Gate", color: HUE.gold },
  { id: "task-foundry", label: "Task Foundry", color: HUE.orange },
  { id: "agent-prism", label: "Agent Prism", color: HUE.indigo },
  { id: "remote-anchor", label: "Remote Anchor", color: GREEN },
  { id: "mac-mini", label: "Mac mini", color: HUE.steel },
  { id: "mac-studio", label: "Mac Studio", color: HUE.cyan },
  { id: "macbook-pro", label: "MacBook Pro", color: HUE.indigo },
];

const MODEL_IDS = new Set<string>(FLEET_MACHINE_MODELS);

const LEGACY_GLYPH_MODELS: Readonly<Record<string, FleetMachineModelId>> = {
  server: "compute-tower",
  laptop: "terminal-dock",
  cpu: "task-foundry",
  satellite: "relay-obelisk",
  rocket: "agent-prism",
  globe: "browser-lens",
  star: "watch-beacon",
  orbit: "chrono-drum",
  radar: "remote-anchor",
};

const detectedAppleModel = (host: RemoteHost): FleetMachineModelId | undefined => {
  const identity = [host.id, host.label, host.endpoint, host.hermesId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/\bmac[\s._-]*studio\b/.test(identity)) return "mac-studio";
  if (/\bmac[\s._-]*mini\b/.test(identity)) return "mac-mini";
  if (/\bmacbook(?:[\s._-]*pro)?\b|\bmbp\b/.test(identity)) return "macbook-pro";
  return undefined;
};

/**
 * Resolve the presentational machine model without changing station role.
 *
 * New model ids are explicit operator choices. Apple-class host names are
 * recognized before legacy icon aliases so an existing `server` glyph does not
 * prevent a `mac-mini` host from receiving its new special-edition silhouette.
 */
export const resolveFleetMachineModel = (host: RemoteHost): FleetMachineModelId => {
  const configured = host.appearance?.glyph;
  if (configured && MODEL_IDS.has(configured)) return configured as FleetMachineModelId;
  return (
    detectedAppleModel(host) ??
    (configured ? LEGACY_GLYPH_MODELS[configured] : undefined) ??
    "compute-tower"
  );
};

export const fleetMachineLabel = (id: FleetMachineModelId): string =>
  FLEET_MACHINE_CATALOG.find((entry) => entry.id === id)?.label ?? id;

export const fleetMachineColor = (id: FleetMachineModelId): string =>
  FLEET_MACHINE_CATALOG.find((entry) => entry.id === id)?.color ?? HUE.amber;

/** Unclaimed peers stay visually distinct while still receiving a real model. */
export const resolvePeerMachineModel = (
  peer: Pick<DiscoveredPeer, "name" | "os">,
): FleetMachineModelId => {
  const os = peer.os?.trim().toLowerCase();
  if (os === "macos") return "macbook-pro";
  if (os === "ios" || os === "android") return "terminal-dock";
  if (os === "linux") return "remote-anchor";
  if (os === "windows") return "compute-tower";
  return "relay-obelisk";
};
