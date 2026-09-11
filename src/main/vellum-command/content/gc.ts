/**
 * Conservative mark-and-sweep for the local content store.
 *
 * Mark set (never deleted):
 *   - every digest in content_refs
 *   - every digest with a pending/receiving/verifying content_transfers row
 *
 * Sweep candidates (only after grace):
 *   - unreferenced content_objects (+ receipt + file)
 *   - orphan files on disk with no content_objects row
 *   - stale partials not covered by an active transfer
 *
 * GC never deletes content merely because another Station lacks the object.
 */

import {
  lstatSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { basename } from "node:path";
import type { StateReader, StateWriter } from "../state/service";
import {
  deleteUnreferencedContentObject,
  listActiveTransferDigests,
  listContentObjectsWithRefCounts,
  listReferencedContentDigests,
  ContentManifestError,
} from "./manifest";
import { contentObjectPath } from "./paths";
import {
  listContentPartialFiles,
  listPublishedContentObjectDigests,
} from "./integrity";
import { contentTransferPartialId } from "./transfer-local";
import { ContentStoreError, ensureContentLayout } from "./store";

/** Default grace before collecting unreferenced objects (7 days). */
export const DEFAULT_CONTENT_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default grace before collecting stale partials (24 hours). */
export const DEFAULT_CONTENT_PARTIAL_GRACE_MS = 24 * 60 * 60 * 1000;

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

const safeUnlinkOwnedFile = (path: string): void => {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) return;
    unlinkSync(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
};

const parseIsoMs = (value: string): number | undefined => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

export type ContentGcAction =
  | {
      readonly kind: "unreferenced-object";
      readonly sha256: string;
      readonly deletedFile: boolean;
      readonly deletedManifest: boolean;
    }
  | {
      readonly kind: "orphan-file";
      readonly sha256: string;
      readonly path: string;
      readonly deleted: boolean;
    }
  | {
      readonly kind: "stale-partial";
      readonly path: string;
      readonly deleted: boolean;
    }
  | {
      readonly kind: "skipped-protected";
      readonly sha256: string;
      readonly reason: string;
    }
  | {
      readonly kind: "skipped-grace";
      readonly target: string;
      readonly ageMs: number;
      readonly graceMs: number;
    };

export type ContentGcReport = {
  readonly ranAt: string;
  readonly dryRun: boolean;
  readonly protectedDigests: number;
  readonly actions: ReadonlyArray<ContentGcAction>;
};

export type ContentGcOptions = {
  readonly now?: Date;
  readonly dryRun?: boolean;
  readonly orphanGraceMs?: number;
  readonly partialGraceMs?: number;
};

/**
 * Build the protected mark set: referenced digests + active transfers.
 */
export const markProtectedContentDigests = (
  reader: StateReader,
): ReadonlySet<string> => {
  const marked = new Set<string>();
  for (const item of listReferencedContentDigests(reader)) {
    marked.add(item.sha256);
  }
  for (const item of listActiveTransferDigests(reader)) {
    marked.add(item.sha256);
  }
  return marked;
};

/**
 * Mark-and-sweep with grace. Dry-run by default when `dryRun: true`.
 * Live sweep requires an explicit `dryRun: false`.
 */
export const collectContentGarbage = (
  root: string,
  reader: StateReader,
  writer: StateWriter | undefined,
  options: ContentGcOptions = {},
): ContentGcReport => {
  ensureContentLayout(root);
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const dryRun = options.dryRun !== false; // default dry-run unless explicit false
  const orphanGraceMs =
    options.orphanGraceMs ?? DEFAULT_CONTENT_ORPHAN_GRACE_MS;
  const partialGraceMs =
    options.partialGraceMs ?? DEFAULT_CONTENT_PARTIAL_GRACE_MS;
  if (!dryRun && writer === undefined) {
    throw new ContentStoreError(
      "invalid",
      "content GC live sweep requires a StateWriter",
    );
  }

  const protectedDigests = markProtectedContentDigests(reader);
  const actions: ContentGcAction[] = [];

  // 1) Unreferenced manifest objects past grace.
  for (const row of listContentObjectsWithRefCounts(reader)) {
    if (protectedDigests.has(row.sha256)) {
      if (row.refCount === 0) {
        actions.push({
          kind: "skipped-protected",
          sha256: row.sha256,
          reason: "active transfer protects digest",
        });
      }
      continue;
    }
    if (row.refCount > 0) {
      // Should be in protected set; belt-and-suspenders.
      actions.push({
        kind: "skipped-protected",
        sha256: row.sha256,
        reason: "still referenced",
      });
      continue;
    }
    const createdMs = parseIsoMs(row.createdAt) ?? parseIsoMs(row.verifiedAt);
    if (createdMs === undefined) {
      actions.push({
        kind: "skipped-grace",
        target: row.sha256,
        ageMs: 0,
        graceMs: orphanGraceMs,
      });
      continue;
    }
    const ageMs = nowMs - createdMs;
    if (ageMs < orphanGraceMs) {
      actions.push({
        kind: "skipped-grace",
        target: row.sha256,
        ageMs,
        graceMs: orphanGraceMs,
      });
      continue;
    }

    const path = contentObjectPath(root, row.sha256);
    let deletedFile = false;
    let deletedManifest = false;
    if (!dryRun && writer !== undefined) {
      // File first → crash leaves no dangling ref (row may remain briefly as
      // integrity "missing" but unreferenced). Then drop manifest rows.
      const before = lstatOrUndefined(path);
      if (before !== undefined) {
        safeUnlinkOwnedFile(path);
        deletedFile = true;
      }
      try {
        const result = deleteUnreferencedContentObject(writer, row.sha256);
        deletedManifest = result.deleted;
      } catch (error) {
        if (
          error instanceof ContentManifestError &&
          error.code === "conflict"
        ) {
          actions.push({
            kind: "skipped-protected",
            sha256: row.sha256,
            reason: error.message,
          });
          continue;
        }
        throw error;
      }
    }
    actions.push({
      kind: "unreferenced-object",
      sha256: row.sha256,
      deletedFile: dryRun ? false : deletedFile,
      deletedManifest: dryRun ? false : deletedManifest,
    });
  }

  // 2) Orphan files on disk with no content_objects row.
  const manifestObjects = new Set(
    listContentObjectsWithRefCounts(reader).map((row) => row.sha256),
  );
  // After deletes, re-list would be ideal; for dry-run the pre-delete set is fine.
  // Live: writer already removed rows; re-query via reader is same connection mid-tx.
  for (const file of listPublishedContentObjectDigests(root)) {
    if (manifestObjects.has(file.sha256) || protectedDigests.has(file.sha256)) {
      continue;
    }
    const info = lstatOrUndefined(file.path);
    if (info === undefined) continue;
    const ageMs = nowMs - info.mtimeMs;
    if (ageMs < orphanGraceMs) {
      actions.push({
        kind: "skipped-grace",
        target: file.path,
        ageMs,
        graceMs: orphanGraceMs,
      });
      continue;
    }
    let deleted = false;
    if (!dryRun) {
      safeUnlinkOwnedFile(file.path);
      deleted = true;
    }
    actions.push({
      kind: "orphan-file",
      sha256: file.sha256,
      path: file.path,
      deleted: dryRun ? false : deleted,
    });
  }

  // 3) Stale partials not covered by an active transfer digest.
  const activePartialNames = new Set<string>();
  for (const digest of protectedDigests) {
    try {
      activePartialNames.add(`${contentTransferPartialId(digest)}.partial`);
    } catch {
      // invalid digest already filtered by schema
    }
  }
  // Also protect any xfer_* partial whose digest is protected.
  for (const partial of listContentPartialFiles(root)) {
    const name = basename(partial.path);
    if (activePartialNames.has(name)) {
      continue;
    }
    // Non-transfer partials (random ingest ids) and inactive xfer partials.
    const ageMs = nowMs - partial.mtimeMs;
    if (ageMs < partialGraceMs) {
      actions.push({
        kind: "skipped-grace",
        target: partial.path,
        ageMs,
        graceMs: partialGraceMs,
      });
      continue;
    }
    let deleted = false;
    if (!dryRun) {
      safeUnlinkOwnedFile(partial.path);
      deleted = true;
    }
    actions.push({
      kind: "stale-partial",
      path: partial.path,
      deleted: dryRun ? false : deleted,
    });
  }

  return {
    ranAt: now.toISOString(),
    dryRun,
    protectedDigests: protectedDigests.size,
    actions,
  };
};
