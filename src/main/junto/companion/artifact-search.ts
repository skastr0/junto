/**
 * The phone's artifact search: the desktop's quick-capture rule, so a word
 * typed on the phone finds what Cmd+T finds, in the same order. Every
 * artifact is ranked by the matcher the artifact palettes use (the title
 * first, then the type, the labels and a document's words), ties broken by the
 * newest change. `tests/companion-artifact-reads.test.ts` holds this to
 * `captureRowsOf` itself.
 */
import type { Artifact, ArtifactBody, ArtifactType } from "@shared/wire/artifact";
import { fuzzyMatch } from "@renderer/lib/fuzzy-match";

/** The type as the desktop names it in a row's quieter line (`TYPE_NOUN`). */
const TYPE_NOUN: { readonly [T in ArtifactType]: string } = {
  link: "Link",
  document: "Document",
  pad: "Pad",
  sheet: "Sheet",
  file: "File",
};

export type SearchableArtifact = {
  readonly artifact: Pick<Artifact, "title" | "type" | "labels" | "updatedAt">;
  readonly body: ArtifactBody | null;
};

/** A document's words, for the matcher; another body, or one not here yet, offers none. */
const bodyWords = (body: ArtifactBody | null): string => (body !== null && body.type === "document" ? body.markdown : "");

const detailOf = (artifact: SearchableArtifact["artifact"]): string => [TYPE_NOUN[artifact.type], ...artifact.labels].join(", ");

/** The artifacts that match `query`, best first; an empty query keeps newest change first. */
export const rankArtifacts = <T extends SearchableArtifact>(items: ReadonlyArray<T>, query: string): ReadonlyArray<T> => {
  const newestFirst = (a: T, b: T): number => b.artifact.updatedAt - a.artifact.updatedAt;
  const q = query.trim().toLowerCase();
  if (q === "") return [...items].sort(newestFirst);
  const scored: Array<{ readonly item: T; readonly score: number }> = [];
  for (const item of items) {
    // The trailing space keeps a whole-title match in the prefix tier, as the command bar does.
    const match = fuzzyMatch(q, {
      identity: [`${item.artifact.title} `],
      metadata: [detailOf(item.artifact), bodyWords(item.body)],
    });
    if (match !== null) scored.push({ item, score: match.score });
  }
  return scored.sort((a, b) => b.score - a.score || newestFirst(a.item, b.item)).map(({ item }) => item);
};
