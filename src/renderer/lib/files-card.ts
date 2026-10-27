import type { FileImported, FilesError, FilesResult } from "@shared/files";
import { importNotice } from "./files-drop";

/**
 * Finder files dropped on a Files node's card (0.11, F5, card half): they
 * copy into the node's root through the Files service, never overwriting.
 * What the card says afterwards is one line, in place of its own for a while.
 */

/** How long the card shows what a drop did. */
export const CARD_DROP_NOTICE_MS = 5000;

export type CardDropNotice = { readonly text: string; readonly failed: boolean };

/** The line a finished drop leaves on the card; nothing when nothing was dropped. */
export const cardDropNotice = (
  sources: ReadonlyArray<string>,
  outcome: FilesResult<ReadonlyArray<FileImported>> | undefined,
  folder: string,
  describe: (error: FilesError) => string,
): CardDropNotice | undefined => {
  if (sources.length === 0) return { text: "Only files from Finder can be dropped here.", failed: true };
  if (outcome === undefined) return undefined;
  if (!outcome.ok) return { text: `Nothing was copied into ${folder}. ${describe(outcome.error)}`, failed: true };
  if (outcome.value.length === 0) return undefined;
  return { text: importNotice(sources, outcome.value.map((landed) => landed.path), folder), failed: false };
};
