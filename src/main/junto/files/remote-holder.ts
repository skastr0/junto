import type { FilesRemote } from "./link-client";

/**
 * The window machine's one `FilesRemote`, built where the link channels are
 * bound (`main/index.ts`) and read by the router that picks a node's service
 * by its host (X2). Unset while `filesRemote` is off.
 */
let held: FilesRemote | undefined;

export const holdFilesRemote = (remote: FilesRemote | undefined): void => {
  held = remote;
};

export const heldFilesRemote = (): FilesRemote | undefined => held;
