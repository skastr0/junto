/**
 * Quick open (0.11, F4): the one query a node's modal asks of its own list.
 *
 * A palette inside a working modal is not the command bar: it never reaches
 * past the node it was opened in, and every row it offers is a row that node
 * already holds. So a source is small: what the palette is called, where it
 * looks, and how a query is ranked.
 *
 * - Files rank in main, over the index of the node's root (tech's search op):
 *   the renderer gets the top names per keystroke and never sees the index.
 * - Artifacts, tasks and automations rank here with `lib/fuzzy-match`, the
 *   same tier ladder the command bar uses, so a name hit always beats prose.
 *
 * The palette (`components/quick-open`) never ranks anything itself and never
 * knows what a row is: it asks the source and opens what the operator picks.
 */

import { baseName, parentOf, ROOT_PATH, type FilesSearchResult, type FilesResult } from "@shared/files";
import type { NodeId } from "@shared/physics/schema";
import type { FilesSource } from "./files-source";
import { type MatchFields, rankMatches } from "./fuzzy-match";

export type QuickOpenKind = "file" | "artifact" | "task" | "automation";

/** What every row of a kind is called: the palette's one copy of the words. */
export const QUICK_OPEN_WORDS: Readonly<
  Record<QuickOpenKind, { readonly find: string; readonly placeholder: string; readonly empty: string }>
> = {
  file: { find: "Find a file", placeholder: "Search file names", empty: "No file matches." },
  artifact: { find: "Find an artifact", placeholder: "Search artifacts", empty: "No artifact matches." },
  task: { find: "Find a task", placeholder: "Search tasks", empty: "No task matches." },
  automation: { find: "Find an automation", placeholder: "Search automations", empty: "No automation matches." },
};

/** One row to pick: the node's own id for the thing, and what names it. */
export type QuickOpenItem = {
  readonly id: string;
  readonly title: string;
  /** A quieter line under the title: a file's folder, a task's number. */
  readonly detail?: string;
  readonly kind: QuickOpenKind;
};

/**
 * A node's ranked rows. `search` answers a list synchronously when the ranking
 * happens here, or a promise when it happens in main; the palette treats both
 * as one answer and drops an answer the query has moved past.
 */
export type QuickOpenSource = {
  readonly kind: QuickOpenKind;
  /** The palette's name and the header button's: "Find an artifact". */
  readonly find: string;
  readonly placeholder: string;
  /** Said under the field when the query matches nothing. */
  readonly empty: string;
  readonly search: (query: string) => readonly QuickOpenItem[] | Promise<readonly QuickOpenItem[]>;
};

/** As many rows as any source offers: main caps its own list here too. */
export const QUICK_OPEN_LIMIT = 50;

/**
 * A source over items the renderer already holds (artifacts, tasks,
 * automations). The empty query keeps the list's own order, so the palette
 * opens on that list rather than blank.
 */
export const itemsQuickOpen = <T>({
  kind,
  items,
  itemOf,
}: {
  readonly kind: Exclude<QuickOpenKind, "file">;
  readonly items: readonly T[];
  /** The row an item makes, and the fields the query is scored against. */
  readonly itemOf: (item: T) => {
    readonly row: Omit<QuickOpenItem, "kind">;
    readonly match: MatchFields;
  };
}): QuickOpenSource => {
  const entries = items.map(itemOf);
  const words = QUICK_OPEN_WORDS[kind];
  return {
    kind,
    ...words,
    search: (query) =>
      rankMatches(entries, query, (entry) => entry.match)
        .slice(0, QUICK_OPEN_LIMIT)
        .map(({ item }) => ({ ...item.row, kind })),
  };
};

/** Files' one question of main: the Files node's own `search` (`src/shared/files.ts`). */
export type QuickFileSearch = FilesSource["search"];

/**
 * A source over the names of the node's root. Main keeps the index and ranks
 * (a git repository by `git ls-files`, else a walk that skips `.git` and
 * `node_modules`), so the renderer never walks the folder and never sees an
 * absolute path: a row is a path relative to the root.
 *
 * Every keystroke sends a rising `seq`; an answer a newer keystroke replaced
 * says `superseded` and is dropped, so a slow search never paints over a fast
 * one's list.
 */
export const fileQuickOpen = ({
  canvas,
  node,
  search,
}: {
  readonly canvas: string;
  readonly node: NodeId;
  readonly search: QuickFileSearch;
}): QuickOpenSource => {
  let seq = 0;
  return {
    kind: "file",
    ...QUICK_OPEN_WORDS.file,
    search: async (query) => {
      seq += 1;
      const answer: FilesResult<FilesSearchResult> = await search({ canvas, node }, query, seq);
      if (!answer.ok || answer.value.kind === "superseded") return [];
      return answer.value.matches.slice(0, QUICK_OPEN_LIMIT).flatMap((match) => {
        const folder = parentOf(match.path);
        return [
          {
            id: match.path,
            title: baseName(match.path),
            kind: "file" as const,
            ...(folder === ROOT_PATH ? {} : { detail: folder }),
          },
        ];
      });
    },
  };
};
