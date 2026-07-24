/**
 * Content-addressed canvas authority store under
 * `~/.vellum/state/canvas-authority-v1/`.
 *
 * Commit algorithm (single global queue caller responsibility):
 * 1. write missing document objects exclusively
 * 2. fsync documents dir
 * 3. write manifest under its hash exclusively
 * 4. fsync manifests dir
 * 5. write current.json via tmp + rename
 * 6. fsync store root
 *
 * Corrupt current pointer fails closed — never scan manifests to guess.
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
  CanvasAuthorityManifestV1,
  CanvasAuthorityPointerV1,
  type CanvasAuthorityManifestV1 as Manifest,
  type CanvasAuthorityPointerV1 as Pointer,
  type Sha256Hex,
} from "@shared/canvas-authority";

export class CanvasAuthorityError extends Error {
  readonly code: "io" | "corrupt" | "absent" | "conflict";
  constructor(
    code: CanvasAuthorityError["code"],
    message: string,
  ) {
    super(message);
    this.name = "CanvasAuthorityError";
    this.code = code;
  }
}

export const canvasAuthorityRoot = (): string =>
  resolve(
    process.env.VELLUM_CANVAS_AUTHORITY_DIR ||
      join(homedir(), ".vellum", "state", "canvas-authority-v1"),
  );

const sha256Hex = (bytes: Uint8Array | string): Sha256Hex =>
  createHash("sha256").update(bytes).digest("hex") as Sha256Hex;

const assertRealDir = async (path: string): Promise<void> => {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new CanvasAuthorityError(
        "corrupt",
        `authority path is not a real directory: ${path}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CanvasAuthorityError("absent", `missing directory: ${path}`);
    }
    throw error;
  }
};

const ensureLayout = async (root: string): Promise<void> => {
  await mkdir(join(root, "manifests"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "documents"), { recursive: true, mode: 0o700 });
  await mkdir(root, { recursive: true, mode: 0o700 });
  // chmod best-effort — umask may have interfered
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
    /* best-effort on platforms that refuse */
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

export type AuthoritySnapshot = {
  readonly pointer: Pointer;
  readonly manifest: Manifest;
  readonly documents: ReadonlyMap<string, Uint8Array>;
};

export const loadAuthoritySnapshot = async (
  root: string = canvasAuthorityRoot(),
): Promise<AuthoritySnapshot | undefined> => {
  const pointerPath = join(root, "current.json");
  let raw: string;
  try {
    const file = await open(pointerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile()) {
        throw new CanvasAuthorityError("corrupt", "current.json is not a regular file");
      }
      raw = await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof CanvasAuthorityError) throw error;
    throw new CanvasAuthorityError(
      "corrupt",
      `failed to read current.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new CanvasAuthorityError("corrupt", "current.json is not valid JSON");
  }

  const pointerResult = Schema.decodeUnknownEither(CanvasAuthorityPointerV1)(parsed);
  if (Either.isLeft(pointerResult)) {
    throw new CanvasAuthorityError("corrupt", "current.json failed schema");
  }
  const pointer = pointerResult.right;

  const manifestPath = join(root, "manifests", `${pointer.manifestSha256}.json`);
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(manifestPath, "utf8");
  } catch {
    throw new CanvasAuthorityError(
      "corrupt",
      `manifest missing for pointer ${pointer.manifestSha256}`,
    );
  }
  const manifestHash = sha256Hex(manifestRaw);
  if (manifestHash !== pointer.manifestSha256) {
    throw new CanvasAuthorityError("corrupt", "manifest hash mismatch");
  }
  let manifestParsed: unknown;
  try {
    manifestParsed = JSON.parse(manifestRaw) as unknown;
  } catch {
    throw new CanvasAuthorityError("corrupt", "manifest is not valid JSON");
  }
  const manifestResult =
    Schema.decodeUnknownEither(CanvasAuthorityManifestV1)(manifestParsed);
  if (Either.isLeft(manifestResult)) {
    throw new CanvasAuthorityError("corrupt", "manifest failed schema");
  }
  const manifest = manifestResult.right;
  if (manifest.generation !== pointer.generation) {
    throw new CanvasAuthorityError(
      "corrupt",
      "pointer generation does not match manifest",
    );
  }
  if (manifest.intentSha256 !== pointer.intentSha256) {
    throw new CanvasAuthorityError(
      "corrupt",
      "pointer intent hash does not match manifest",
    );
  }

  const documents = new Map<string, Uint8Array>();
  for (const entry of manifest.documents) {
    const docPath = join(root, "documents", `${entry.sha256}.canvas`);
    let bytes: Buffer;
    try {
      bytes = await readFile(docPath);
    } catch {
      throw new CanvasAuthorityError(
        "corrupt",
        `document object missing: ${entry.sha256}`,
      );
    }
    if (bytes.byteLength !== entry.bytes) {
      throw new CanvasAuthorityError(
        "corrupt",
        `document byte length mismatch: ${entry.name}`,
      );
    }
    const hash = sha256Hex(bytes);
    if (hash !== entry.sha256) {
      throw new CanvasAuthorityError(
        "corrupt",
        `document hash mismatch: ${entry.name}`,
      );
    }
    documents.set(entry.name, new Uint8Array(bytes));
  }

  return { pointer, manifest, documents };
};

export type CommitInput = {
  readonly generation: string;
  readonly createdAt: string;
  /** name → exact canonical document bytes */
  readonly documents: ReadonlyMap<string, Uint8Array>;
};

export const commitAuthorityGeneration = async (
  input: CommitInput,
  root: string = canvasAuthorityRoot(),
): Promise<AuthoritySnapshot> => {
  await ensureLayout(root);
  await assertRealDir(root);

  const entries = [...input.documents.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const documentRecords: Array<{
    readonly name: string;
    readonly bytes: number;
    readonly sha256: Sha256Hex;
  }> = [];
  for (const [name, body] of entries) {
    const hash = sha256Hex(body);
    const objectPath = join(root, "documents", `${hash}.canvas`);
    try {
      await access(objectPath);
    } catch {
      const tmp = `${objectPath}.${randomUUID()}.tmp`;
      await writeFile(tmp, body, { flag: "wx", mode: 0o600 });
      await fsyncPath(tmp);
      await rename(tmp, objectPath);
    }
    documentRecords.push({
      name,
      bytes: body.byteLength,
      sha256: hash,
    });
  }
  await fsyncDir(join(root, "documents"));

  // Length-prefixed intent hash over sorted name + body hashes
  const intent = createHash("sha256");
  for (const rec of documentRecords) {
    intent.update(String(rec.name.length));
    intent.update("\0");
    intent.update(rec.name);
    intent.update(rec.sha256);
  }
  const intentSha256 = intent.digest("hex") as Sha256Hex;

  const manifest: Manifest = {
    schema: "vellum/canvas-authority/v1",
    generation: input.generation,
    createdAt: input.createdAt,
    intentSha256,
    documents: documentRecords,
  };
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = sha256Hex(manifestBody);
  const manifestPath = join(root, "manifests", `${manifestSha256}.json`);
  try {
    await access(manifestPath);
  } catch {
    const tmp = `${manifestPath}.${randomUUID()}.tmp`;
    await writeFile(tmp, manifestBody, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fsyncPath(tmp);
    await rename(tmp, manifestPath);
  }
  await fsyncDir(join(root, "manifests"));

  const pointer: Pointer = {
    schema: "vellum/canvas-authority-pointer/v1",
    generation: input.generation,
    manifestSha256,
    intentSha256,
  };
  const pointerBody = `${JSON.stringify(pointer, null, 2)}\n`;
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

  const documents = new Map(entries);
  return { pointer, manifest, documents };
};

export const authorityStorePresent = async (
  root: string = canvasAuthorityRoot(),
): Promise<boolean> => {
  try {
    await access(join(root, "current.json"));
    return true;
  } catch {
    return false;
  }
};

