import type { ArtifactType } from "@shared/artifact";
import type { ArtifactHead } from "@shared/resource-ipc";
import type { NodeId } from "@shared/physics/schema";
import { fuzzyMatch } from "../../lib/fuzzy-match";
import { TYPE_NOUN } from "../artifacts/artifacts-pane-model";

/**
 * Quick capture's list (docs/plans/0.11/11-quick-capture.md, Q1): the rows the
 * left half offers, Inbox first and then what changed most recently, or, with
 * a query, every artifact on the canvas ranked by the matcher the artifact
 * palettes use (title, then the type, the labels and a document's words).
 *
 * A row carries what its lines and its preview need, so neither the list nor
 * the preview reads the source again while the operator arrows through it.
 */
export type CaptureRow = {
  readonly artifactId: string;
  readonly nodeId: NodeId;
  readonly title: string;
  /** The quieter line: the type, then the labels. */
  readonly detail: string;
  readonly type: ArtifactType;
  readonly labels: ReadonlyArray<string>;
  readonly updatedAt: number;
  readonly head: ArtifactHead;
};

/** A document's words, for the matcher; another body has none to offer. */
const bodyWords = (head: ArtifactHead): string => {
  const body = head.body;
  return body !== null && body.type === "document" ? body.markdown : "";
};

const rowOf = (head: ArtifactHead): CaptureRow => {
  const { artifact } = head;
  return {
    artifactId: artifact.artifactId,
    nodeId: artifact.nodeId,
    title: artifact.title,
    detail: [TYPE_NOUN[artifact.type], ...artifact.labels].join(", "),
    type: artifact.type,
    labels: artifact.labels,
    updatedAt: artifact.updatedAt,
    head,
  };
};

const newestFirst = (a: CaptureRow, b: CaptureRow): number => b.updatedAt - a.updatedAt;

/**
 * The rows for the surface's left half. Archived artifacts are not offered:
 * a capture is written, not tidied.
 */
export const captureRowsOf = (
  heads: ReadonlyArray<ArtifactHead>,
  inbox: NodeId | undefined,
  query: string,
): ReadonlyArray<CaptureRow> => {
  const rows = heads.filter(({ artifact }) => !artifact.archived).map(rowOf);
  const q = query.trim().toLowerCase();
  if (q === "") {
    const inInbox: CaptureRow[] = [];
    const elsewhere: CaptureRow[] = [];
    for (const row of rows) (inbox !== undefined && row.nodeId === inbox ? inInbox : elsewhere).push(row);
    return [...inInbox.sort(newestFirst), ...elsewhere.sort(newestFirst)];
  }
  const scored: Array<{ readonly row: CaptureRow; readonly score: number }> = [];
  for (const row of rows) {
    // The trailing space keeps a whole-title match in the prefix tier, as the
    // command bar does, so an exact name does not lose to a longer one.
    const title = `${row.title} `;
    const match = fuzzyMatch(q, {
      identity: [title],
      metadata: [row.detail, bodyWords(row.head)],
    });
    if (match !== null) scored.push({ row, score: match.score });
  }
  return scored.sort((a, b) => b.score - a.score || newestFirst(a.row, b.row)).map(({ row }) => row);
};
