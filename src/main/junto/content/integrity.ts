/**
 * Startup / recovery integrity for the content store.
 *
 * Referenced digests (content_refs) must have a durable object file whose
 * size and full hash match the manifest. Failures are reported; this module
 * never mutates product state.
 */

import {
  lstatSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import type { StateReader } from "../state/service";
import {
  getContentObject,
  listContentObjectsWithRefCounts,
  listReferencedContentDigests,
} from "./manifest";
import {
  contentDigestRoot,
  contentIncomingDir,
  contentObjectPath,
  contentObjectShard,
} from "./paths";
import {
  ContentStoreError,
  ensureContentLayout,
  hashContentObjectFile,
} from "./store";

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

export type ContentIntegrityFinding =
  | {
      readonly kind: "referenced-missing";
      readonly sha256: string;
      readonly byteLength: number;
    }
  | {
      readonly kind: "referenced-corrupt";
      readonly sha256: string;
      readonly byteLength: number;
      readonly reason: string;
      readonly observedSha256?: string;
      readonly observedByteLength?: number;
    }
  | {
      readonly kind: "orphan-file";
      readonly sha256: string;
      readonly path: string;
      readonly byteLength: number;
    }
  | {
      readonly kind: "orphan-partial";
      readonly path: string;
      readonly byteLength: number;
      readonly mtimeMs: number;
    }
  | {
      readonly kind: "unreferenced-object";
      readonly sha256: string;
      readonly byteLength: number;
      readonly createdAt: string;
    };

export type ContentIntegrityReport = {
  readonly checkedAt: string;
  readonly referencedCount: number;
  readonly verifiedCount: number;
  readonly findings: ReadonlyArray<ContentIntegrityFinding>;
  /** True when every content_refs digest is present and hash-verified. */
  readonly referencedCoherent: boolean;
};

const listPublishedObjectDigests = (root: string): ReadonlyArray<{
  readonly sha256: string;
  readonly path: string;
  readonly byteLength: number;
}> => {
  const digestRoot = contentDigestRoot(root);
  const info = lstatOrUndefined(digestRoot);
  if (info === undefined) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ContentStoreError(
      "symlink",
      `content digest root is not a real directory: ${digestRoot}`,
    );
  }
  const out: Array<{
    sha256: string;
    path: string;
    byteLength: number;
  }> = [];
  for (const shard of readdirSync(digestRoot)) {
    if (!/^[a-f0-9]{2}$/u.test(shard)) continue;
    const shardPath = join(digestRoot, shard);
    const shardInfo = lstatOrUndefined(shardPath);
    if (
      shardInfo === undefined ||
      !shardInfo.isDirectory() ||
      shardInfo.isSymbolicLink()
    ) {
      continue;
    }
    for (const name of readdirSync(shardPath)) {
      if (!/^[a-f0-9]{64}$/u.test(name)) continue;
      if (contentObjectShard(name) !== shard) continue;
      const path = join(shardPath, name);
      const file = lstatOrUndefined(path);
      if (
        file === undefined ||
        !file.isFile() ||
        file.isSymbolicLink()
      ) {
        continue;
      }
      out.push({ sha256: name, path, byteLength: file.size });
    }
  }
  return out;
};

const listPartialFiles = (root: string): ReadonlyArray<{
  readonly path: string;
  readonly byteLength: number;
  readonly mtimeMs: number;
}> => {
  const incoming = contentIncomingDir(root);
  const info = lstatOrUndefined(incoming);
  if (info === undefined) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ContentStoreError(
      "symlink",
      `content incoming is not a real directory: ${incoming}`,
    );
  }
  const out: Array<{ path: string; byteLength: number; mtimeMs: number }> = [];
  for (const name of readdirSync(incoming)) {
    if (!name.endsWith(".partial")) continue;
    const path = join(incoming, name);
    const file = lstatOrUndefined(path);
    if (
      file === undefined ||
      !file.isFile() ||
      file.isSymbolicLink()
    ) {
      continue;
    }
    out.push({
      path,
      byteLength: file.size,
      mtimeMs: file.mtimeMs,
    });
  }
  return out;
};

/**
 * Full integrity pass: re-hash every referenced object, surface orphan files
 * and partials, and list unreferenced manifest objects (GC candidates).
 */
export const runContentIntegrityCheck = (
  root: string,
  reader: StateReader,
  options?: { readonly now?: Date },
): ContentIntegrityReport => {
  ensureContentLayout(root);
  const checkedAt = (options?.now ?? new Date()).toISOString();
  const findings: ContentIntegrityFinding[] = [];
  const referenced = listReferencedContentDigests(reader);
  let verifiedCount = 0;

  for (const item of referenced) {
    const path = contentObjectPath(root, item.sha256);
    const info = lstatOrUndefined(path);
    if (info === undefined) {
      findings.push({
        kind: "referenced-missing",
        sha256: item.sha256,
        byteLength: item.byteLength,
      });
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      findings.push({
        kind: "referenced-corrupt",
        sha256: item.sha256,
        byteLength: item.byteLength,
        reason: "content object path is not a regular file",
      });
      continue;
    }
    if (info.size !== item.byteLength) {
      findings.push({
        kind: "referenced-corrupt",
        sha256: item.sha256,
        byteLength: item.byteLength,
        reason: "content object size does not match manifest",
        observedByteLength: info.size,
      });
      continue;
    }
    try {
      const observed = hashContentObjectFile(path);
      if (
        observed.sha256 !== item.sha256 ||
        observed.byteLength !== item.byteLength
      ) {
        findings.push({
          kind: "referenced-corrupt",
          sha256: item.sha256,
          byteLength: item.byteLength,
          reason: "content object digest or length mismatch",
          observedSha256: observed.sha256,
          observedByteLength: observed.byteLength,
        });
        continue;
      }
      verifiedCount += 1;
    } catch (error) {
      findings.push({
        kind: "referenced-corrupt",
        sha256: item.sha256,
        byteLength: item.byteLength,
        reason:
          error instanceof Error
            ? error.message.slice(0, 1024)
            : "content object could not be verified",
      });
    }
  }

  const published = listPublishedObjectDigests(root);
  const manifestDigests = new Set(
    listContentObjectsWithRefCounts(reader).map((row) => row.sha256),
  );
  for (const file of published) {
    if (!manifestDigests.has(file.sha256)) {
      findings.push({
        kind: "orphan-file",
        sha256: file.sha256,
        path: file.path,
        byteLength: file.byteLength,
      });
    }
  }

  for (const partial of listPartialFiles(root)) {
    findings.push({
      kind: "orphan-partial",
      path: partial.path,
      byteLength: partial.byteLength,
      mtimeMs: partial.mtimeMs,
    });
  }

  for (const row of listContentObjectsWithRefCounts(reader)) {
    if (row.refCount === 0) {
      findings.push({
        kind: "unreferenced-object",
        sha256: row.sha256,
        byteLength: row.byteLength,
        createdAt: row.createdAt,
      });
    }
  }

  // Sanity: every referenced digest should also have a content_objects row.
  for (const item of referenced) {
    if (getContentObject(reader, item.sha256) === undefined) {
      // Already counted as missing if file absent; still flag corrupt if row gone.
      const already = findings.some(
        (f) =>
          (f.kind === "referenced-missing" ||
            f.kind === "referenced-corrupt") &&
          f.sha256 === item.sha256,
      );
      if (!already) {
        findings.push({
          kind: "referenced-corrupt",
          sha256: item.sha256,
          byteLength: item.byteLength,
          reason: "content ref has no content_objects row",
        });
      }
    }
  }

  const referencedCoherent = findings.every(
    (f) =>
      f.kind !== "referenced-missing" && f.kind !== "referenced-corrupt",
  );

  return {
    checkedAt,
    referencedCount: referenced.length,
    verifiedCount,
    findings,
    referencedCoherent,
  };
};

export {
  listPartialFiles as listContentPartialFiles,
  listPublishedObjectDigests as listPublishedContentObjectDigests,
};
