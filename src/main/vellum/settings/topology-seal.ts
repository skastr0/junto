/**
 * Topology seal — Phase 3 first cut of protected station topology.
 *
 * Mental model:
 * - **prefs** (appearance, canvas, kernel, browser, audio, advanced) may live
 *   in ambient `settings.json` and are mutable via generic settingsPatch.
 * - **topology** (station.role, hostId, agentHostId, commandCenterRef,
 *   supervisedPreferred) must not be mutably trusted from an offline plaintext
 *   edit alone.
 *
 * Mechanism (app-owned integrity, not a crypto vault):
 * - `topology.key`  — machine-local HMAC secret (32 bytes, mode 0600)
 * - `topology.seal` — JSON `{ version, alg, mac }` over a canonical topology body
 *
 * Admit rules on load (after settings decode):
 * - key+seal absent → **bootstrap** (first run / CC-stamped remote after seal
 *   invalidation) — accept topology and write seal
 * - key present, seal missing | seal present, key missing | MAC mismatch |
 *   corrupt seal → **fail closed** — strip station to defaults (role unset)
 * - both present + MAC ok → accept
 *
 * Residual risk until a full protected store: same-user who can delete both
 * `topology.key` and `topology.seal` can re-bootstrap a forged role. Editing
 * `settings.json` alone after a seal exists does not mint topology.
 *
 * See docs/protected-topology-migration.md.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  defaultStation,
  type Settings,
  type StationSettings,
} from "@shared/settings";

export const TOPOLOGY_KEY_BASENAME = "topology.key";
export const TOPOLOGY_SEAL_BASENAME = "topology.seal";
export const TOPOLOGY_SEAL_VERSION = 1 as const;
export const TOPOLOGY_SEAL_ALG = "hmac-sha256" as const;
const KEY_BYTES = 32;

/** Topology fields covered by the seal (prefs never appear here). */
export type TopologyMaterial = {
  readonly role: string;
  readonly hostId: string;
  readonly agentHostId?: string;
  readonly commandCenterRef: string;
  readonly supervisedPreferred: boolean;
};

export type TopologyPaths = {
  readonly key: string;
  readonly seal: string;
  readonly dir: string;
};

export type TopologyVerifyStatus =
  | { readonly status: "valid" }
  | { readonly status: "bootstrap"; readonly reason: "no-key-no-seal" }
  | {
      readonly status: "reject";
      readonly reason:
        | "mac-mismatch"
        | "seal-missing"
        | "key-missing"
        | "corrupt-seal";
    };

export const topologyPathsForSettings = (settingsPath: string): TopologyPaths => {
  const dir = dirname(settingsPath);
  return {
    dir,
    key: join(dir, TOPOLOGY_KEY_BASENAME),
    seal: join(dir, TOPOLOGY_SEAL_BASENAME),
  };
};

export const topologyFromStation = (station: StationSettings): TopologyMaterial => ({
  role: station.role,
  hostId: station.hostId,
  ...(station.agentHostId !== undefined ? { agentHostId: station.agentHostId } : {}),
  commandCenterRef: station.commandCenterRef,
  supervisedPreferred: station.supervisedPreferred,
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

const macFor = (key: Buffer, material: TopologyMaterial): Buffer => {
  const hmac = createHmac("sha256", key);
  hmac.update("vellum-topology-v1\0");
  hmac.update(canonicalizeTopology(material));
  return hmac.digest();
};

const safeEqualMac = (left: Buffer, right: Buffer): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      return info.isFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Symlink / not-a-file / ELOOP → treat as present-but-unusable (reject path).
    return true;
  }
};

const readKey = async (keyPath: string): Promise<Buffer | null> => {
  try {
    const handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < KEY_BYTES || info.size > 64) return null;
      const raw = await handle.readFile();
      if (raw.byteLength < KEY_BYTES) return null;
      return Buffer.from(raw.subarray(0, KEY_BYTES));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

type SealDocument = {
  readonly version: number;
  readonly alg: string;
  readonly mac: string;
};

const readSeal = async (sealPath: string): Promise<SealDocument | null> => {
  try {
    const handle = await open(sealPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4_096) return null;
      const raw = await handle.readFile("utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.version !== "number" ||
        typeof record.alg !== "string" ||
        typeof record.mac !== "string"
      ) {
        return null;
      }
      return {
        version: record.version,
        alg: record.alg,
        mac: record.mac,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

const atomicWriteBytes = async (
  path: string,
  body: Buffer | string,
  mode: number,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  if (typeof body === "string") {
    await writeFile(tmp, body, { encoding: "utf8", flag: "wx", mode });
  } else {
    await writeFile(tmp, body, { flag: "wx", mode });
  }
  await rename(tmp, path);
};

/** Ensure a machine-local key exists; return it. */
export const ensureTopologyKey = async (settingsPath: string): Promise<Buffer> => {
  const { key: keyPath } = topologyPathsForSettings(settingsPath);
  const existing = await readKey(keyPath);
  if (existing) return existing;
  const next = randomBytes(KEY_BYTES);
  await atomicWriteBytes(keyPath, next, 0o600);
  return next;
};

/** Write (or overwrite) the seal for the given topology material. */
export const writeTopologySeal = async (
  settingsPath: string,
  material: TopologyMaterial,
): Promise<void> => {
  const key = await ensureTopologyKey(settingsPath);
  const mac = macFor(key, material).toString("base64url");
  const doc = {
    version: TOPOLOGY_SEAL_VERSION,
    alg: TOPOLOGY_SEAL_ALG,
    mac,
  };
  const { seal } = topologyPathsForSettings(settingsPath);
  await atomicWriteBytes(seal, `${JSON.stringify(doc)}\n`, 0o600);
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
  const keyPresent = await fileExists(paths.key);
  const sealPresent = await fileExists(paths.seal);

  if (!keyPresent && !sealPresent) {
    return { status: "bootstrap", reason: "no-key-no-seal" };
  }
  if (keyPresent && !sealPresent) {
    return { status: "reject", reason: "seal-missing" };
  }
  if (!keyPresent && sealPresent) {
    return { status: "reject", reason: "key-missing" };
  }

  const key = await readKey(paths.key);
  const seal = await readSeal(paths.seal);
  if (!key || !seal) {
    return { status: "reject", reason: "corrupt-seal" };
  }
  if (seal.version !== TOPOLOGY_SEAL_VERSION || seal.alg !== TOPOLOGY_SEAL_ALG) {
    return { status: "reject", reason: "corrupt-seal" };
  }

  let claimed: Buffer;
  try {
    claimed = Buffer.from(seal.mac, "base64url");
  } catch {
    return { status: "reject", reason: "corrupt-seal" };
  }
  if (claimed.byteLength === 0) {
    return { status: "reject", reason: "corrupt-seal" };
  }

  const expected = macFor(key, material);
  if (!safeEqualMac(expected, claimed)) {
    return { status: "reject", reason: "mac-mismatch" };
  }
  return { status: "valid" };
};

/**
 * Admit topology from a loaded settings document.
 * On reject: returns settings with station reset to defaults (role unset → StationRoleGate).
 * Does not rewrite settings.json — caller persists when appropriate.
 * Always ensures a seal for the admitted topology (bootstrap or after strip).
 */
export const admitStationTopology = async (
  settingsPath: string,
  settings: Settings,
): Promise<{
  readonly settings: Settings;
  readonly outcome: "valid" | "bootstrap" | "stripped";
  readonly reason?: string;
}> => {
  const material = topologyFromStation(settings.station);
  const verified = await verifyTopologySeal(settingsPath, material);

  if (verified.status === "valid") {
    return { settings, outcome: "valid" };
  }

  if (verified.status === "bootstrap") {
    await writeTopologySeal(settingsPath, material);
    return { settings, outcome: "bootstrap", reason: verified.reason };
  }

  const stripped: Settings = {
    ...settings,
    station: defaultStation(),
  };
  await writeTopologySeal(settingsPath, topologyFromStation(stripped.station));
  return {
    settings: stripped,
    outcome: "stripped",
    reason: verified.reason,
  };
};

/** Pure helper for tests: compute MAC for a known key. */
export const debugMacForTests = (key: Buffer, material: TopologyMaterial): string =>
  macFor(key, material).toString("base64url");
