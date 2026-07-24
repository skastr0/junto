/**
 * Topology seal — Phase 3 first cut of protected station topology.
 *
 * Mental model:
 * - **prefs** (appearance, canvas, kernel, browser, audio, advanced) may live
 *   in ambient `settings.json` and are mutable via generic settingsPatch.
 * - **topology** (station.role, hostId, agentHostId, commandCenterRef,
 *   supervisedPreferred, topologyIntegrity) must not be mutably trusted from
 *   an offline plaintext edit alone.
 *
 * Mechanism (app-owned integrity, not a crypto vault):
 * - `topology.key`  — machine-local HMAC secret (32 bytes, mode 0600)
 * - `topology.seal` — JSON `{ version, alg, mac }` over a canonical topology body
 *
 * Admit rules on load (after settings decode):
 * - key+seal absent → **bootstrap** (first run / CC-stamped remote after seal
 *   invalidation) — accept topology and write seal (topologyIntegrity: ok)
 * - key present, seal missing | seal present, key missing | MAC mismatch |
 *   corrupt seal → **integrity-failed** — durable lock (role unset +
 *   topologyIntegrity: "failed"), not first-run "". Ordinary setStationTopology
 *   cannot promote to command-center/remote until a recovery ceremony.
 * - both present + MAC ok → accept
 *
 * Residual risk until a full protected store: same-user who can delete both
 * `topology.key` and `topology.seal` can re-bootstrap a forged role. Editing
 * `settings.json` alone after a seal exists does not mint topology.
 *
 * See docs/protected-topology-migration.md.
 */

import { unlink } from "node:fs/promises";
import {
  SEAL_ALG,
  debugMacForBody,
  ensureSealKey,
  sealPathsBeside,
  verifySealFile,
  writeSealFile,
  type SealPaths,
  type SealVerifyStatus,
} from "../document-seal";
import {
  defaultStation,
  type Settings,
  type StationSettings,
} from "@shared/settings";

export const TOPOLOGY_KEY_BASENAME = "topology.key";
export const TOPOLOGY_SEAL_BASENAME = "topology.seal";
export const TOPOLOGY_SEAL_VERSION = 1 as const;
export const TOPOLOGY_SEAL_ALG = SEAL_ALG;
/** Domain separation tag (must stay stable for existing seals). */
export const TOPOLOGY_SEAL_DOMAIN = "vellum-topology-v1\0";

/** Topology fields covered by the seal (prefs never appear here). */
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
  sealPathsBeside(settingsPath, TOPOLOGY_KEY_BASENAME, TOPOLOGY_SEAL_BASENAME);

export const topologyFromStation = (station: StationSettings): TopologyMaterial => ({
  role: station.role,
  hostId: station.hostId,
  ...(station.agentHostId !== undefined ? { agentHostId: station.agentHostId } : {}),
  commandCenterRef: station.commandCenterRef,
  supervisedPreferred: station.supervisedPreferred,
  topologyIntegrity: station.topologyIntegrity,
});

/**
 * Canonical JSON body for HMAC. Fixed key order; optional agentHostId only when set.
 * Stable across runtimes — do not pretty-print.
 */
export const canonicalizeTopology = (material: TopologyMaterial): Buffer => {
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
  // JSON.stringify insertion order follows key creation; re-key sorted for safety.
  const ordered: Record<string, string | boolean> = {};
  for (const key of Object.keys(body).sort()) {
    ordered[key] = body[key]!;
  }
  return Buffer.from(JSON.stringify(ordered), "utf8");
};

/**
 * Pre-integrity-field seal body (no topologyIntegrity key). Used only to admit
 * seals written before that field existed; successful admit reseals under the
 * current canonical form.
 */
export const canonicalizeTopologyLegacy = (
  material: Omit<TopologyMaterial, "topologyIntegrity">,
): Buffer => {
  const body: Record<string, string | boolean> = {
    commandCenterRef: material.commandCenterRef,
    hostId: material.hostId,
    role: material.role,
    supervisedPreferred: material.supervisedPreferred,
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

/** Ensure a machine-local key exists; return it. */
export const ensureTopologyKey = async (settingsPath: string): Promise<Buffer> => {
  const { key: keyPath } = topologyPathsForSettings(settingsPath);
  return ensureSealKey(keyPath);
};

/** Write (or overwrite) the seal for the given topology material. */
export const writeTopologySeal = async (
  settingsPath: string,
  material: TopologyMaterial,
): Promise<void> => {
  const paths = topologyPathsForSettings(settingsPath);
  await writeSealFile(
    paths,
    TOPOLOGY_SEAL_DOMAIN,
    TOPOLOGY_SEAL_VERSION,
    TOPOLOGY_SEAL_ALG,
    canonicalizeTopology(material),
  );
};

/**
 * Remove seal + key so the next app load bootstraps the stamped topology.
 * Used by Command Center configure/deploy after writing remote settings.json
 * over SSH (operator-initiated path cannot mint the remote's machine key).
 */
export const invalidateTopologySealFiles = async (settingsPath: string): Promise<void> => {
  const paths = topologyPathsForSettings(settingsPath);
  for (const target of [paths.seal, paths.key]) {
    try {
      await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
};

export const verifyTopologySeal = async (
  settingsPath: string,
  material: TopologyMaterial,
): Promise<TopologyVerifyStatus> => {
  const paths = topologyPathsForSettings(settingsPath);
  return verifySealFile(
    paths,
    TOPOLOGY_SEAL_DOMAIN,
    TOPOLOGY_SEAL_VERSION,
    TOPOLOGY_SEAL_ALG,
    canonicalizeTopology(material),
  );
};

const verifyTopologySealLegacy = async (
  settingsPath: string,
  material: TopologyMaterial,
): Promise<TopologyVerifyStatus> => {
  const paths = topologyPathsForSettings(settingsPath);
  const { topologyIntegrity: _drop, ...legacy } = material;
  return verifySealFile(
    paths,
    TOPOLOGY_SEAL_DOMAIN,
    TOPOLOGY_SEAL_VERSION,
    TOPOLOGY_SEAL_ALG,
    canonicalizeTopologyLegacy(legacy),
  );
};

/**
 * Admit topology from a loaded settings document.
 * On reject: durable integrity-failed lock (role unset + topologyIntegrity
 * "failed") — never first-run "" with integrity ok (would open CC picker).
 * Does not rewrite settings.json — caller persists when appropriate.
 * Always ensures a seal for the admitted topology (bootstrap or after lock).
 */
export const admitStationTopology = async (
  settingsPath: string,
  settings: Settings,
): Promise<{
  readonly settings: Settings;
  readonly outcome: "valid" | "bootstrap" | "integrity-failed";
  readonly reason?: string;
  /** True when a pre-integrity seal was accepted and needs reseal + disk heal. */
  readonly resealed?: boolean;
}> => {
  const material = topologyFromStation(settings.station);
  const verified = await verifyTopologySeal(settingsPath, material);

  if (verified.status === "valid") {
    return { settings, outcome: "valid" };
  }

  if (verified.status === "bootstrap") {
    // Bootstrap always admits as integrity-ok (first run / post-stamp).
    const admitted: Settings = {
      ...settings,
      station: {
        ...settings.station,
        topologyIntegrity: "ok",
      },
    };
    await writeTopologySeal(
      settingsPath,
      topologyFromStation(admitted.station),
    );
    return { settings: admitted, outcome: "bootstrap", reason: verified.reason };
  }

  // Upgrade path: seals written before topologyIntegrity was sealed may MAC
  // under the legacy body. Admit once, reseal under the current form.
  if (verified.reason === "mac-mismatch") {
    const legacy = await verifyTopologySealLegacy(settingsPath, material);
    if (legacy.status === "valid") {
      const admitted: Settings = {
        ...settings,
        station: {
          ...settings.station,
          topologyIntegrity: "ok",
        },
      };
      await writeTopologySeal(
        settingsPath,
        topologyFromStation(admitted.station),
      );
      return {
        settings: admitted,
        outcome: "valid",
        resealed: true,
        reason: "legacy-seal-migrated",
      };
    }
  }

  // MAC/asymmetric/corrupt: lock closed — not first-run.
  const locked: Settings = {
    ...settings,
    station: {
      ...defaultStation(),
      topologyIntegrity: "failed",
    },
  };
  await writeTopologySeal(settingsPath, topologyFromStation(locked.station));
  return {
    settings: locked,
    outcome: "integrity-failed",
    reason: verified.reason,
  };
};

/** Pure helper for tests: compute MAC for a known key. */
export const debugMacForTests = (key: Buffer, material: TopologyMaterial): string =>
  debugMacForBody(key, TOPOLOGY_SEAL_DOMAIN, canonicalizeTopology(material));
