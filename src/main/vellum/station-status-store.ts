/**
 * Durable station-status.json under ~/.vellum (not authorial canvas).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  defaultStationStatus,
  STATION_STATUS_VERSION,
  type StationConfigureRecord,
  type StationPullRecord,
  type StationStatusDocument,
} from "@shared/station-status";

const statusPath = (): string =>
  process.env.VELLUM_STATION_STATUS_PATH ||
  join(homedir(), ".vellum", "station-status.json");

export const readStationStatus = async (): Promise<StationStatusDocument> => {
  try {
    const raw = await readFile(statusPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as StationStatusDocument).version === STATION_STATUS_VERSION
    ) {
      return parsed as StationStatusDocument;
    }
  } catch {
    // missing or corrupt → defaults
  }
  return defaultStationStatus();
};

const writeStationStatus = async (doc: StationStatusDocument): Promise<void> => {
  const path = statusPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  await rename(tmp, path);
};

export const recordStationPull = async (pull: StationPullRecord): Promise<void> => {
  const current = await readStationStatus();
  await writeStationStatus({
    ...current,
    version: STATION_STATUS_VERSION,
    lastPull: pull,
  });
};

export const recordStationConfigure = async (
  configure: StationConfigureRecord,
): Promise<void> => {
  const current = await readStationStatus();
  await writeStationStatus({
    ...current,
    version: STATION_STATUS_VERSION,
    lastConfigure: configure,
  });
};
