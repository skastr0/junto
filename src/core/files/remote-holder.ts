import type { FilesRemote } from "./link-client";

/**
 * The core's one `FilesRemote`, built where the link channels are bound
 * (`core.ts`) and read by the files router (`ops/files.ts`), which reaches
 * another machine's node through it (X2). Unset while `filesRemote` is off.
 */
let held: FilesRemote | undefined;

export const holdFilesRemote = (remote: FilesRemote | undefined): void => {
  held = remote;
};

export const heldFilesRemote = (): FilesRemote | undefined => held;
