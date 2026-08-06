import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveVellumCommandHome } from "@shared/vellum-home";

/** Layout generation under `~/.vellum-command/content/`. */
export const CONTENT_LAYOUT_VERSION = "v1" as const;

/** Algorithm directory name for the current content-addressed store. */
export const CONTENT_DIGEST_ALGORITHM = "sha256" as const;

const CONTENT_DIRECTORY_MODE = 0o700;

const isMissing = (path: string): boolean => {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return true;
    }
    throw error;
  }
};

const assertRealDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: CONTENT_DIRECTORY_MODE });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`content migration path is not a real directory: ${path}`);
  }
  chmodSync(path, CONTENT_DIRECTORY_MODE);
};

const assertMigrationEntry = (path: string) => {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    throw new Error(`content migration refuses symlink: ${path}`);
  }
  if (!info.isDirectory() && !info.isFile()) {
    throw new Error(`content migration refuses non-regular entry: ${path}`);
  }
  return info;
};

const copyContentTree = (
  source: string,
  target: string,
  copied: { value: boolean },
): void => {
  const sourceInfo = assertMigrationEntry(source);
  if (sourceInfo.isDirectory()) {
    if (isMissing(target)) {
      mkdirSync(target, { mode: CONTENT_DIRECTORY_MODE });
      copied.value = true;
    } else {
      const targetInfo = assertMigrationEntry(target);
      if (!targetInfo.isDirectory()) {
        throw new Error(`content migration target is not a directory: ${target}`);
      }
    }
    chmodSync(target, CONTENT_DIRECTORY_MODE);
    for (const entry of readdirSync(source)) {
      copyContentTree(join(source, entry), join(target, entry), copied);
    }
    return;
  }

  if (!isMissing(target)) {
    const targetInfo = assertMigrationEntry(target);
    if (!targetInfo.isFile() || targetInfo.size !== sourceInfo.size) {
      throw new Error(`content migration target conflicts with immutable object: ${target}`);
    }
    return;
  }

  const staging = `${target}.migration-${process.pid}`;
  if (!isMissing(staging)) {
    throw new Error(`content migration staging file already exists: ${staging}`);
  }
  try {
    copyFileSync(source, staging);
    chmodSync(staging, sourceInfo.mode & 0o777);
    if (!isMissing(target)) {
      throw new Error(`content migration target appeared during copy: ${target}`);
    }
    renameSync(staging, target);
    copied.value = true;
  } catch (error) {
    try {
      unlinkSync(staging);
    } catch {
      // Best-effort cleanup; source and any already-published target remain.
    }
    throw error;
  }
};

/**
 * Root of the local content store for one Vellum Command installation.
 * Default: `<VELLUM_COMMAND_HOME>/.vellum-command/content/v1`.
 */
export const contentStoreRoot = (home: string = resolveVellumCommandHome()): string =>
  join(home, ".vellum-command", "content", CONTENT_LAYOUT_VERSION);

/**
 * Preserve immutable content objects across the runtime-home rename.
 *
 * The old tree remains untouched. A missing target tree is populated through
 * a staging directory; an existing target is merged without overwriting an
 * immutable path. This is limited to the default home migration so injected
 * test roots and explicit transfer roots retain their own lifecycle.
 */
export const migrateLegacyContentStore = (
  home: string = resolveVellumCommandHome(),
): boolean => {
  const legacyRoot = join(home, ".vellum", "content", CONTENT_LAYOUT_VERSION);
  const targetRoot = contentStoreRoot(home);
  if (isMissing(legacyRoot)) return false;
  assertMigrationEntry(legacyRoot);
  assertRealDirectory(dirname(targetRoot));

  const copied = { value: false };
  if (isMissing(targetRoot)) {
    const stagingRoot = `${targetRoot}.migration-${process.pid}`;
    if (!isMissing(stagingRoot)) {
      throw new Error(`content migration staging directory already exists: ${stagingRoot}`);
    }
    try {
      copyContentTree(legacyRoot, stagingRoot, copied);
      if (!isMissing(targetRoot)) {
        throw new Error(`content migration target appeared: ${targetRoot}`);
      }
      renameSync(stagingRoot, targetRoot);
      return copied.value;
    } catch (error) {
      try {
        rmSync(stagingRoot, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; never touch the legacy source.
      }
      throw error;
    }
  }

  assertMigrationEntry(targetRoot);
  copyContentTree(legacyRoot, targetRoot, copied);
  return copied.value;
};

/** Private staging area for in-flight partial writes. */
export const contentIncomingDir = (root: string): string =>
  join(root, "incoming");

/** Content-addressed object tree root. */
export const contentDigestRoot = (root: string): string =>
  join(root, CONTENT_DIGEST_ALGORITHM);

/** Two-hex shard directory for a lower-case SHA-256 digest. */
export const contentObjectShard = (sha256: string): string => {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("content object path requires a lower-case sha256 digest");
  }
  return sha256.slice(0, 2);
};

/**
 * Canonical object path: `…/sha256/<ab>/<full-digest>`.
 * Digest is the entire filename; no extension, no display name.
 */
export const contentObjectPath = (root: string, sha256: string): string =>
  join(contentDigestRoot(root), contentObjectShard(sha256), sha256);

/** Staging path for one exclusive partial write. */
export const contentPartialPath = (root: string, ingestId: string): string => {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(ingestId)) {
    throw new Error("content ingest id is invalid");
  }
  return join(contentIncomingDir(root), `${ingestId}.partial`);
};
