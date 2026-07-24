/**
 * Station projection apply store under `~/.vellum/projections/station/`.
 *
 * Installs complete generations only:
 * - refuse generation < current (stale)
 * - same generation + same frame hash → idempotent success
 * - same generation + different frame hash → conflict (fail closed)
 * - higher generation → install and advance current.json
 *
 * Corrupt current pointer fails closed — never scan generations to guess.
 */

import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Either, Schema } from "effect";
import {
  STATION_PROJECTION_FRAME_MAGIC,
  compareProjectionGeneration,
  StationProjectionManifestV1,
  StationProjectionPointerV1,
  type Sha256Hex,
  type StationProjectionManifestV1 as Manifest,
  type StationProjectionPointerV1 as Pointer,
} from "@shared/station-projection";
import {
  parseStationProjectionFrame,
  type CompiledStationProjection,
} from "./compiler";

export class StationProjectionStoreError extends Error {
  readonly code: "io" | "corrupt" | "absent" | "stale" | "conflict";
  constructor(
    code: StationProjectionStoreError["code"],
    message: string,
  ) {
    super(message);
    this.name = "StationProjectionStoreError";
    this.code = code;
  }
}

export const stationProjectionRoot = (): string =>
  resolve(
    process.env.VELLUM_STATION_PROJECTION_DIR ||
      join(homedir(), ".vellum", "projections", "station"),
  );

const sha256Hex = (bytes: Uint8Array | string): Sha256Hex =>
  createHash("sha256").update(bytes).digest("hex") as Sha256Hex;

const assertRealDir = async (path: string): Promise<void> => {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new StationProjectionStoreError(
        "corrupt",
        `projection path is not a real directory: ${path}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StationProjectionStoreError("absent", `missing directory: ${path}`);
    }
    throw error;
  }
};

const ensureLayout = async (root: string): Promise<void> => {
  await mkdir(join(root, "manifests"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "frames"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "documents"), { recursive: true, mode: 0o700 });
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    await handle.chmod(0o700);
    await handle.close();
  } catch {
    /* ignore */
  }
};

const fsyncPath = async (path: string): Promise<void> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch {
    /* best-effort */
  } finally {
    await handle?.close();
  }
};

const fsyncDir = async (path: string): Promise<void> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    await handle.sync();
  } catch {
    /* best-effort */
  } finally {
    await handle?.close();
  }
};

const writeExclusive = async (
  path: string,
  body: Uint8Array | string,
  encoding?: BufferEncoding,
): Promise<void> => {
  try {
    await access(path);
    return; // already present — content-addressed objects are immutable
  } catch {
    /* create */
  }
  const tmp = `${path}.${randomUUID()}.tmp`;
  if (typeof body === "string") {
    await writeFile(tmp, body, { encoding: encoding ?? "utf8", flag: "wx", mode: 0o600 });
  } else {
    await writeFile(tmp, body, { flag: "wx", mode: 0o600 });
  }
  await fsyncPath(tmp);
  await rename(tmp, path);
};

export type StationProjectionSnapshot = {
  readonly pointer: Pointer;
  readonly manifest: Manifest;
  readonly documents: ReadonlyMap<string, Uint8Array>;
  readonly frame: Uint8Array;
};

const readPointer = async (root: string): Promise<Pointer | undefined> => {
  const pointerPath = join(root, "current.json");
  let raw: string;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const file = await open(pointerPath, constants.O_RDONLY | noFollow);
    try {
      const info = await file.stat();
      if (!info.isFile()) {
        throw new StationProjectionStoreError(
          "corrupt",
          "current.json is not a regular file",
        );
      }
      raw = await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof StationProjectionStoreError) throw error;
    throw new StationProjectionStoreError(
      "corrupt",
      `failed to read current.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new StationProjectionStoreError(
      "corrupt",
      "current.json is not valid JSON",
    );
  }

  const pointerResult =
    Schema.decodeUnknownEither(StationProjectionPointerV1)(parsed);
  if (Either.isLeft(pointerResult)) {
    throw new StationProjectionStoreError(
      "corrupt",
      "current.json failed schema",
    );
  }
  return pointerResult.right;
};

export const loadStationProjectionSnapshot = async (
  root: string = stationProjectionRoot(),
): Promise<StationProjectionSnapshot | undefined> => {
  const pointer = await readPointer(root);
  if (pointer === undefined) return undefined;

  const framePath = join(root, "frames", `${pointer.frameSha256}.bin`);
  let frame: Buffer;
  try {
    frame = await readFile(framePath);
  } catch {
    throw new StationProjectionStoreError(
      "corrupt",
      `frame missing for pointer ${pointer.frameSha256}`,
    );
  }
  if (sha256Hex(frame) !== pointer.frameSha256) {
    throw new StationProjectionStoreError("corrupt", "frame hash mismatch");
  }

  let parsed;
  try {
    parsed = parseStationProjectionFrame(new Uint8Array(frame));
  } catch (error) {
    throw new StationProjectionStoreError(
      "corrupt",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (parsed.manifest.generation !== pointer.generation) {
    throw new StationProjectionStoreError(
      "corrupt",
      "pointer generation does not match frame manifest",
    );
  }
  if (parsed.manifestSha256 !== pointer.manifestSha256) {
    throw new StationProjectionStoreError(
      "corrupt",
      "pointer manifest hash does not match frame",
    );
  }
  if (parsed.manifest.intentSha256 !== pointer.intentSha256) {
    throw new StationProjectionStoreError(
      "corrupt",
      "pointer intent hash does not match frame",
    );
  }
  if (parsed.frameSha256 !== pointer.frameSha256) {
    throw new StationProjectionStoreError(
      "corrupt",
      "pointer frame hash does not match frame body",
    );
  }

  // Cross-check content-addressed document objects when present.
  for (const entry of parsed.manifest.documents) {
    const docPath = join(root, "documents", `${entry.sha256}.canvas`);
    try {
      const bytes = await readFile(docPath);
      if (sha256Hex(bytes) !== entry.sha256) {
        throw new StationProjectionStoreError(
          "corrupt",
          `document object hash mismatch: ${entry.name}`,
        );
      }
    } catch (error) {
      if (error instanceof StationProjectionStoreError) throw error;
      throw new StationProjectionStoreError(
        "corrupt",
        `document object missing: ${entry.sha256}`,
      );
    }
  }

  return {
    pointer,
    manifest: parsed.manifest,
    documents: parsed.documents,
    frame: new Uint8Array(frame),
  };
};

export type ApplyStationProjectionResult =
  | {
      readonly status: "installed";
      readonly generation: string;
      readonly frameSha256: Sha256Hex;
      readonly snapshot: StationProjectionSnapshot;
    }
  | {
      readonly status: "idempotent";
      readonly generation: string;
      readonly frameSha256: Sha256Hex;
      readonly snapshot: StationProjectionSnapshot;
    };

export type ApplyStationProjectionInput =
  | { readonly kind: "compiled"; readonly compiled: CompiledStationProjection }
  | { readonly kind: "frame"; readonly frame: Uint8Array };

/**
 * Apply a complete projection generation under `root`.
 *
 * Generation gate is monotonic: only higher generations advance the pointer.
 * Same generation + same frame hash is a no-op success (idempotent re-delivery).
 */
export const applyStationProjectionGeneration = async (
  input: ApplyStationProjectionInput,
  root: string = stationProjectionRoot(),
): Promise<ApplyStationProjectionResult> => {
  await ensureLayout(root);
  await assertRealDir(root);

  const frame =
    input.kind === "compiled"
      ? input.compiled.frame
      : input.frame;

  let parsed;
  try {
    parsed = parseStationProjectionFrame(frame);
  } catch (error) {
    throw new StationProjectionStoreError(
      "corrupt",
      error instanceof Error ? error.message : String(error),
    );
  }

  // If caller provided a precompiled package, require it matches the frame.
  if (input.kind === "compiled") {
    if (input.compiled.frameSha256 !== parsed.frameSha256) {
      throw new StationProjectionStoreError(
        "corrupt",
        "compiled frameSha256 does not match frame body",
      );
    }
    if (input.compiled.manifest.generation !== parsed.manifest.generation) {
      throw new StationProjectionStoreError(
        "corrupt",
        "compiled manifest generation does not match frame",
      );
    }
  }

  const current = await readPointer(root);
  if (current !== undefined) {
    const cmp = compareProjectionGeneration(
      parsed.manifest.generation,
      current.generation,
    );
    if (cmp < 0) {
      throw new StationProjectionStoreError(
        "stale",
        `refused generation ${parsed.manifest.generation} — current is ${current.generation}`,
      );
    }
    if (cmp === 0) {
      if (parsed.frameSha256 === current.frameSha256) {
        const snapshot = await loadStationProjectionSnapshot(root);
        if (snapshot === undefined) {
          throw new StationProjectionStoreError(
            "corrupt",
            "current pointer present but snapshot missing",
          );
        }
        return {
          status: "idempotent",
          generation: current.generation,
          frameSha256: current.frameSha256,
          snapshot,
        };
      }
      throw new StationProjectionStoreError(
        "conflict",
        `generation ${parsed.manifest.generation} already installed with a different frame`,
      );
    }
  }

  // Install content-addressed objects, then advance the pointer.
  for (const [name, body] of parsed.documents) {
    const entry = parsed.manifest.documents.find((row) => row.name === name);
    if (entry === undefined) {
      throw new StationProjectionStoreError(
        "corrupt",
        `document missing from manifest: ${name}`,
      );
    }
    await writeExclusive(
      join(root, "documents", `${entry.sha256}.canvas`),
      body,
    );
  }
  await fsyncDir(join(root, "documents"));

  // Persist exact manifest bytes extracted from the frame for hash stability.
  const magic = new TextEncoder().encode(STATION_PROJECTION_FRAME_MAGIC);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const manifestLen = view.getUint32(magic.byteLength, false);
  const manifestStart = magic.byteLength + 4;
  const exactManifestBytes = frame.subarray(
    manifestStart,
    manifestStart + manifestLen,
  );
  if (sha256Hex(exactManifestBytes) !== parsed.manifestSha256) {
    throw new StationProjectionStoreError(
      "corrupt",
      "exact manifest slice hash mismatch",
    );
  }
  await writeExclusive(
    join(root, "manifests", `${parsed.manifestSha256}.json`),
    exactManifestBytes,
  );
  await fsyncDir(join(root, "manifests"));

  await writeExclusive(
    join(root, "frames", `${parsed.frameSha256}.bin`),
    frame,
  );
  await fsyncDir(join(root, "frames"));

  const pointer: Pointer = {
    schema: "vellum/station-projection-pointer/v1",
    generation: parsed.manifest.generation,
    frameSha256: parsed.frameSha256,
    manifestSha256: parsed.manifestSha256,
    intentSha256: parsed.manifest.intentSha256,
  };
  // Satisfy schema before write.
  const pointerCheck =
    Schema.decodeUnknownEither(StationProjectionPointerV1)(pointer);
  if (Either.isLeft(pointerCheck)) {
    throw new StationProjectionStoreError(
      "corrupt",
      "constructed pointer failed schema",
    );
  }
  // Manifest re-check (already parsed; keep the type live for snapshot).
  const manifestCheck =
    Schema.decodeUnknownEither(StationProjectionManifestV1)(parsed.manifest);
  if (Either.isLeft(manifestCheck)) {
    throw new StationProjectionStoreError(
      "corrupt",
      "parsed manifest failed re-decode",
    );
  }

  const pointerBody = `${JSON.stringify(pointerCheck.right, null, 2)}\n`;
  const pointerPath = join(root, "current.json");
  const pointerTmp = join(root, `current.json.${randomUUID()}.tmp`);
  await writeFile(pointerTmp, pointerBody, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await fsyncPath(pointerTmp);
  await rename(pointerTmp, pointerPath);
  await fsyncDir(root);

  const snapshot: StationProjectionSnapshot = {
    pointer: pointerCheck.right,
    manifest: manifestCheck.right,
    documents: parsed.documents,
    frame: new Uint8Array(frame),
  };

  return {
    status: "installed",
    generation: snapshot.pointer.generation,
    frameSha256: snapshot.pointer.frameSha256,
    snapshot,
  };
};
