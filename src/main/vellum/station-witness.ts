import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BROWSER_MAX_CANVAS_DIRECTORY_ENTRIES,
  BROWSER_MAX_CANVAS_SCAN_BYTES,
  BROWSER_MAX_CANVAS_SOURCE_BYTES,
} from "@shared/browser-limits";
import { canvasPullFileName, canvasNameFromListingEntry } from "@shared/canvas-pull";
import type { StationSettings } from "@shared/settings";
import {
  STATION_PULL_ADMISSION_VERSION,
  type StationPullAdmissionWitness,
} from "@shared/station-status";
import { ensureCanvasesDir } from "./canvases";

const MIRROR_HASH_DOMAIN = "vellum/canvas-mirror/v1";
const STATION_HASH_DOMAIN = "vellum/station-settings/v1";

const sha256 = (domain: string, body: string): string =>
  createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(body, "utf8")
    .digest("hex");

/**
 * Bind every station setting that can change the physical seat or its fleet
 * relationship. The object is spelled out so future unrelated preferences do
 * not silently become browser-authority inputs.
 */
export const stationSettingsWitness = (station: StationSettings): string =>
  sha256(
    STATION_HASH_DOMAIN,
    JSON.stringify({
      role: station.role,
      hostId: station.hostId,
      agentHostId: station.agentHostId ?? null,
      commandCenterRef: station.commandCenterRef,
      supervisedPreferred: station.supervisedPreferred,
    }),
  );

export type CanvasMirrorWitness = {
  readonly sha256: string;
  readonly canvasCount: number;
};

const sameNames = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean =>
  left.length === right.length &&
  left.every((name, index) => name === right[index]);

const canonicalCanvasEntries = async (
  root: string,
): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > BROWSER_MAX_CANVAS_DIRECTORY_ENTRIES) {
    throw new Error("canvas mirror exceeds the directory-entry admission limit");
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".canvas")) continue;
    const name = canvasNameFromListingEntry(entry.name);
    if (
      name === undefined ||
      canvasPullFileName(name) !== entry.name ||
      !entry.isFile() ||
      entry.isSymbolicLink()
    ) {
      throw new Error("canvas mirror contains a non-canonical document entry");
    }
    names.push(entry.name);
  }
  return names.sort((left, right) => left.localeCompare(right));
};

/**
 * Read the fixed local canvas repository into a race-resistant content
 * witness. There is deliberately no path parameter: browser callers cannot
 * redirect admission toward a friendlier directory.
 */
export const readLocalCanvasMirrorWitness =
  async (): Promise<CanvasMirrorWitness> => {
    const root = await ensureCanvasesDir();
    const names = await canonicalCanvasEntries(root);
    const hash = createHash("sha256");
    hash.update(MIRROR_HASH_DOMAIN, "utf8");
    hash.update("\0", "utf8");
    let totalBytes = 0;

    for (const fileName of names) {
      const path = join(root, fileName);
      const beforePath = await lstat(path, { bigint: true });
      if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
        throw new Error("canvas mirror document stopped being a regular file");
      }
      if (
        beforePath.size > BigInt(BROWSER_MAX_CANVAS_SOURCE_BYTES) ||
        beforePath.size > BigInt(BROWSER_MAX_CANVAS_SCAN_BYTES - totalBytes)
      ) {
        throw new Error("canvas mirror exceeds the browser admission byte limit");
      }

      const noFollow = constants.O_NOFOLLOW ?? 0;
      const file = await open(path, constants.O_RDONLY | noFollow);
      let contents: Buffer;
      let opened: Awaited<ReturnType<typeof file.stat>>;
      try {
        opened = await file.stat({ bigint: true });
        if (!opened.isFile()) {
          throw new Error("canvas mirror document is not a regular file");
        }
        contents = await file.readFile();
        const afterRead = await file.stat({ bigint: true });
        if (
          opened.dev !== afterRead.dev ||
          opened.ino !== afterRead.ino ||
          opened.size !== afterRead.size ||
          opened.mtimeNs !== afterRead.mtimeNs ||
          opened.ctimeNs !== afterRead.ctimeNs
        ) {
          throw new Error("canvas mirror changed while it was witnessed");
        }
      } finally {
        await file.close();
      }

      const afterPath = await lstat(path, { bigint: true });
      if (
        afterPath.isSymbolicLink() ||
        !afterPath.isFile() ||
        opened.dev !== afterPath.dev ||
        opened.ino !== afterPath.ino ||
        opened.size !== afterPath.size ||
        opened.mtimeNs !== afterPath.mtimeNs ||
        opened.ctimeNs !== afterPath.ctimeNs
      ) {
        throw new Error("canvas mirror changed while it was witnessed");
      }

      totalBytes += contents.byteLength;
      const nameBytes = Buffer.from(fileName, "utf8");
      const nameLength = Buffer.allocUnsafe(4);
      nameLength.writeUInt32BE(nameBytes.byteLength);
      const contentLength = Buffer.allocUnsafe(8);
      contentLength.writeBigUInt64BE(BigInt(contents.byteLength));
      hash.update(nameLength);
      hash.update(nameBytes);
      hash.update(contentLength);
      hash.update(contents);
    }

    const namesAfter = await canonicalCanvasEntries(root);
    if (!sameNames(names, namesAfter)) {
      throw new Error("canvas mirror membership changed while it was witnessed");
    }

    return Object.freeze({
      sha256: hash.digest("hex"),
      canvasCount: names.length,
    });
  };

export const makeStationPullAdmissionWitness = (
  station: StationSettings,
  mirror: CanvasMirrorWitness,
): StationPullAdmissionWitness =>
  Object.freeze({
    version: STATION_PULL_ADMISSION_VERSION,
    stationHostId: station.hostId,
    stationConfigSha256: stationSettingsWitness(station),
    canvasMirrorSha256: mirror.sha256,
    canvasCount: mirror.canvasCount,
  });
