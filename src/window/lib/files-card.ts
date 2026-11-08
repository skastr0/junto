import type { FileImported, FilesCount, FilesError, FilesResult } from "@shared/files";
import { basenameOf, importNotice } from "./files-drop";

/**
 * Finder files dropped on a Files node's card (0.11, F5, card half): they
 * copy into the node's root through the Files service, never overwriting.
 * What the card says afterwards is one short line, in place of its own for a
 * while, short enough for the card's width; the whole of it is the tooltip.
 */

/** How long the card shows what a drop did. */
export const CARD_DROP_NOTICE_MS = 5000;

export type CardDropNotice = {
  /** What fits on the card. */
  readonly text: string;
  /** All of it, for the tooltip. */
  readonly full: string;
  readonly failed: boolean;
};

/** One file by the name it landed under; several by how many. */
const shortCopied = (sources: ReadonlyArray<string>, landed: ReadonlyArray<string>): string => {
  if (landed.length !== 1) return `Copied ${landed.length} files.`;
  const to = basenameOf(landed[0]!);
  return basenameOf(sources[0] ?? "") === to ? `Copied ${to}.` : `Copied as ${to}.`;
};

/** The line a finished drop leaves on the card; nothing when nothing was dropped. */
export const cardDropNotice = (
  sources: ReadonlyArray<string>,
  outcome: FilesResult<ReadonlyArray<FileImported>> | undefined,
  folder: string,
  describe: (error: FilesError) => string,
): CardDropNotice | undefined => {
  if (sources.length === 0) {
    return { text: "Finder files only.", full: "Only files from Finder can be dropped here.", failed: true };
  }
  if (outcome === undefined) return undefined;
  if (!outcome.ok) {
    return { text: "Nothing was copied.", full: `Nothing was copied into ${folder}. ${describe(outcome.error)}`, failed: true };
  }
  if (outcome.value.length === 0) return undefined;
  const landed = outcome.value.map((entry) => entry.path);
  return { text: shortCopied(sources, landed), full: importNotice(sources, landed, folder), failed: false };
};

/** The card's count of what is under the root: "1 file", "1,204 files", "100,000+ files". None until counted, or when refused. */
export const countLine = (count: FilesResult<FilesCount> | undefined): string | undefined => {
  if (count === undefined || !count.ok) return undefined;
  const { files, capped } = count.value;
  const n = `${files.toLocaleString("en-US")}${capped ? "+" : ""}`;
  return files === 1 && !capped ? "1 file" : `${n} files`;
};
