/**
 * Durable station-status.json under ~/.vellum (not authorial canvas).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  decodeStationStatusDocument,
  defaultStationStatus,
  STATION_STATUS_VERSION,
  type StationConfigureRecord,
  type StationDeployRecord,
  type StationKernelRecord,
  type StationProjectionRecord,
  type StationPullRecord,
  type StationStatusDocument,
} from "@shared/station-status";

const statusPath = (): string =>
  process.env.VELLUM_STATION_STATUS_PATH ||
  join(homedir(), ".vellum", "station-status.json");

export const readStationStatus = async (): Promise<StationStatusDocument> => {
  try {
    const raw = await readFile(statusPath(), "utf8");
    const parsed = decodeStationStatusDocument(JSON.parse(raw) as unknown);
    if (parsed) return parsed;
  } catch {
    // missing or corrupt → defaults
  }
  return defaultStationStatus();
};

const writeStationStatus = async (doc: StationStatusDocument): Promise<void> => {
  const path = statusPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
};

let stationStatusWriteChain: Promise<void> = Promise.resolve();

export type StationStatusChangeKind =
  | "pull"
  | "configure"
  | "kernel"
  | "deployment"
  | "projection";

export type StationStatusChange = {
  readonly kind: StationStatusChangeKind;
  readonly previous: StationStatusDocument;
  readonly current: StationStatusDocument;
};

const stationStatusListeners = new Set<
  (change: StationStatusChange) => void
>();

export const subscribeStationStatus = (
  listener: (change: StationStatusChange) => void,
): (() => void) => {
  stationStatusListeners.add(listener);
  return () => stationStatusListeners.delete(listener);
};

const notifyStationStatus = (change: StationStatusChange): void => {
  for (const listener of stationStatusListeners) {
    try {
      listener(change);
    } catch {
      // The owner-local atomic write already committed. Continue notifying
      // independent authority consumers without leaking receipt contents.
      console.warn("[vellum:station-status] listener failed");
    }
  }
};

const updateStationStatus = (
  kind: StationStatusChangeKind,
  update: (current: StationStatusDocument) => StationStatusDocument,
): Promise<void> => {
  const run = stationStatusWriteChain.then(async () => {
    const current = await readStationStatus();
    const next = update(current);
    await writeStationStatus(next);
    notifyStationStatus({ kind, previous: current, current: next });
  });
  stationStatusWriteChain = run.catch(() => undefined);
  return run;
};

export const recordStationPull = async (pull: StationPullRecord): Promise<void> => {
  await updateStationStatus("pull", (current) => ({
    ...current,
    version: STATION_STATUS_VERSION,
    lastPull: pull,
  }));
};

export const recordStationConfigure = async (
  configure: StationConfigureRecord,
): Promise<void> => {
  await updateStationStatus("configure", (current) => ({
    ...current,
    version: STATION_STATUS_VERSION,
    lastConfigure: configure,
    configures: {
      ...(current.configures ?? {}),
      [configure.hostId]: configure,
    },
  }));
};

export const recordStationKernel = async (
  kernel: StationKernelRecord,
): Promise<void> => {
  await updateStationStatus("kernel", (current) => ({
    ...current,
    version: STATION_STATUS_VERSION,
    kernel,
  }));
};

export const recordStationDeployment = async (
  deployment: StationDeployRecord,
  configure: StationConfigureRecord,
): Promise<void> => {
  await updateStationStatus("deployment", (current) => {
    const previous = current.deployments?.[deployment.hostId];
    const sameTarget = previous?.endpoint === deployment.endpoint;
    const packageUnchanged =
      sameTarget && deployment.packageState === "previous";
    const roleUnchanged = sameTarget && deployment.role === "previous";
    const merged: StationDeployRecord = {
      ...deployment,
      packageState: packageUnchanged
        ? previous.packageState
        : deployment.packageState,
      role: roleUnchanged ? previous.role : deployment.role,
      version: packageUnchanged ? previous.version : deployment.version,
      ...(packageUnchanged && previous.lastSeen
        ? { lastSeen: previous.lastSeen }
        : {}),
    };
    return {
      ...current,
      version: STATION_STATUS_VERSION,
      lastConfigure: configure,
      configures: {
        ...(current.configures ?? {}),
        [configure.hostId]: configure,
      },
      deployments: {
        ...(current.deployments ?? {}),
        [deployment.hostId]: merged,
      },
    };
  });
};

/**
 * Persist a projection delivery receipt (Command Center push lane).
 * Updates both the overall lastProjection pointer and the per-host map.
 */
export const recordStationProjection = async (
  projection: StationProjectionRecord,
): Promise<void> => {
  await updateStationStatus("projection", (current) => ({
    ...current,
    version: STATION_STATUS_VERSION,
    lastProjection: projection,
    projections: {
      ...(current.projections ?? {}),
      [projection.hostId]: projection,
    },
  }));
};
