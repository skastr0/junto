/**
 * The `[[` list's pure part (plan 0.11, 02), shared by every host that
 * offers it: a document (`artifacts/mention-picker.tsx`), a pad's text box
 * and a sheet's cell, each drawing these rows in its own list. `[[` and what
 * follows it is the query; the rows are the artifacts in reach whose title
 * matches, then, when no title is exactly what was typed, a row that creates
 * a document by that title. The host does the create and then writes the
 * link (`artifactLink`, `@shared/artifact-link`): nothing here creates.
 */
import { ARTIFACT_MAX_TITLE_LENGTH } from "@shared/artifact";
import { mentionKey, type MentionOf } from "@shared/mention";
import type { ArtifactType } from "./resource-visuals";

/** An artifact a `[[` may link to: what it is, its title now, and the node it sits in. */
export type LinkableArtifact = {
  readonly ref: MentionOf<"artifact">;
  readonly title: string;
  readonly type: ArtifactType;
  /** The Artifacts node's title, said beside an artifact from a node other than the host's. */
  readonly place?: string;
};

/** A row of the `[[` list: an artifact to link, or a document to create by the typed title. */
export type LinkCandidate =
  | { readonly kind: "artifact"; readonly artifact: LinkableArtifact }
  | { readonly kind: "create"; readonly title: string };

/** A `[[` being typed just before the caret: where the brackets start and what follows them. */
export type LinkQuery = { readonly start: number; readonly query: string };

/** `[[` and then anything but a bracket or a line break, up to the caret. */
const QUERY = /\[\[([^[\]\n]*)$/u;

/** The `[[` query in the text before the caret, if one is being typed. */
export const linkQueryAt = (before: string): LinkQuery | undefined => {
  const match = QUERY.exec(before);
  if (!match) return undefined;
  // An escaped bracket is text, not a link.
  if (match.index > 0 && before[match.index - 1] === "\\") return undefined;
  return { start: match.index, query: match[1] ?? "" };
};

export const linkCandidateKey = (candidate: LinkCandidate): string =>
  candidate.kind === "artifact" ? mentionKey(candidate.artifact.ref) : `create:${candidate.title}`;

/** The title a create row would make from a query: one line, trimmed, or nothing worth making. */
const createdTitle = (query: string): string | undefined => {
  const title = query.replace(/\s+/g, " ").trim();
  return title === "" || title.length > ARTIFACT_MAX_TITLE_LENGTH ? undefined : title;
};

/**
 * The rows for a query: artifacts whose title starts with what was typed,
 * then those that contain it, each in the order given; then the create row,
 * unless a title is exactly the typed one (case aside).
 */
export const artifactLinkCandidates = (artifacts: ReadonlyArray<LinkableArtifact>, query: string): ReadonlyArray<LinkCandidate> => {
  const typed = query.trim().toLowerCase();
  const title = (artifact: LinkableArtifact): string => artifact.title.toLowerCase();
  const starts = artifacts.filter((artifact) => title(artifact).startsWith(typed));
  const contains = artifacts.filter((artifact) => !starts.includes(artifact) && title(artifact).includes(typed));
  const rows: LinkCandidate[] = [...starts, ...contains].map((artifact) => ({ kind: "artifact", artifact }));
  const created = createdTitle(query);
  if (created !== undefined && !artifacts.some((artifact) => title(artifact) === created.toLowerCase())) {
    rows.push({ kind: "create", title: created });
  }
  return rows;
};

/** What a row says: the artifact's title, or "Create document <title>". */
export const linkCandidateLabel = (candidate: LinkCandidate): string =>
  candidate.kind === "artifact" ? candidate.artifact.title : `Create document ${candidate.title}`;
