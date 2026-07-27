/**
 * Temporary read-only verifier for the packaged Linux pre-runtime handoff.
 *
 * Canonical local settings live only in SQLite. This module neither writes nor
 * admits product state and should disappear with the remaining direct-file
 * startup probe.
 */

import {
  SEAL_ALG,
  sealPathsBeside,
  verifySealFile,
  type SealPaths,
  type SealVerifyStatus,
} from "../document-seal";
import type { StationSettings } from "@shared/settings";

export const TOPOLOGY_KEY_BASENAME = "topology.key";
export const TOPOLOGY_SEAL_BASENAME = "topology.seal";
export const TOPOLOGY_SEAL_VERSION = 1 as const;
export const TOPOLOGY_SEAL_ALG = SEAL_ALG;
export const TOPOLOGY_SEAL_DOMAIN = "vellum-topology-v1\0";

export type TopologyMaterial = {
  readonly role: string;
  readonly hostId: string;
  readonly agentHostId?: string;
  readonly commandCenterRef: string;
  readonly supervisedPreferred: boolean;
  readonly topologyIntegrity: string;
};

export type TopologyPaths = SealPaths;
export type TopologyVerifyStatus = SealVerifyStatus;

export const topologyPathsForSettings = (settingsPath: string): TopologyPaths =>
  sealPathsBeside(
    settingsPath,
    TOPOLOGY_KEY_BASENAME,
    TOPOLOGY_SEAL_BASENAME,
  );

export const topologyFromStation = (
  station: StationSettings,
): TopologyMaterial => ({
  role: station.role,
  hostId: station.hostId,
  ...(station.agentHostId !== undefined
    ? { agentHostId: station.agentHostId }
    : {}),
  commandCenterRef: station.commandCenterRef,
  supervisedPreferred: station.supervisedPreferred,
  topologyIntegrity: station.topologyIntegrity,
});

const canonicalizeTopology = (material: TopologyMaterial): Buffer => {
  const body: Record<string, string | boolean> = {
    commandCenterRef: material.commandCenterRef,
    hostId: material.hostId,
    role: material.role,
    supervisedPreferred: material.supervisedPreferred,
    topologyIntegrity: material.topologyIntegrity,
  };
  if (material.agentHostId !== undefined) {
    body.agentHostId = material.agentHostId;
  }
  const ordered: Record<string, string | boolean> = {};
  for (const key of Object.keys(body).sort()) {
    ordered[key] = body[key]!;
  }
  return Buffer.from(JSON.stringify(ordered), "utf8");
};

export const verifyTopologySeal = async (
  settingsPath: string,
  material: TopologyMaterial,
): Promise<TopologyVerifyStatus> =>
  verifySealFile(
    topologyPathsForSettings(settingsPath),
    TOPOLOGY_SEAL_DOMAIN,
    TOPOLOGY_SEAL_VERSION,
    TOPOLOGY_SEAL_ALG,
    canonicalizeTopology(material),
  );
