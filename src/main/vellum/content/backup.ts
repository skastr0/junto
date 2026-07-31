/**
 * Coherent content snapshot for product backup.
 *
 * SQLite (via StateEngine VACUUM INTO) and immutable content objects are one
 * recoverable product state. This module snapshots every digest referenced by
 * content_refs (hardlink when possible, copy otherwise) into an owner-only
 * tree and proves the snapshot has no dangling referenced objects.
 *
 * This is portability/forensic evidence, not an automatic restore path.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import type { StateReader } from "../state/service";
import type { StateBackupReceipt } from "../state/service";
import {
  listReferencedContentDigests,
} from "./manifest";
import {
  contentDigestRoot,
  contentObjectPath,
  contentObjectShard,
  contentStoreRoot,
} from "./paths";
import {
  ContentStoreError,
  ensureContentLayout,
  hashContentObjectFile,
} from "./store";
import { runContentIntegrityCheck } from "./integrity";

const DIR_MODE = 0o700;
const FILE_MODE = 0o444;
const MANIFEST_MODE = 0o600;
const SNAPSHOT_DIR_NAME = "snapshots";
const SNAPSHOT_PREFIX = "content-snapshot-";

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code: unknown }).code === "ENOENT";

const lstatOrUndefined = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
};

const fsyncDirectory = (path: string): void => {
  const flags =
    constants.O_RDONLY |
    (constants.O_DIRECTORY ?? 0) |
    (constants.O_NOFOLLOW ?? 0);
  let fd: number | undefined;
  try {
    fd = openSync(path, flags);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
};

const assertRealDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ContentStoreError(
      "symlink",
      `content snapshot path is not a real directory: ${path}`,
    );
  }
  try {
    chmodSync(path, DIR_MODE);
  } catch {
    // platform may ignore
  }
};

/** Parent of layout version root: `~/.vellum/content/`. */
export const contentStoreParent = (root: string): string => dirname(root);

export const contentSnapshotsDir = (root: string): string =>
  join(contentStoreParent(root), SNAPSHOT_DIR_NAME);

export type ContentSnapshotObject = {
  readonly sha256: string;
  readonly byteLength: number;
};

export type ContentSnapshotManifest = {
  readonly version: 1;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly contentRoot: string;
  readonly objectCount: number;
  readonly totalBytes: number;
  readonly objects: ReadonlyArray<ContentSnapshotObject>;
  readonly stateBackup?: {
    readonly path: string;
    readonly schemaSha256: string;
    readonly schemaVersion: number;
  };
};

export type ContentSnapshotReceipt = {
  readonly snapshotId: string;
  readonly path: string;
  readonly manifestPath: string;
  readonly createdAt: string;
  readonly objectCount: number;
  readonly totalBytes: number;
  readonly objects: ReadonlyArray<ContentSnapshotObject>;
  readonly stateBackup?: StateBackupReceipt;
};

const hardlinkOrCopy = (source: string, dest: string): void => {
  try {
    linkSync(source, dest);
  } catch {
    copyFileSync(source, dest);
  }
  try {
    chmodSync(dest, FILE_MODE);
  } catch {
    // best-effort
  }
};

const writeManifestAtomic = (
  path: string,
  manifest: ContentSnapshotManifest,
): void => {
  const pending = `${path}.pending`;
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(pending, body, { encoding: "utf8", mode: MANIFEST_MODE });
  try {
    chmodSync(pending, MANIFEST_MODE);
  } catch {
    // best-effort
  }
  const fd = openSync(pending, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(pending, path);
  fsyncDirectory(dirname(path));
};

/**
 * Snapshot every content_refs digest into an immutable tree under
 * `~/.vellum/content/snapshots/content-snapshot-<uuid>/`.
 *
 * Fails closed if any referenced object is missing or fails hash verify —
 * a coherent product backup must not have dangling refs.
 */
export const createContentSnapshot = (
  root: string,
  reader: StateReader,
  options?: {
    readonly stateBackup?: StateBackupReceipt;
    readonly now?: Date;
    readonly snapshotId?: string;
  },
): ContentSnapshotReceipt => {
  ensureContentLayout(root);
  const integrity = runContentIntegrityCheck(root, reader, {
    now: options?.now,
  });
  if (!integrity.referencedCoherent) {
    const bad = integrity.findings.filter(
      (f) =>
        f.kind === "referenced-missing" || f.kind === "referenced-corrupt",
    );
    throw new ContentStoreError(
      "corrupt",
      `content snapshot refused: ${bad.length} referenced object(s) missing or corrupt`,
    );
  }

  const referenced = listReferencedContentDigests(reader);
  const createdAt = (options?.now ?? new Date()).toISOString();
  const snapshotId = options?.snapshotId ?? randomUUID();
  const snapshotsRoot = contentSnapshotsDir(root);
  assertRealDirectory(contentStoreParent(root));
  assertRealDirectory(snapshotsRoot);

  const snapshotPath = join(
    snapshotsRoot,
    `${SNAPSHOT_PREFIX}${snapshotId}`,
  );
  if (lstatOrUndefined(snapshotPath) !== undefined) {
    throw new ContentStoreError(
      "io",
      `content snapshot destination already exists: ${snapshotPath}`,
    );
  }
  const pendingPath = `${snapshotPath}.pending`;
  if (lstatOrUndefined(pendingPath) !== undefined) {
    // Cleanup incomplete prior attempt under the same id is operator/manual;
    // for random UUIDs this only hits injected test collisions.
    throw new ContentStoreError(
      "io",
      `content snapshot pending destination already exists: ${pendingPath}`,
    );
  }

  assertRealDirectory(pendingPath);
  const objectsRoot = join(pendingPath, "sha256");
  assertRealDirectory(objectsRoot);

  const objects: ContentSnapshotObject[] = [];
  let totalBytes = 0;
  try {
    for (const item of referenced) {
      const source = contentObjectPath(root, item.sha256);
      const observed = hashContentObjectFile(source);
      if (
        observed.sha256 !== item.sha256 ||
        observed.byteLength !== item.byteLength
      ) {
        throw new ContentStoreError(
          "corrupt",
          `content snapshot hash mismatch for ${item.sha256}`,
        );
      }
      const shard = contentObjectShard(item.sha256);
      const destDir = join(objectsRoot, shard);
      assertRealDirectory(destDir);
      const dest = join(destDir, item.sha256);
      hardlinkOrCopy(source, dest);
      objects.push({
        sha256: item.sha256,
        byteLength: item.byteLength,
      });
      totalBytes += item.byteLength;
    }

    const manifest: ContentSnapshotManifest = {
      version: 1,
      snapshotId,
      createdAt,
      contentRoot: root,
      objectCount: objects.length,
      totalBytes,
      objects,
      stateBackup:
        options?.stateBackup === undefined
          ? undefined
          : {
              path: options.stateBackup.path,
              schemaSha256: options.stateBackup.schemaSha256,
              schemaVersion: options.stateBackup.schemaVersion,
            },
    };
    writeManifestAtomic(join(pendingPath, "manifest.json"), manifest);
    fsyncDirectory(objectsRoot);
    fsyncDirectory(pendingPath);

    renameSync(pendingPath, snapshotPath);
    fsyncDirectory(snapshotsRoot);

    // Prove restore-ready coherence: every manifest digest exists under snapshot.
    verifyContentSnapshotCoherence(snapshotPath);

    return {
      snapshotId,
      path: snapshotPath,
      manifestPath: join(snapshotPath, "manifest.json"),
      createdAt,
      objectCount: objects.length,
      totalBytes,
      objects,
      stateBackup: options?.stateBackup,
    };
  } catch (error) {
    // Best-effort cleanup of pending tree on failure.
    try {
      removeDirectoryRecursive(pendingPath);
    } catch {
      // preserve original error
    }
    if (error instanceof ContentStoreError) throw error;
    throw new ContentStoreError(
      "io",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
};

const removeDirectoryRecursive = (path: string): void => {
  const info = lstatOrUndefined(path);
  if (info === undefined) return;
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const entry of readdirSync(path)) {
      removeDirectoryRecursive(join(path, entry));
    }
    rmdirSync(path);
    return;
  }
  if (info.isFile() && !info.isSymbolicLink()) {
    unlinkSync(path);
  }
};

/**
 * Prove a snapshot tree contains every object listed in its manifest with
 * matching size (and optionally full hash). Used after backup and for tests
 * of "restored DB + content snapshot has no dangling refs".
 */
export const verifyContentSnapshotCoherence = (
  snapshotPath: string,
  options?: { readonly fullHash?: boolean },
): {
  readonly ok: true;
  readonly objectCount: number;
  readonly totalBytes: number;
} => {
  const manifestPath = join(snapshotPath, "manifest.json");
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as ContentSnapshotManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.objects)) {
    throw new ContentStoreError(
      "corrupt",
      `content snapshot manifest is invalid: ${manifestPath}`,
    );
  }
  let totalBytes = 0;
  for (const obj of manifest.objects) {
    if (!/^[a-f0-9]{64}$/u.test(obj.sha256)) {
      throw new ContentStoreError(
        "corrupt",
        `content snapshot lists invalid digest ${obj.sha256}`,
      );
    }
    const path = join(
      snapshotPath,
      "sha256",
      contentObjectShard(obj.sha256),
      obj.sha256,
    );
    const info = lstatOrUndefined(path);
    if (info === undefined) {
      throw new ContentStoreError(
        "missing",
        `content snapshot missing object ${obj.sha256}`,
      );
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ContentStoreError(
        "corrupt",
        `content snapshot object is not a regular file: ${path}`,
      );
    }
    if (info.size !== obj.byteLength) {
      throw new ContentStoreError(
        "corrupt",
        `content snapshot size mismatch for ${obj.sha256}`,
      );
    }
    if (options?.fullHash) {
      const observed = hashContentObjectFile(path);
      if (
        observed.sha256 !== obj.sha256 ||
        observed.byteLength !== obj.byteLength
      ) {
        throw new ContentStoreError(
          "corrupt",
          `content snapshot hash mismatch for ${obj.sha256}`,
        );
      }
    }
    totalBytes += obj.byteLength;
  }
  if (manifest.objectCount !== manifest.objects.length) {
    throw new ContentStoreError(
      "corrupt",
      "content snapshot objectCount does not match objects length",
    );
  }
  if (manifest.totalBytes !== totalBytes) {
    throw new ContentStoreError(
      "corrupt",
      "content snapshot totalBytes does not match summed objects",
    );
  }
  return {
    ok: true,
    objectCount: manifest.objects.length,
    totalBytes,
  };
};

/**
 * Given a restored SQLite reader + a content snapshot path, prove every
 * content_refs digest is present in the snapshot (no dangling refs).
 */
export const assertRestoredContentCoherent = (
  reader: StateReader,
  snapshotPath: string,
): void => {
  verifyContentSnapshotCoherence(snapshotPath, { fullHash: true });
  const manifest = JSON.parse(
    readFileSync(join(snapshotPath, "manifest.json"), "utf8"),
  ) as ContentSnapshotManifest;
  const snapSet = new Set(manifest.objects.map((o) => o.sha256));
  for (const item of listReferencedContentDigests(reader)) {
    if (!snapSet.has(item.sha256)) {
      throw new ContentStoreError(
        "missing",
        `restored content_refs digest ${item.sha256} is absent from snapshot`,
      );
    }
  }
};

/** SHA-256 of the snapshot manifest file (export receipt helper). */
export const hashContentSnapshotManifest = (manifestPath: string): string => {
  const body = readFileSync(manifestPath);
  return createHash("sha256").update(body).digest("hex");
};

export { contentStoreRoot };
