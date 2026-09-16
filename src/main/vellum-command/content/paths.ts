import { join } from "node:path";
import { resolveVellumCommandHome } from "@shared/vellum-home";

/** Layout generation under `~/.vellum-command/content/`. */
export const CONTENT_LAYOUT_VERSION = "v1" as const;

/** Algorithm directory name for the current content-addressed store. */
export const CONTENT_DIGEST_ALGORITHM = "sha256" as const;

/**
 * Root of the local content store for one Junto installation.
 * Default: `<JUNTO_HOME>/.vellum-command/content/v1`.
 */
export const contentStoreRoot = (home: string = resolveVellumCommandHome()): string =>
  join(home, ".vellum-command", "content", CONTENT_LAYOUT_VERSION);

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
